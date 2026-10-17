import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { TorrentSearchAdapter } from "../adapters/torrentsearch.js";
import type { ProwlarrAdapter } from "../adapters/prowlarr.js";
import { WebSearchAdapter } from "../adapters/websearch.js";
import type { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import type { ArrAdapter } from "../adapters/arr.js";
import { posix } from "node:path";
import { logActivity } from "../lib/activity.js";
import type { AppContext } from "../lib/context.js";
import { driveFor, getDriveSettings } from "../config/drives.js";

/**
 * Search is one route family with a `source` discriminator:
 *  - `prowlarr` — the primary backend; every indexer you run, already aggregated;
 *  - `site`     — the configuration-driven scraper, kept as a documented fallback
 *                 (public mirrors rot and Cloudflare frequently wins);
 *  - `web`      — the open-web widget, which needs no configuration at all.
 * Sources are never hidden when unavailable: /api/search/sources reports *why*.
 */

// *arr categories whose grabs TorHQ nudges to import once the download lands.
const ARR_CATEGORY = { radarr: "radarr", sonarr: "sonarr", lidarr: "lidarr" } as const;

const SOURCES = ["prowlarr", "site", "web"] as const;

/** Comma-separated integer ids from a query string ("1,2,3"). */
const IdList = z.string().max(256).transform((raw, ctx) => {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const ids = parts.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n < 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a comma-separated list of ids" });
    return z.NEVER;
  }
  return ids;
});

const SearchQuery = z.object({
  source: z.enum(SOURCES).default("prowlarr"),
  q: z.string().min(1).max(256),
  // site only
  page: z.coerce.number().int().min(1).max(20).optional(),
  // prowlarr only
  indexerIds: IdList.optional(),
  categories: IdList.optional(),
  limit: z.coerce.number().int().min(10).max(500).optional(),
});

// Where a grab may be tagged. `torhq-manual` = a raw grab TorHQ owns;
// `torhq-games` = the same, kept apart because no *arr exists for games; the *arr
// categories let the corresponding *arr adopt and import the download. A fixed
// allowlist keeps arbitrary category strings out of qBittorrent.
const GRAB_CATEGORIES = ["torhq-manual", "torhq-games", "radarr", "sonarr", "lidarr"] as const;
/** Who should end up owning the download. */
const GRAB_TARGETS = ["qbittorrent", "games", "radarr", "sonarr", "lidarr"] as const;

/**
 * A release title as an indexer reported it. Used only to label the activity
 * log, so it is normalised rather than validated: some indexers return
 * multi-line titles hundreds of characters long, and rejecting the grab over a
 * cosmetic field would fail a request that is otherwise perfectly valid -- with
 * an error naming a limit the user did not choose and cannot influence.
 */
const ReleaseLabel = z.string().max(8192)
  .transform((s) => s.replace(/\s+/g, " ").trim().slice(0, 512))
  .optional();

const GrabBody = z.object({
  source: z.enum(["prowlarr", "site"]).default("site"),
  // Only well-formed magnet links — never an arbitrary URL handed to qBittorrent.
  magnet: z.string().regex(/^magnet:\?.*xt=urn:btih:[A-Za-z0-9]{32,40}(&|$)/i, "not a valid magnet link").max(4096).optional(),
  // Prowlarr releases: the guid + indexerId identify the release; downloadUrl is
  // the (key-stripped) proxy link from the search result, re-signed and origin-
  // checked by the adapter before it reaches qBittorrent.
  guid: z.string().min(1).max(2048).optional(),
  indexerId: z.coerce.number().int().nonnegative().optional(),
  downloadUrl: z.string().url().max(2048).optional(),
  title: ReleaseLabel,
  target: z.enum(GRAB_TARGETS).optional(),
  /** Legacy alias for `target`, expressed as the qBittorrent category. */
  category: z.enum(GRAB_CATEGORIES).optional(),
  /**
   * The drive a raw qBittorrent grab saves to. Omitted, the downloads default
   * from Settings applies. Ignored for an *arr target, whose own root folder
   * decides where the file ends up.
   */
  drive: z.string().min(1).max(32).optional(),
}).superRefine((b, ctx) => {
  if (b.source === "site" && !b.magnet) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["magnet"], message: "a magnet link is required for site grabs" });
  }
  if (b.source === "prowlarr" && (!b.guid || b.indexerId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["guid"], message: "guid and indexerId are required for prowlarr grabs" });
  }
});

type GrabTarget = (typeof GRAB_TARGETS)[number];

/** `target` wins; `category` is the pre-multi-source spelling of the same thing. */
function resolveTarget(body: z.infer<typeof GrabBody>): GrabTarget {
  if (body.target) return body.target;
  if (body.category === "torhq-manual") return "qbittorrent";
  if (body.category === "torhq-games") return "games";
  return body.category ?? "qbittorrent";
}

/** The qBittorrent category a target implies. */
function categoryFor(target: GrabTarget): string {
  if (target === "qbittorrent") return "torhq-manual";
  if (target === "games") return "torhq-games";
  return target;
}

/** Targets an *arr adopts. The rest are raw downloads TorHQ adds to qBittorrent itself. */
function isArrTarget(target: GrabTarget): target is keyof typeof ARR_CATEGORY {
  return target in ARR_CATEGORY;
}

/**
 * Where a raw grab saves: the chosen drive's download folder, else the
 * downloads default's, under a folder named for the category, so a grab to the
 * 1TB lands in `<1TB downloads>/torhq-manual`. With no drive chosen and no
 * usable default it is left to the category's own save path.
 */
function rawPlacement(driveId: string | undefined, category: string): { savePath?: string; drive?: string } | { error: string } {
  const s = getDriveSettings();
  const drive = driveId ? s.drives.find((d) => d.id === driveId) : driveFor("downloads", s);
  if (driveId && !drive) return { error: `no drive "${driveId}" is configured` };
  if (!drive) return {};
  if (!drive.downloadPath) {
    return driveId ? { error: `${drive.label} has no download folder set in Settings` } : {};
  }
  return { savePath: posix.join(drive.downloadPath, category), drive: drive.label };
}

/** Probes must not hang the sources page — a slow mirror is an unavailable one. */
const PROBE_TIMEOUT_MS = 8000;
async function withTimeout<T>(work: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function searchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  const prowlarr = () => getAdapter("prowlarr", ctx.masterKey) as ProwlarrAdapter | null;
  const site = () => getAdapter("torrentsearch", ctx.masterKey) as TorrentSearchAdapter | null;
  const qbittorrent = () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
  // The web widget's default provider needs no backend and no credentials, so
  // it works even when the service was never configured.
  const web = () =>
    (getAdapter("websearch", ctx.masterKey) as WebSearchAdapter | null)
    ?? new WebSearchAdapter({ baseUrl: "", secret: "" });

  /**
   * Which sources can be searched right now, and why not when they can't. The
   * UI renders an unavailable source disabled with `detail` as the reason
   * rather than hiding it.
   */
  app.get("/api/search/sources", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const probe = async (
      id: string, label: string, work: () => Promise<{ available: boolean; detail: string }>,
      timeoutMs?: number,
    ) => {
      try {
        return { id, label, ...(await withTimeout(work(), timeoutMs)) };
      } catch (e) {
        return { id, label, available: false, detail: (e as Error).message };
      }
    };

    const sources = await Promise.all([
      probe("prowlarr", "Prowlarr", async () => {
        const p = prowlarr();
        if (!p) return { available: false, detail: "not configured" };
        const indexers = await p.indexers();
        const enabled = indexers.filter((i) => i.enable).length;
        return enabled > 0
          ? { available: true, detail: `${enabled} indexer${enabled === 1 ? "" : "s"}` }
          : { available: false, detail: "no enabled indexers" };
      }),
      probe("site", "Torrent site", async () => {
        const s = site();
        if (!s) return { available: false, detail: "not configured" };
        const h = await s.health();
        return { available: h.healthy, detail: h.detail ?? (h.healthy ? "reachable" : "unreachable") };
      }),
      probe("web", "Web", async () => {
        const w = web();
        const h = await w.health();
        // Always available: a failing provider degrades to links, it never dies.
        return {
          available: true,
          detail: h.healthy ? (h.detail ?? w.provider) : `${w.provider} unavailable (${h.detail}) — links only`,
        };
      }),
    ]);
    return { sources };
  });

  // Indexer list (with categories) for the Prowlarr search filters.
  app.get("/api/search/indexers", { preHandler: [app.requireAuth, app.requireAdmin] }, async (_req, reply) => {
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    try {
      return { indexers: await p.indexers() };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Search one source. Read-only, so auth-only (no CSRF). The query is parsed
  // before any adapter lookup so a bad query is a 400, not a 409.
  app.get("/api/search", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req, reply) => {
    const query = SearchQuery.parse(req.query);

    if (query.source === "web") {
      // No 409 branch: the link provider is zero-config and always works.
      return { source: "web", ...(await web().search(query.q)) };
    }

    if (query.source === "site") {
      const s = site();
      if (!s) return reply.code(409).send({ error: "torrent search is not configured" });
      try {
        const results = await s.search(query.q, query.page ?? 1);
        // Strongest-seeded first — the useful default ordering for grabbing.
        results.sort((x, y) => (y.seeders ?? 0) - (x.seeders ?? 0));
        return { source: "site", results };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    }

    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    try {
      const results = await p.search(query.q, {
        indexerIds: query.indexerIds,
        categories: query.categories,
        limit: query.limit,
      });
      return { source: "prowlarr", results };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /**
   * Grab a chosen release. Routing, in order of preference:
   *  1. prowlarr + an *arr target → Prowlarr hands the release to its download
   *     client, then that *arr is nudged so it adopts and imports it;
   *  2. prowlarr + qbittorrent    → the release's own magnet/download URL is
   *     added under `torhq-manual`, which TorHQ owns;
   *  3. site                      → magnet straight to qBittorrent under the
   *     target's category, then the *arr import nudge (existing behaviour).
   */
  app.post("/api/search/grab", guard, async (req, reply) => {
    const body = GrabBody.parse(req.body);
    const target = resolveTarget(body);
    const category = categoryFor(target);

    // Best-effort: ask the *arr to poll its download client now so it identifies
    // and imports the download. It still owns the import; this never fails the grab.
    const nudgeArr = async (name: string): Promise<boolean> => {
      if (!(name in ARR_CATEGORY)) return false;
      const arr = getAdapter(name, ctx.masterKey) as ArrAdapter | null;
      if (!arr) return false;
      try {
        await arr.processDownloads();
        return true;
      } catch (e) {
        req.log.warn({ err: e, category: name }, "arr import trigger failed");
        return false;
      }
    };

    const placement = isArrTarget(target) ? {} : rawPlacement(body.drive, category);
    if ("error" in placement) return reply.code(400).send({ error: placement.error });

    const finish = (via: "prowlarr" | "qbittorrent", importTriggered: boolean, detail: string) => {
      const where = placement.drive ? ` on ${placement.drive}` : "";
      logActivity({
        kind: "queued",
        service: via,
        message: `Sent "${body.title ?? "release"}" to ${detail}${where}`
          + (importTriggered ? ` and triggered ${category} import` : ""),
        data: { source: body.source, via, category, importTriggered, savePath: placement.savePath },
      });
      return { ok: true, via, category, importTriggered, drive: placement.drive, savePath: placement.savePath };
    };

    if (body.source === "prowlarr") {
      const p = prowlarr();
      if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });

      // 1. An *arr target: let Prowlarr push the release so the *arr owns the
      //    download end to end, then nudge that *arr to look for it.
      if (isArrTarget(target)) {
        try {
          await p.grab(body.guid!, body.indexerId!);
          return finish("prowlarr", await nudgeArr(target), `Prowlarr (${target})`);
        } catch (e) {
          return reply.code(502).send({ error: (e as Error).message });
        }
      }

      // 2. qBittorrent or games target: resolve the release to a URL TorHQ can
      //    add itself.
      const qb = qbittorrent();
      if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });
      let url: string;
      try {
        if (body.magnet) url = body.magnet;
        else if (body.downloadUrl) url = p.signDownloadUrl(body.downloadUrl, body.indexerId!);
        else throw new Error("this release has no magnet or download URL — grab it to an *arr instead");
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message }); // caller sent an unusable release
      }
      try {
        await qb.addTorrent({ url, category, savePath: placement.savePath });
        return finish("qbittorrent", false, `qBittorrent (${category})`);
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    }

    // 3. site: the scraped magnet goes straight to qBittorrent.
    const qb = qbittorrent();
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });
    try {
      await qb.addTorrent({ url: body.magnet!, category, savePath: placement.savePath });
      return finish("qbittorrent", await nudgeArr(category), `qBittorrent (${category})`);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
