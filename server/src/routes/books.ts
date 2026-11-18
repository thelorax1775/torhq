import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { ProwlarrAdapter, ProwlarrRelease } from "../adapters/prowlarr.js";
import type { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import { logActivity } from "../lib/activity.js";
import {
  BOOKS_QB_CATEGORY, BOOK_CATEGORIES, bestBookRelease, bookQuery, detectFormat, rankBookReleases,
} from "../lib/books.js";
import {
  AUDIOBOOKS_QB_CATEGORY, AUDIOBOOK_CATEGORIES, bestAudiobookRelease, detectAudioFormat, rankAudiobookReleases,
} from "../lib/audiobooks.js";
import {
  WantedError, approveWanted, createWanted, declineWanted, findAudiobooksLibrary, findBooksLibrary, getWanted, listWanted,
  markGrabbed, previewOf, reconcileWanted, tagFor, type WantedDeps,
} from "../lib/wanted.js";
import type { WantedItem } from "../db/schema.js";
import type { AppContext } from "../lib/context.js";

/**
 * Books — the flow for the one kind with no *arr: pick a book, find a release in
 * Prowlarr, grab it into qBittorrent's `torhq-books` category, and when it
 * finishes TorHQ builds an intake PREVIEW that an admin approves with one click.
 *
 * Access: any signed-in user may ask for a book; everything that searches,
 * grabs, approves or declines is admin-only. Nothing moves a file except
 * `approve`, which queues the normal previewed manual-intake job.
 */
const RequestBody = z.object({
  title: z.string().trim().min(1).max(256),
  author: z.string().trim().max(256).optional(),
  externalId: z.string().trim().regex(/^OL\d+W$/).optional(),
});

const IdParam = z.object({ id: z.string().uuid() });

const GrabBody = z.object({
  guid: z.string().min(1).max(2048),
  indexerId: z.number().int().nonnegative(),
  // Only well-formed magnet links, never an arbitrary URL handed to qBittorrent.
  magnet: z.string().regex(/^magnet:\?.*xt=urn:btih:[A-Za-z0-9]{32,40}(&|$)/i, "not a valid magnet link").max(4096).optional(),
  downloadUrl: z.string().url().max(2048).optional(),
  title: z.string().max(8192).transform((s) => s.replace(/\s+/g, " ").trim().slice(0, 512)),
});

let depsOverride: WantedDeps | null = null;
/** Test hook: swap qBittorrent for a mock. Pass null to restore. */
export function setWantedDepsForTest(d: WantedDeps | null): void { depsOverride = d; }

/** What a member may see of an item: no paths, no torrent identifiers. */
function publicView(w: WantedItem, isAdmin: boolean) {
  const base = {
    id: w.id, kind: w.kind, title: w.title, author: w.author, externalId: w.externalId,
    status: w.status, requestedBy: w.requestedBy, createdAt: w.createdAt, updatedAt: w.updatedAt,
  };
  if (!isAdmin) return base;
  const preview = previewOf(w);
  return {
    ...base,
    releaseTitle: w.releaseTitle, releaseFormat: w.releaseFormat, error: w.error, jobId: w.jobId,
    preview: preview && {
      destPath: preview.destPath, sourcePath: preview.sourcePath, importMode: preview.importMode,
      entries: preview.entries, totalBytes: preview.totalBytes, warnings: preview.warnings,
      targetName: preview.targetName,
    },
  };
}

/** What differs between the ebook flow and the audiobook flow; everything else is shared. */
interface Flow {
  kind: "book" | "audiobook";
  base: string;
  noun: string;
  category: string;
  categories: readonly number[];
  query(title: string, author?: string | null): string;
  rank(raw: ProwlarrRelease[], want: { title: string }): Array<{ guid: string }>;
  best(ranked: any[]): { guid: string } | null;
  format(title: string): string | null;
  library(): { key: string; label: string; importMode: string } | undefined;
  libraryHint: string;
}

const BOOK_FLOW: Flow = {
  kind: "book", base: "/api/books", noun: "book", category: BOOKS_QB_CATEGORY, categories: BOOK_CATEGORIES,
  query: bookQuery, rank: rankBookReleases, best: bestBookRelease, format: detectFormat, library: findBooksLibrary,
  libraryHint: "No books library: add one on the Libraries page (kind books, target Kavita).",
};
const AUDIOBOOK_FLOW: Flow = {
  kind: "audiobook", base: "/api/audiobooks", noun: "audiobook", category: AUDIOBOOKS_QB_CATEGORY, categories: AUDIOBOOK_CATEGORIES,
  query: bookQuery, rank: rankAudiobookReleases, best: bestAudiobookRelease, format: detectAudioFormat, library: findAudiobooksLibrary,
  libraryHint: "No audiobooks library: add one on the Libraries page (kind audiobooks, target Audiobookshelf).",
};

const FLOWS: Record<string, Flow> = { book: BOOK_FLOW, audiobook: AUDIOBOOK_FLOW };

/** A release a flow can hand to qBittorrent: a magnet, or Prowlarr's download proxy URL. */
interface Sendable { title: string; indexerId: number; magnet?: string; downloadUrl?: string }

/**
 * Put one release into qBittorrent under the flow's category, tagged so the
 * finished download can be found again, and record the grab. Shared by the
 * admin's own release pick and by approving a member's request.
 */
async function sendToQb(flow: Flow, id: string, p: ProwlarrAdapter, qb: QbittorrentAdapter, r: Sendable): Promise<void> {
  let url: string;
  try {
    if (r.magnet) url = r.magnet;
    else if (r.downloadUrl) url = p.signDownloadUrl(r.downloadUrl, r.indexerId);
    else throw new Error("this release has no magnet or download URL");
  } catch (e) {
    throw new WantedError((e as Error).message, 400);
  }
  await qb.addTorrent({ url, category: flow.category, tags: [tagFor(id)] });
  markGrabbed(id, { releaseTitle: r.title, releaseFormat: flow.format(r.title), category: flow.category });
}

export function bookRoutes(app: FastifyInstance, ctx: AppContext): void {
  flowRoutes(app, ctx, BOOK_FLOW);
  flowRoutes(app, ctx, AUDIOBOOK_FLOW);
  pendingRoutes(app, ctx);
}

/**
 * Requests waiting for the admin, for Activity's Requests tab and the nav badges.
 *
 * Movie, TV and music requests go straight to Radarr/Sonarr/Lidarr, which search
 * by themselves, so nothing of theirs waits here. Books and audiobooks have no
 * *arr: a request sits at `requested` until the admin approves it (TorHQ grabs
 * the best-ranked release) or declines it. All admin-only.
 */
function pendingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const adminRead = { preHandler: [app.requireAuth, app.requireAdmin] };
  const admin = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };
  const prowlarr = () => getAdapter("prowlarr", ctx.masterKey) as ProwlarrAdapter | null;
  const qbittorrent = () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
  const pending = () => listWanted().filter((w) => w.status === "requested" && w.kind in FLOWS);

  app.get("/api/requests/pending", adminRead, async () => ({
    items: pending().map((w) => ({
      id: w.id, kind: w.kind, title: w.title, author: w.author, externalId: w.externalId,
      requestedBy: w.requestedBy, createdAt: w.createdAt,
    })),
  }));

  // What waits on the admin, counted, for the nav badges.
  app.get("/api/attention", adminRead, async () => ({
    requests: pending().length,
    imports: listWanted().filter((w) => w.status === "ready" && w.kind in FLOWS).length,
  }));

  // Approve: search Prowlarr for the request and grab the best-ranked release.
  app.post("/api/requests/pending/:id/approve", admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const w = getWanted(id);
    const flow = w ? FLOWS[w.kind] : undefined;
    if (!w || !flow) return reply.code(404).send({ error: "not found" });
    if (w.status !== "requested") return reply.code(409).send({ error: `this request is already ${w.status}` });
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    const qb = qbittorrent();
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });
    let best: ProwlarrRelease | undefined;
    try {
      const raw: ProwlarrRelease[] = await p.search(flow.query(w.title, w.author), { categories: [...flow.categories] });
      const ranked = flow.rank(raw, { title: w.title }) as unknown as ProwlarrRelease[];
      const guid = flow.best(ranked)?.guid;
      best = ranked.find((r) => r.guid === guid);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    if (!best) {
      return reply.code(409).send({ error: `No ${flow.noun} release matches the title and has seeders. Choose one by hand on the ${flow.noun === "book" ? "Books" : "Audiobooks"} page, or decline.` });
    }
    try {
      await sendToQb(flow, id, p, qb, { title: best.title, indexerId: best.indexerId, magnet: best.magnetUrl, downloadUrl: best.downloadUrl });
    } catch (e) {
      return reply.code(e instanceof WantedError ? e.statusCode : 502).send({ error: (e as Error).message });
    }
    logActivity({ kind: "info", service: flow.kind === "audiobook" ? "audiobooks" : "books", message: `Request for "${w.title}" (${w.requestedBy}) approved by ${req.session!.username}`, data: { wantedId: id } });
    return { ok: true, release: best.title, item: publicView(getWanted(id)!, true) };
  });

  app.post("/api/requests/pending/:id/decline", admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const w = getWanted(id);
    if (!w || !(w.kind in FLOWS)) return reply.code(404).send({ error: "not found" });
    if (w.status !== "requested") return reply.code(409).send({ error: `this request is already ${w.status}` });
    declineWanted(id, req.session!.username);
    return { ok: true };
  });
}

function flowRoutes(app: FastifyInstance, ctx: AppContext, flow: Flow): void {
  const read = { preHandler: app.requireAuth };
  const member = { preHandler: [app.requireAuth, app.requireCsrf] };
  const adminRead = { preHandler: [app.requireAuth, app.requireAdmin] };
  const admin = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  const prowlarr = () => getAdapter("prowlarr", ctx.masterKey) as ProwlarrAdapter | null;
  const qbittorrent = () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
  /** An item of this flow only: a book id on an audiobook route is a 404, never a cross-kind action. */
  const mine = (id: string) => { const w = getWanted(id); return w && w.kind === flow.kind ? w : undefined; };
  const deps = (): WantedDeps => depsOverride ?? { qb: qbittorrent, approvedRoots: ctx.env.approvedRoots };

  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown) => {
    if (e instanceof WantedError) return reply.code(e.statusCode).send({ error: e.message });
    throw e;
  };

  // What the books flow needs, and which part is missing. Admin-only: it names services.
  app.get(`${flow.base}/status`, adminRead, async () => {
    const p = prowlarr();
    const qb = qbittorrent();
    const lib = flow.library();
    let categoryExists: boolean | null = null;
    if (qb) {
      try { categoryExists = flow.category in (await qb.categories()); } catch { categoryExists = null; }
    }
    const problems: string[] = [];
    if (!p) problems.push("Prowlarr is not configured.");
    if (!qb) problems.push("qBittorrent is not configured.");
    if (categoryExists === false) problems.push(`qBittorrent has no \`${flow.category}\` category; create it with a save path inside an approved root.`);
    if (!lib) problems.push(flow.libraryHint);
    return {
      prowlarr: !!p, qbittorrent: !!qb, category: flow.category, categoryExists,
      library: lib ? { key: lib.key, label: lib.label, importMode: lib.importMode } : null,
      ready: problems.length === 0, problems,
    };
  });

  // A member (or the admin) asks for a book. Duplicates return the existing item.
  app.post(`${flow.base}/request`, member, async (req) => {
    const body = RequestBody.parse(req.body);
    const { item, existing } = createWanted({ ...body, kind: flow.kind, requestedBy: req.session!.username });
    return { ok: true, existing, item: publicView(item, req.session!.role === "admin") };
  });

  // The admin sees everything; a member sees only their own requests, without paths.
  app.get(`${flow.base}/wanted`, read, async (req) => {
    const isAdmin = req.session!.role === "admin";
    // Finished downloads become previews on read too, so the page is never behind the watcher.
    if (isAdmin) await reconcileWanted(deps()).catch(() => undefined);
    const rows = listWanted(isAdmin ? undefined : req.session!.username).filter((w) => w.kind === flow.kind);
    return { items: rows.map((w) => publicView(w, isAdmin)) };
  });

  // Search Prowlarr's book categories with title + author and rank the results.
  app.post(`${flow.base}/wanted/:id/search`, admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const w = mine(id);
    if (!w) return reply.code(404).send({ error: "not found" });
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    try {
      const raw: ProwlarrRelease[] = await p.search(flow.query(w.title, w.author), { categories: [...flow.categories] });
      const releases = flow.rank(raw, { title: w.title });
      const best = flow.best(releases);
      return { query: flow.query(w.title, w.author), categories: flow.categories, releases, bestGuid: best?.guid ?? null };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Grab the chosen release into `torhq-books`, tagged so the finished download can be found again.
  app.post(`${flow.base}/wanted/:id/grab`, admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = GrabBody.parse(req.body);
    const w = mine(id);
    if (!w) return reply.code(404).send({ error: "not found" });
    if (w.status !== "requested" && w.status !== "failed" && w.status !== "grabbed") {
      return reply.code(409).send({ error: `this item is ${w.status}; it cannot be grabbed again` });
    }
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    const qb = qbittorrent();
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });

    try {
      await sendToQb(flow, id, p, qb, body);
    } catch (e) {
      return reply.code(e instanceof WantedError ? e.statusCode : 502).send({ error: (e as Error).message });
    }
    return { ok: true, category: flow.category, item: publicView(getWanted(id)!, true) };
  });

  // The one-click approval: queues the previewed intake job. The only step that moves files.
  app.post(`${flow.base}/wanted/:id/approve`, admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!mine(id)) return reply.code(404).send({ error: "not found" });
    try {
      const { jobId } = await approveWanted(id, ctx.env.approvedRoots, req.session!.username);
      return { ok: true, jobId, item: publicView(getWanted(id)!, true) };
    } catch (e) { return fail(reply, e); }
  });

  app.post(`${flow.base}/wanted/:id/decline`, admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!mine(id)) return reply.code(404).send({ error: "not found" });
    declineWanted(id, req.session!.username);
    return { ok: true };
  });
}
