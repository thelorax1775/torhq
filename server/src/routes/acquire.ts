import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import { HttpError } from "../adapters/http.js";
import type { ArrAdapter, ArrCandidateWithService, ArrFlavor } from "../adapters/arr.js";
import { getServiceDecrypted, upsertService } from "../config/store.js";
import {
  ARR_PURPOSE, defaultRootFor, driveOf, driveRefs, getDriveSettings, saveDriveSettings, withDrives,
} from "../config/drives.js";
import { logActivity } from "../lib/activity.js";
import { getSearch, startSearch, viewOf } from "../lib/releaseSearch.js";
import type { AppContext } from "../lib/context.js";
import { ARR_SERVICES } from "./downloads.js";

/**
 * Acquire — the one-stop loop, and the join the rest of TorHQ was missing.
 *
 * The Search page can put a torrent into qBittorrent under an *arr's category,
 * but an *arr will not import a download for something that is not in its
 * library: it files it as "Unknown" and nothing ever renames or places it.
 * Requests could add a title to an *arr but never showed you the releases.
 *
 * This route family runs them in the only order that actually works:
 *
 *   lookup -> prepare (add to the *arr) -> search (the *arr's OWN interactive
 *   search) -> grab (the *arr grabs into its own queue)
 *
 * After `grab` the *arr owns everything: the download client, the tracking, the
 * import, the rename, and the final folder. TorHQ never touches the file, and
 * never needs to — which is precisely why the content ends up in the right
 * place instead of rotting in a download directory.
 */

const Service = z.enum(ARR_SERVICES);

const LookupQuery = z.object({ q: z.string().min(1).max(256) });

const PrepareBody = z.object({
  service: Service,
  /**
   * The term the candidate came from. The lookup is re-run server-side and
   * matched on `selectionId`, so what gets added is the candidate the user
   * chose — never "the first hit".
   */
  term: z.string().min(1).max(256),
  selectionId: z.string().min(1).max(128),
  // Optional per-grab overrides of the saved defaults.
  rootFolderPath: z.string().min(1).max(512).optional(),
  qualityProfileId: z.number().int().positive().optional(),
  metadataProfileId: z.number().int().positive().optional(),
  /** Persist these choices as this *arr's defaults for next time. */
  remember: z.boolean().optional(),
});

const SearchBody = z.object({
  service: Service,
  id: z.number().int().positive(),
  label: z.string().max(256).optional(),
  seasonNumber: z.number().int().min(0).max(999).optional(),
  albumId: z.number().int().positive().optional(),
});

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
  service: Service,
  guid: z.string().min(1).max(4096),
  indexerId: z.number().int().nonnegative(),
  title: ReleaseLabel,
  /**
   * Set when the release was one the *arr's profile rejected — a deliberate
   * override, recorded as such in the activity log.
   */
  override: z.boolean().optional(),
});

const DefaultsBody = z.object({
  service: Service,
  rootFolderPath: z.string().min(1).max(512).optional(),
  qualityProfileId: z.number().int().positive().optional(),
  metadataProfileId: z.number().int().positive().optional(),
});

const TargetsQuery = z.object({ service: Service, id: z.coerce.number().int().positive() });

/** Saved placement defaults for one *arr. */
interface ArrDefaults {
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
}

/**
 * An *arr answers a bad request with a JSON body carrying the real reason —
 * "Movie with ID 1 does not exist", "This release is not available". The
 * HttpError message is only "HTTP 500 for <url>", which tells the user nothing,
 * so dig the *arr's own words out whenever there are any.
 */
export function arrMessage(e: unknown): string {
  if (e instanceof HttpError && e.body) {
    try {
      const parsed = JSON.parse(e.body) as { message?: string; errorMessage?: string };
      const msg = parsed.message ?? parsed.errorMessage;
      if (msg) return msg;
    } catch {
      // Not JSON. The raw body still beats the status line, but only when it is
      // short enough to be a message rather than an HTML error page.
      if (e.body.length < 200 && !e.body.trimStart().startsWith("<")) return e.body;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export function acquireRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };
  const arr = (kind: ArrFlavor) => getAdapter(kind, ctx.masterKey) as ArrAdapter | null;

  /** Read one *arr's saved placement defaults. */
  function defaultsOf(service: ArrFlavor): ArrDefaults {
    const svc = getServiceDecrypted(service, ctx.masterKey);
    const extra = (svc?.extra ?? {}) as Record<string, unknown>;
    return {
      rootFolderPath: typeof extra.rootFolderPath === "string" ? extra.rootFolderPath : undefined,
      qualityProfileId: typeof extra.qualityProfileId === "number" ? extra.qualityProfileId : undefined,
      metadataProfileId: typeof extra.metadataProfileId === "number" ? extra.metadataProfileId : undefined,
    };
  }

  /** Persist defaults without disturbing the service's URL or its secret. */
  function saveDefaults(service: ArrFlavor, next: ArrDefaults): void {
    const svc = getServiceDecrypted(service, ctx.masterKey);
    if (!svc) throw new Error(`${service} is not configured`);
    upsertService(
      {
        kind: service,
        label: svc.label,
        baseUrl: svc.baseUrl,
        enabled: svc.enabled,
        // `secret` omitted on purpose: upsertService keeps the stored one.
        extra: { ...svc.extra, ...next },
      },
      ctx.masterKey,
    );
  }

  /**
   * Save a placement as this *arr's default. A root folder on a known drive is
   * remembered as that drive, the default Settings shows for this kind of
   * content, and any root saved per *arr before drives existed is dropped so
   * the two cannot disagree. A root on no known drive is kept per *arr.
   */
  function rememberPlacement(service: ArrFlavor, next: ArrDefaults): void {
    const s = getDriveSettings();
    const drive = next.rootFolderPath ? driveOf(next.rootFolderPath, s.drives) : undefined;
    if (drive) {
      saveDriveSettings({ ...s, defaults: { ...s.defaults, [ARR_PURPOSE[service]]: drive.id } });
      saveDefaults(service, { ...next, rootFolderPath: undefined });
    } else {
      saveDefaults(service, next);
    }
  }

  /**
   * One search box over all three *arr lookups. A query like "dune" legitimately
   * matches a film and a series, so the answer is a single list where each
   * candidate says which *arr it belongs to — the user picks the thing, and the
   * service comes along with it.
   *
   * An *arr that is down or unconfigured is reported, not hidden: a missing
   * Sonarr must not silently turn "no TV results" into "no such show".
   */
  app.get("/api/acquire/lookup", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req) => {
    const { q } = LookupQuery.parse(req.query);
    const candidates: ArrCandidateWithService[] = [];
    const unavailable: Array<{ service: ArrFlavor; detail: string }> = [];

    await Promise.all(ARR_SERVICES.map(async (service) => {
      const a = arr(service);
      if (!a) { unavailable.push({ service, detail: "not configured" }); return; }
      try {
        for (const c of await a.searchCandidates(q)) candidates.push({ ...c, service });
      } catch (e) {
        unavailable.push({ service, detail: arrMessage(e) });
      }
    }));

    // Things already in a library first — usually what you came back for — then
    // by year, newest first, which is the more useful order for a title search.
    candidates.sort((a, b) => {
      if (a.alreadyAdded !== b.alreadyAdded) return a.alreadyAdded ? -1 : 1;
      return (b.year ?? 0) - (a.year ?? 0);
    });
    unavailable.sort((a, b) => a.service.localeCompare(b.service));
    return { candidates, unavailable };
  });

  /** The saved defaults plus the live options they are chosen from, per *arr. */
  app.get("/api/acquire/defaults", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const services = await Promise.all(ARR_SERVICES.map(async (service) => {
      const a = arr(service);
      if (!a) return { service, configured: false as const, detail: "not configured" };
      try {
        const [profiles, roots, metadataProfiles] = await Promise.all([
          a.qualityProfiles(), a.rootFolders(), a.metadataProfiles(),
        ]);
        const drives = getDriveSettings();
        const defaults = defaultsOf(service);
        return {
          service, configured: true as const,
          defaults: {
            ...defaults,
            rootFolderPath: defaultRootFor(ARR_PURPOSE[service], roots, drives, defaults.rootFolderPath),
          },
          profiles, roots: withDrives(roots, drives.drives), metadataProfiles, drives: driveRefs(drives),
        };
      } catch (e) {
        return { service, configured: false as const, detail: arrMessage(e) };
      }
    }));
    return { services };
  });

  app.put("/api/acquire/defaults", guard, async (req, reply) => {
    const body = DefaultsBody.parse(req.body);
    try {
      rememberPlacement(body.service, {
        rootFolderPath: body.rootFolderPath,
        qualityProfileId: body.qualityProfileId,
        metadataProfileId: body.metadataProfileId,
      });
      return { ok: true, defaults: defaultsOf(body.service) };
    } catch (e) {
      return reply.code(409).send({ error: arrMessage(e) });
    }
  });

  /**
   * Make sure the chosen title exists in its *arr, and hand back the library id
   * the release search needs. Idempotent: `addSelected` returns the existing id
   * when the title is already there, so re-running a flow never duplicates.
   *
   * `searchNow` is false throughout — this flow exists so *you* choose the
   * release. Letting the *arr fire its own automatic search here would race the
   * user and grab something they did not pick.
   */
  app.post("/api/acquire/prepare", guard, async (req, reply) => {
    const body = PrepareBody.parse(req.body);
    const a = arr(body.service);
    if (!a) return reply.code(409).send({ error: `${body.service} is not configured` });

    const saved = defaultsOf(body.service);
    try {
      // Fall back to the *arr's own first root/profile so a fresh install works
      // with no configuration at all; the response says which was used.
      let rootFolderPath = body.rootFolderPath;
      if (!rootFolderPath) {
        const roots = await a.rootFolders();
        rootFolderPath = defaultRootFor(ARR_PURPOSE[body.service], roots, getDriveSettings(), saved.rootFolderPath)
          ?? roots[0]?.path;
      }
      if (!rootFolderPath) {
        return reply.code(409).send({ error: `${body.service} has no root folder configured` });
      }
      const qualityProfileId = body.qualityProfileId
        ?? saved.qualityProfileId
        ?? (await a.qualityProfiles())[0]?.id;
      if (qualityProfileId == null) {
        return reply.code(409).send({ error: `${body.service} has no quality profile configured` });
      }

      let metadataProfileId = body.metadataProfileId ?? saved.metadataProfileId;
      if (body.service === "lidarr" && metadataProfileId == null) {
        metadataProfileId = (await a.metadataProfiles())[0]?.id;
        if (metadataProfileId == null) {
          return reply.code(409).send({ error: "Lidarr has no metadata profile configured" });
        }
      }

      const created = await a.addSelected({
        term: body.term,
        selectionId: body.selectionId,
        qualityProfileId,
        rootFolderPath,
        monitored: true,
        searchNow: false,
        metadataProfileId,
      });

      if (body.remember) {
        rememberPlacement(body.service, { rootFolderPath, qualityProfileId, metadataProfileId });
      }

      logActivity({
        kind: "requested",
        service: body.service,
        message: `Prepared "${created.title}" in ${body.service} (${rootFolderPath})`,
        data: { id: created.id, rootFolderPath, qualityProfileId },
      });
      return {
        ok: true, id: created.id, title: created.title,
        service: body.service, rootFolderPath, qualityProfileId, metadataProfileId,
      };
    } catch (e) {
      return reply.code(502).send({ error: arrMessage(e) });
    }
  });

  /**
   * What can be searched within a prepared title: Sonarr wants a season (it
   * refuses a whole-series interactive search), Lidarr can narrow to an album.
   * Radarr has nothing to choose — a movie is the unit.
   */
  app.get("/api/acquire/targets", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req, reply) => {
    const { service, id } = TargetsQuery.parse(req.query);
    const a = arr(service);
    if (!a) return reply.code(409).send({ error: `${service} is not configured` });
    try {
      if (service === "sonarr") return { kind: "season" as const, seasons: await a.seasons(id) };
      if (service === "lidarr") return { kind: "album" as const, albums: await a.albums(id) };
      return { kind: "none" as const };
    } catch (e) {
      return reply.code(502).send({ error: arrMessage(e) });
    }
  });

  /**
   * Start the *arr's interactive search. Returns a token immediately: the search
   * queries every indexer in series and regularly runs for minutes, which no
   * browser request should be holding open.
   */
  app.post("/api/acquire/search", guard, async (req, reply) => {
    const body = SearchBody.parse(req.body);
    const a = arr(body.service);
    if (!a) return reply.code(409).send({ error: `${body.service} is not configured` });
    if (body.service === "sonarr" && body.seasonNumber == null) {
      return reply.code(400).send({ error: "Sonarr searches one season at a time — choose a season." });
    }
    const job = startSearch(body.service, body.label ?? `#${body.id}`, () =>
      a.releases({ id: body.id, seasonNumber: body.seasonNumber, albumId: body.albumId }));
    return { ok: true, ...viewOf(job) };
  });

  app.get("/api/acquire/search/:id", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = getSearch(id);
    // Expired rather than never-existed, in all likelihood — say so, because
    // "not found" reads as a bug and this is just a list that timed out.
    if (!job) return reply.code(404).send({ error: "that search has expired — run it again" });
    return viewOf(job);
  });

  /**
   * Grab the chosen release **through the *arr**. This is the whole point of the
   * flow: the release lands in that *arr's queue and download client, so the
   * *arr imports it, renames it, and puts it in its root folder. TorHQ's
   * involvement ends here.
   */
  app.post("/api/acquire/grab", guard, async (req, reply) => {
    const body = GrabBody.parse(req.body);
    const a = arr(body.service);
    if (!a) return reply.code(409).send({ error: `${body.service} is not configured` });
    try {
      await a.grabRelease(body.guid, body.indexerId);
      logActivity({
        kind: "queued",
        service: body.service,
        message: `${body.service} is grabbing "${body.title ?? "release"}"`
          + (body.override ? " (profile rejection overridden)" : ""),
        data: { indexerId: body.indexerId, override: !!body.override },
      });
      return { ok: true, service: body.service };
    } catch (e) {
      return reply.code(502).send({ error: arrMessage(e) });
    }
  });
}
