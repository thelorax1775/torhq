import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { wantedItems, type Library, type WantedItem } from "../db/schema.js";
import type { QbTorrent } from "../adapters/qbittorrent.js";
import { previewIntake, type IntakePreview } from "../queue/intake.js";
import { enqueue, getJob } from "../queue/queue.js";
import { listLibraries } from "../config/store.js";
import { logActivity } from "./activity.js";
import { safeFilename } from "../security/paths.js";

/**
 * Wanted items: books that no *arr owns. TorHQ's own intake does the import
 * (docs/vision.md), so this module is the glue that carries one title through:
 *
 *   requested -> grabbed -> ready (preview built) -> importing -> imported
 *
 * The only step that moves a file is `approveWanted`, which queues the normal
 * manual-intake job. Everything before it is read-only: `reconcileWanted`
 * builds a dry-run preview when the download finishes and stops there.
 */
export type WantedStatus = "requested" | "grabbed" | "ready" | "importing" | "imported" | "failed" | "declined";

export const ACTIVE_STATUSES: WantedStatus[] = ["requested", "grabbed", "ready", "importing"];

export interface WantedDeps {
  /** Null when qBittorrent is not configured. */
  qb(): { torrents(category?: string): Promise<QbTorrent[]> } | null;
  approvedRoots: string[];
}

export class WantedError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

/** Case/punctuation-insensitive identity for "is this the same book". */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function tagFor(id: string): string { return `torhq-wanted-${id}`; }

export function createWanted(input: {
  kind?: "book"; title: string; author?: string | null; externalId?: string | null; requestedBy: string;
}): { item: WantedItem; existing: boolean } {
  const db = getDb();
  const active = db.select().from(wantedItems).where(inArray(wantedItems.status, [...ACTIVE_STATUSES, "imported"])).all();
  const dup = active.find((w) =>
    (input.externalId && w.externalId === input.externalId)
    || (norm(w.title) === norm(input.title) && norm(w.author ?? "") === norm(input.author ?? "")));
  if (dup) return { item: dup, existing: true };
  const id = randomUUID();
  db.insert(wantedItems).values({
    id, kind: input.kind ?? "book", title: input.title, author: input.author ?? null,
    externalId: input.externalId ?? null, requestedBy: input.requestedBy,
  }).run();
  logActivity({ kind: "requested", service: "books", message: `Book requested: ${input.title}${input.author ? ` by ${input.author}` : ""} (${input.requestedBy})`, data: { wantedId: id } });
  return { item: getWanted(id)!, existing: false };
}

export function getWanted(id: string): WantedItem | undefined {
  return getDb().select().from(wantedItems).where(eq(wantedItems.id, id)).get();
}

export function listWanted(requestedBy?: string): WantedItem[] {
  const q = getDb().select().from(wantedItems);
  return (requestedBy ? q.where(eq(wantedItems.requestedBy, requestedBy)) : q)
    .orderBy(desc(wantedItems.createdAt)).limit(200).all();
}

/** The newest wanted item for an Open Library work, for the hub's status badge. */
export function wantedByExternalId(externalId: string): WantedItem | undefined {
  return getDb().select().from(wantedItems).where(eq(wantedItems.externalId, externalId))
    .orderBy(desc(wantedItems.createdAt)).get();
}

function patch(id: string, set: Partial<WantedItem>): void {
  getDb().update(wantedItems).set({ ...set, updatedAt: Date.now() }).where(eq(wantedItems.id, id)).run();
}

/** Record the grab the admin chose. */
export function markGrabbed(id: string, g: { releaseTitle: string; releaseFormat: string | null; category: string }): void {
  patch(id, {
    status: "grabbed", releaseTitle: g.releaseTitle.slice(0, 512), releaseFormat: g.releaseFormat,
    qbCategory: g.category, torrentTag: tagFor(id), error: null,
    // A re-grab starts clean: never keep following the replaced torrent or its preview.
    torrentHash: null, sourcePath: null, previewJson: null, libraryKey: null,
  });
  logActivity({ kind: "queued", service: "qbittorrent", message: `Grabbed "${g.releaseTitle.slice(0, 120)}" into ${g.category}`, data: { wantedId: id } });
}

export function declineWanted(id: string, by: string): void {
  patch(id, { status: "declined" });
  logActivity({ kind: "info", service: "books", message: `Book request declined (${by})`, data: { wantedId: id } });
}

/** The books destination: the first library aimed at Kavita whose kind is `books`. */
export function findBooksLibrary(libraries: Library[] = listLibraries()): Library | undefined {
  return libraries.find((l) => l.kind === "books" && l.targetService === "kavita");
}

function isDone(t: QbTorrent): boolean {
  return t.progress >= 1 && !/^(moving|checking|allocating|missingFiles|error)/i.test(t.state);
}

/** What a finished download is imported as: a folder keeps its name; a lone file keeps its extension. */
async function targetNameFor(w: WantedItem, sourcePath: string): Promise<string> {
  const base = safeFilename(w.author ? `${w.title} - ${w.author}` : w.title);
  const st = await fs.lstat(sourcePath);
  return st.isDirectory() ? base : `${base}${extname(sourcePath)}`;
}

/**
 * Advance every wanted item as far as it can go without a human:
 *  - grabbed + download finished -> dry-run preview built, status `ready`;
 *  - importing + job finished    -> `imported` (or `failed` with the job's error).
 * Never moves, copies or deletes a file: `previewIntake` only reads.
 */
export async function reconcileWanted(deps: WantedDeps): Promise<{ ready: number; imported: number; failed: number }> {
  const out = { ready: 0, imported: 0, failed: 0 };
  const open = getDb().select().from(wantedItems)
    .where(inArray(wantedItems.status, ["grabbed", "importing"])).all();

  let torrents: QbTorrent[] | null = null;
  const loadTorrents = async () => {
    if (torrents) return torrents;
    const qb = deps.qb();
    if (!qb) return null;
    try { torrents = await qb.torrents(); } catch { torrents = null; }
    return torrents;
  };

  for (const w of open) {
    if (w.status === "importing") {
      const job = w.jobId ? getJob(w.jobId) : undefined;
      if (job?.status === "completed") {
        patch(w.id, { status: "imported", error: null });
        logActivity({ kind: "imported", service: "books", message: `Book imported: ${w.title}`, data: { wantedId: w.id } });
        out.imported++;
      } else if (job?.status === "dead") {
        patch(w.id, { status: "failed", error: job.lastError ?? "the import job failed" });
        out.failed++;
      }
      continue;
    }

    const all = await loadTorrents();
    if (!all) continue; // qBittorrent unreachable: try again next pass
    const byHash = w.torrentHash ? all.find((x) => x.hash === w.torrentHash) : undefined;
    // Without a pinned hash, take the newest torrent carrying the tag (an older one may be a replaced grab).
    const t = byHash ?? (w.torrentTag ? all.filter((x) => x.tags.includes(w.torrentTag!)).sort((a, b) => (b.addedOn ?? 0) - (a.addedOn ?? 0))[0] : undefined);
    if (!t) {
      // Added moments ago it may not be listed yet; later, it was removed from qBittorrent.
      if (Date.now() - w.updatedAt > 5 * 60_000) {
        patch(w.id, { status: "failed", error: "the torrent is no longer in qBittorrent" });
        out.failed++;
      }
      continue;
    }
    if (!w.torrentHash) patch(w.id, { torrentHash: t.hash });
    if (!isDone(t)) continue;

    const lib = findBooksLibrary();
    if (!lib) {
      patch(w.id, { error: "No books library is set up. Add one on the Libraries page (kind: books, target: kavita)." });
      continue;
    }
    const sourcePath = t.contentPath || join(t.savePath, t.name);
    try {
      const targetName = await targetNameFor(w, sourcePath);
      const preview = await previewIntake({ libraryKey: lib.key, sourcePath, targetName }, deps.approvedRoots);
      patch(w.id, {
        status: "ready", libraryKey: lib.key, sourcePath: preview.sourcePath,
        previewJson: JSON.stringify({ ...preview, targetName }), error: null,
      });
      logActivity({
        kind: "completed", service: "books",
        message: `Downloaded "${w.title}". Import preview ready for approval (${preview.entries.length} entries).`,
        data: { wantedId: w.id },
      });
      out.ready++;
    } catch (e) {
      const msg = (e as Error).message;
      if (w.error !== msg) patch(w.id, { error: msg });
    }
  }
  return out;
}

export interface StoredPreview extends IntakePreview { targetName: string }

export function previewOf(w: WantedItem): StoredPreview | null {
  if (!w.previewJson) return null;
  try { return JSON.parse(w.previewJson) as StoredPreview; } catch { return null; }
}

/**
 * The one-click approval. Re-runs the dry run against the files as they are now
 * (the download may have changed since the preview was built), then queues the
 * normal intake job. This is the only place the books flow causes a file move.
 */
export async function approveWanted(id: string, approvedRoots: string[], by: string): Promise<{ jobId: string }> {
  const w = getWanted(id);
  if (!w) throw new WantedError("not found", 404);
  if (w.status !== "ready" || !w.libraryKey || !w.sourcePath) {
    throw new WantedError(`nothing to approve: this item is ${w.status}, not ready`, 409);
  }
  const stored = previewOf(w);
  const targetName = stored?.targetName ?? basename(w.sourcePath);
  try {
    await previewIntake({ libraryKey: w.libraryKey, sourcePath: w.sourcePath, targetName }, approvedRoots);
  } catch (e) {
    patch(id, { status: "grabbed", error: (e as Error).message });
    throw new WantedError(`the preview no longer holds: ${(e as Error).message}`, 422);
  }
  const job = enqueue({
    type: "manual_intake",
    payload: { libraryKey: w.libraryKey, sourcePath: w.sourcePath, targetName },
    idempotencyKey: `wanted:${id}`,
  });
  patch(id, { status: "importing", jobId: job.id, error: null });
  logActivity({ kind: "importing", jobId: job.id, service: "books", message: `Import of "${w.title}" approved by ${by}`, data: { wantedId: id } });
  return { jobId: job.id };
}
