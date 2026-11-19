import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import type { ArrAdapter, ArrFlavor, ArrQueueItem } from "../adapters/arr.js";
import { logActivity } from "../lib/activity.js";
import type { AppContext } from "../lib/context.js";

/**
 * Download-client control and the unified *arr queue — the two halves of one
 * pipeline. `/api/downloads` is what qBittorrent is doing; `/api/queue` is what
 * the *arr think is happening to those same downloads, which is where a failed
 * import actually shows up.
 *
 * Control ends at the download client: TorHQ pauses, re-tags and deletes
 * torrents, but never moves, renames or deletes media an *arr has imported.
 */
export const ARR_SERVICES = ["radarr", "sonarr", "lidarr"] as const;

/**
 * A qBittorrent info-hash: SHA-1 (v1) or SHA-256 (v2), hex. Validated before it
 * ever reaches the client so no arbitrary string can be spliced into the
 * `|`-separated hash list a batch action sends.
 */
const HASH_RE = /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/;

/** Fixed action allowlist — anything else is a 400, never a passthrough. */
const ACTIONS = [
  "pause", "resume", "recheck", "delete", "deleteWithFiles",
  "topPriority", "bottomPriority", "setCategory",
] as const;
type Action = (typeof ACTIONS)[number];

/** Categories TorHQ itself creates; others must already exist in qBittorrent. */
const KNOWN_CATEGORIES = ["torhq-manual", "torhq-games", ...ARR_SERVICES] as const;

const ActionBody = z.object({
  hashes: z.array(z.string().regex(HASH_RE, "not a valid torrent hash")).min(1).max(200),
  action: z.enum(ACTIONS),
  category: z.string().min(1).max(64).optional(),
});

const RemoveBody = z.object({
  removeFromClient: z.boolean().default(false),
  blocklist: z.boolean().default(false),
});

const RemoveParams = z.object({
  service: z.enum(ARR_SERVICES),
  id: z.coerce.number().int().positive(),
});

export function downloadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };
  const qbAdapter = () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
  const arrAdapter = (kind: ArrFlavor) => getAdapter(kind, ctx.masterKey) as ArrAdapter | null;

  // Everything qBittorrent is holding, plus the transfer totals and the category
  // map the UI needs to offer a re-tag.
  // A member gets the speed totals only (the layout shows them): torrents carry
  // server paths, so they stay admin-side.
  app.get("/api/downloads", { preHandler: app.requireAuth }, async (req, reply) => {
    const qb = qbAdapter();
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });
    try {
      const isAdmin = req.session!.role === "admin";
      if (!isAdmin) {
        const t = await qb.transferInfo();
        return {
          torrents: [],
          transfer: { dlspeed: t.dl_info_speed, upspeed: t.up_info_speed },
          categories: {},
        };
      }
      const [torrents, transfer, categories] = await Promise.all([
        qb.torrents(), qb.transferInfo(), qb.categories(),
      ]);
      return {
        torrents,
        transfer: { dlspeed: transfer.dl_info_speed, upspeed: transfer.up_info_speed },
        categories,
      };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Batch control over torrents the user selected.
  app.post("/api/downloads/action", guard, async (req, reply) => {
    const qb = qbAdapter();
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });
    const body = ActionBody.parse(req.body);

    try {
      if (body.action === "setCategory") {
        if (!body.category) {
          return reply.code(400).send({ error: "category is required for setCategory" });
        }
        // Allowlisted names, or any category qBittorrent already has — never an
        // arbitrary string, which would silently create one client-side.
        const existing = await qb.categories();
        if (!KNOWN_CATEGORIES.includes(body.category as never) && !(body.category in existing)) {
          return reply.code(400).send({ error: `unknown category "${body.category}"` });
        }
      }

      if (body.action === "deleteWithFiles") {
        // Named before the deletion, while the torrents still exist. Best-effort:
        // the audit entry must never be the reason the action fails.
        const names = await torrentNames(qb, body.hashes);
        await qb.deleteWithFiles(body.hashes);
        logActivity({
          kind: "info",
          service: "qbittorrent",
          message: `Deleted ${body.hashes.length} torrent(s) AND their downloaded files: ${names.join(", ")}`,
          data: { action: body.action, hashes: body.hashes, names },
        });
        return { ok: true, action: body.action, count: body.hashes.length };
      }

      await applyAction(qb, body.action, body.hashes, body.category);
      return { ok: true, action: body.action, count: body.hashes.length };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // The *arr side of the same downloads, merged. A service that is missing or
  // down degrades into `unavailable` — it never fails the whole response, because
  // a broken Lidarr must not hide what Radarr is doing.
  app.get("/api/queue", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const items: ArrQueueItem[] = [];
    const unavailable: Array<{ service: ArrFlavor; detail: string }> = [];
    await Promise.all(ARR_SERVICES.map(async (service) => {
      const arr = arrAdapter(service);
      if (!arr) { unavailable.push({ service, detail: "not configured" }); return; }
      try {
        items.push(...await arr.queue());
      } catch (e) {
        unavailable.push({ service, detail: (e as Error).message });
      }
    }));
    // Stable ordering across polls: grouped by service, then by the *arr's own id.
    items.sort((a, b) => a.service.localeCompare(b.service) || a.id - b.id);
    unavailable.sort((a, b) => a.service.localeCompare(b.service));
    return { items, unavailable };
  });

  // Ask every configured *arr to poll its download client now.
  app.post("/api/queue/refresh", guard, async () => {
    const refreshed: ArrFlavor[] = [];
    const unavailable: Array<{ service: ArrFlavor; detail: string }> = [];
    await Promise.all(ARR_SERVICES.map(async (service) => {
      const arr = arrAdapter(service);
      if (!arr) { unavailable.push({ service, detail: "not configured" }); return; }
      try {
        await arr.processDownloads();
        refreshed.push(service);
      } catch (e) {
        unavailable.push({ service, detail: (e as Error).message });
      }
    }));
    refreshed.sort();
    unavailable.sort((a, b) => a.service.localeCompare(b.service));
    return { refreshed, unavailable };
  });

  // Drop one record from an *arr's queue. Both switches are the user's explicit
  // choice and both are recorded.
  app.post("/api/queue/:service/:id/remove", guard, async (req, reply) => {
    const { service, id } = RemoveParams.parse(req.params);
    const body = RemoveBody.parse(req.body ?? {});
    const arr = arrAdapter(service);
    if (!arr) return reply.code(409).send({ error: `${service} is not configured` });
    try {
      await arr.removeFromQueue(id, body);
      logActivity({
        kind: "info",
        service,
        message: `Removed queue item ${id} from ${service}`
          + (body.removeFromClient ? " and from the download client" : "")
          + (body.blocklist ? " (release blocklisted)" : ""),
        data: { id, ...body },
      });
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}

/** Dispatch an allowlisted action to the adapter's matching method. */
async function applyAction(
  qb: QbittorrentAdapter, action: Exclude<Action, "deleteWithFiles">, hashes: string[], category?: string,
): Promise<void> {
  switch (action) {
    case "pause": return qb.pause(hashes);
    case "resume": return qb.resume(hashes);
    case "recheck": return qb.recheck(hashes);
    case "delete": return qb.delete(hashes);
    case "topPriority": return qb.topPriority(hashes);
    case "bottomPriority": return qb.bottomPriority(hashes);
    case "setCategory": return qb.setCategory(hashes, category!);
  }
}

/** Human-readable names for an audit entry; falls back to the hashes. */
async function torrentNames(qb: QbittorrentAdapter, hashes: string[]): Promise<string[]> {
  try {
    const wanted = new Set(hashes.map((h) => h.toLowerCase()));
    const matched = (await qb.torrents())
      .filter((t) => wanted.has(t.hash.toLowerCase()))
      .map((t) => t.name);
    return matched.length ? matched : hashes;
  } catch {
    return hashes;
  }
}
