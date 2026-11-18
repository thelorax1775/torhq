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
  WantedError, approveWanted, createWanted, declineWanted, findBooksLibrary, getWanted, listWanted,
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

export function bookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth };
  const member = { preHandler: [app.requireAuth, app.requireCsrf] };
  const adminRead = { preHandler: [app.requireAuth, app.requireAdmin] };
  const admin = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  const prowlarr = () => getAdapter("prowlarr", ctx.masterKey) as ProwlarrAdapter | null;
  const qbittorrent = () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null;
  const deps = (): WantedDeps => depsOverride ?? { qb: qbittorrent, approvedRoots: ctx.env.approvedRoots };

  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown) => {
    if (e instanceof WantedError) return reply.code(e.statusCode).send({ error: e.message });
    throw e;
  };

  // What the books flow needs, and which part is missing. Admin-only: it names services.
  app.get("/api/books/status", adminRead, async () => {
    const p = prowlarr();
    const qb = qbittorrent();
    const lib = findBooksLibrary();
    let categoryExists: boolean | null = null;
    if (qb) {
      try { categoryExists = BOOKS_QB_CATEGORY in (await qb.categories()); } catch { categoryExists = null; }
    }
    const problems: string[] = [];
    if (!p) problems.push("Prowlarr is not configured.");
    if (!qb) problems.push("qBittorrent is not configured.");
    if (categoryExists === false) problems.push(`qBittorrent has no \`${BOOKS_QB_CATEGORY}\` category; create it with a save path inside an approved root.`);
    if (!lib) problems.push("No books library: add one on the Libraries page (kind books, target Kavita).");
    return {
      prowlarr: !!p, qbittorrent: !!qb, category: BOOKS_QB_CATEGORY, categoryExists,
      library: lib ? { key: lib.key, label: lib.label, importMode: lib.importMode } : null,
      ready: problems.length === 0, problems,
    };
  });

  // A member (or the admin) asks for a book. Duplicates return the existing item.
  app.post("/api/books/request", member, async (req) => {
    const body = RequestBody.parse(req.body);
    const { item, existing } = createWanted({ ...body, requestedBy: req.session!.username });
    return { ok: true, existing, item: publicView(item, req.session!.role === "admin") };
  });

  // The admin sees everything; a member sees only their own requests, without paths.
  app.get("/api/books/wanted", read, async (req) => {
    const isAdmin = req.session!.role === "admin";
    // Finished downloads become previews on read too, so the page is never behind the watcher.
    if (isAdmin) await reconcileWanted(deps()).catch(() => undefined);
    const rows = listWanted(isAdmin ? undefined : req.session!.username);
    return { items: rows.map((w) => publicView(w, isAdmin)) };
  });

  // Search Prowlarr's book categories with title + author and rank the results.
  app.post("/api/books/wanted/:id/search", admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const w = getWanted(id);
    if (!w) return reply.code(404).send({ error: "not found" });
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    try {
      const raw: ProwlarrRelease[] = await p.search(bookQuery(w.title, w.author), { categories: [...BOOK_CATEGORIES] });
      const releases = rankBookReleases(raw, { title: w.title });
      const best = bestBookRelease(releases);
      return { query: bookQuery(w.title, w.author), categories: BOOK_CATEGORIES, releases, bestGuid: best?.guid ?? null };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Grab the chosen release into `torhq-books`, tagged so the finished download can be found again.
  app.post("/api/books/wanted/:id/grab", admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = GrabBody.parse(req.body);
    const w = getWanted(id);
    if (!w) return reply.code(404).send({ error: "not found" });
    if (w.status !== "requested" && w.status !== "failed" && w.status !== "grabbed") {
      return reply.code(409).send({ error: `this item is ${w.status}; it cannot be grabbed again` });
    }
    const p = prowlarr();
    if (!p) return reply.code(409).send({ error: "Prowlarr is not configured" });
    const qb = qbittorrent();
    if (!qb) return reply.code(409).send({ error: "qBittorrent is not configured" });

    let url: string;
    try {
      if (body.magnet) url = body.magnet;
      else if (body.downloadUrl) url = p.signDownloadUrl(body.downloadUrl, body.indexerId);
      else throw new Error("this release has no magnet or download URL");
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    try {
      await qb.addTorrent({ url, category: BOOKS_QB_CATEGORY, tags: [tagFor(id)] });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    markGrabbed(id, { releaseTitle: body.title, releaseFormat: detectFormat(body.title), category: BOOKS_QB_CATEGORY });
    return { ok: true, category: BOOKS_QB_CATEGORY, item: publicView(getWanted(id)!, true) };
  });

  // The one-click approval: queues the previewed intake job. The only step that moves files.
  app.post("/api/books/wanted/:id/approve", admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    try {
      const { jobId } = await approveWanted(id, ctx.env.approvedRoots, req.session!.username);
      return { ok: true, jobId, item: publicView(getWanted(id)!, true) };
    } catch (e) { return fail(reply, e); }
  });

  app.post("/api/books/wanted/:id/decline", admin, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!getWanted(id)) return reply.code(404).send({ error: "not found" });
    declineWanted(id, req.session!.username);
    logActivity({ kind: "info", service: "books", message: `Declined book ${id}` });
    return { ok: true };
  });
}
