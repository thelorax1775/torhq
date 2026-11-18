import type { ArrAdapter, ArrAlbum, ArrLookupHit, ArrQueueItem, ArrSeason } from "../adapters/arr.js";
import { HttpError } from "../adapters/http.js";
import type { CatalogueDetail, CatalogueItem, CataloguePage } from "../adapters/catalogue.js";
import type { OpenLibraryWork } from "../adapters/openlibrary.js";

/**
 * The hub: one search across every media kind, and one detail view, both
 * answering "do we already have it?". Read-only. The owner app does the adding;
 * this module only asks (see docs/vision.md, "Who owns what").
 *
 * Everything the hub talks to comes in through `HubDeps`, so tests drive it with
 * plain mocks and the route wires in the real adapters.
 */

export const HUB_KINDS = ["movie", "tv", "music", "game", "book", "audiobook"] as const;
export type HubKind = (typeof HUB_KINDS)[number];
export type HubStatus = "available" | "requested" | "downloading" | "missing" | "none" | "unknown";
export type HubOwner = "radarr" | "sonarr" | "lidarr" | "intake" | "prowlarr";

export const OWNER: Record<HubKind, HubOwner> = {
  movie: "radarr", tv: "sonarr", music: "lidarr", game: "prowlarr", book: "intake", audiobook: "intake",
};

export interface HubResult {
  kind: HubKind;
  /** Stable per kind: tmdb:N (movie), tvdb:N (tv), mbid:X (music), RAWG id (game), Open Library work id (book/audiobook). */
  id: string;
  title: string;
  year?: number;
  subtitle?: string;
  poster?: string;
  overview?: string;
  status: HubStatus;
  owner: HubOwner;
  /** True when the owner app is ready to take it and it is not already held or on its way. */
  actionable: boolean;
}

export interface HubSource {
  kind: HubKind;
  available: boolean;
  detail?: string;
}

export interface HubAddOptions {
  service: HubOwner;
  qualityProfileId?: number;
  metadataProfileId?: number;
  /** Admin only: members never see filesystem paths. */
  rootFolderPath?: string;
  monitored: boolean;
  searchNow: boolean;
  /** Where the defaults came from: the saved ones, or the *arr's first choice. */
  basis: "saved" | "arr-first" | "none";
}

export interface HubItem extends HubResult {
  backdrop?: string;
  genres: string[];
  seasons?: ArrSeason[];
  albums?: ArrAlbum[];
  /** The *arr's own library id when it holds the title. */
  libraryId?: number;
  addOptions?: HubAddOptions;
}

/** Only the slice of each adapter the hub uses, so it can be mocked. */
export interface HubDeps {
  arr(service: "radarr" | "sonarr" | "lidarr"): Pick<ArrAdapter, "lookupHits" | "queue" | "albums" | "qualityProfiles" | "rootFolders" | "metadataProfiles"> | null;
  tmdb(): { search(kind: "movie" | "tv", q: string): Promise<CataloguePage>; details(kind: "movie" | "tv", id: string): Promise<CatalogueDetail> } | null;
  rawg(): { search(q: string): Promise<CataloguePage>; details(id: string): Promise<CatalogueDetail> } | null;
  prowlarrConfigured(): boolean;
  openLibrary: {
    search(q: string): Promise<OpenLibraryWork[]>;
    work(id: string): Promise<OpenLibraryWork | null>;
  };
  /** Saved placement defaults for an *arr (from its service config). */
  savedDefaults(service: "radarr" | "sonarr" | "lidarr"): { rootFolderPath?: string; qualityProfileId?: number; metadataProfileId?: number };
  /** Per-source budget; a source that exceeds it degrades instead of stalling the request. */
  timeoutMs: number;
}

const PER_KIND_LIMIT = 8;

class SourceUnavailable extends Error {}

/** A reason safe to show a member: no URLs, hosts, keys or upstream bodies. */
export function describeFailure(e: unknown, timeoutMs: number): string {
  if (e instanceof SourceUnavailable) return e.message;
  if (e instanceof HttpError) return `the service answered HTTP ${e.statusCode}`;
  const msg = e instanceof Error ? e.message : "";
  if (/timed out/i.test(msg)) return `timed out after ${Math.round(timeoutMs / 100) / 10}s`;
  return "the service is unreachable or returned an error";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timed out")), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** Map the *arr's own facts about a title to the one status the UI shows. */
export function statusFor(hit: { libraryId?: number; monitored: boolean; fileCount: number }, queued: boolean): HubStatus {
  if (hit.libraryId === undefined) return "none";
  if (queued) return "downloading";
  if (hit.fileCount > 0) return "available";
  return hit.monitored ? "requested" : "missing";
}

const actionableFor = (status: HubStatus, ownerReady: boolean) =>
  ownerReady && (status === "none" || status === "missing" || status === "unknown");

/** libraryIds the *arr's queue says are being downloaded; empty if the queue can't be read. */
async function queuedIds(a: NonNullable<ReturnType<HubDeps["arr"]>>): Promise<Set<number>> {
  try {
    const items: ArrQueueItem[] = await a.queue();
    return new Set(items.map((i) => i.libraryId).filter((n): n is number => n !== undefined));
  } catch {
    return new Set();
  }
}

const ARR_OF = { movie: "radarr", tv: "sonarr", music: "lidarr" } as const;

/** The lookup term that finds exactly one title in each *arr, from a hub id. */
function lookupTerm(kind: "movie" | "tv" | "music", id: string): string | null {
  const m = /^(tmdb|tvdb|mbid):(.+)$/.exec(id);
  if (!m) return null;
  if (kind === "movie" && m[1] === "tmdb") return `tmdb:${m[2]}`;
  if (kind === "tv" && m[1] === "tvdb") return `tvdb:${m[2]}`;
  if (kind === "music" && m[1] === "mbid") return `lidarr:${m[2]}`;
  return null;
}

function fromHit(kind: "movie" | "tv" | "music", hit: ArrLookupHit, queued: Set<number>): HubResult {
  const status = statusFor(hit, hit.libraryId !== undefined && queued.has(hit.libraryId));
  return {
    kind, id: hit.selectionId, title: hit.title, year: hit.year, subtitle: hit.subtitle,
    poster: hit.poster, overview: hit.overview, status, owner: OWNER[kind],
    actionable: actionableFor(status, true),
  };
}

function fromCatalogue(kind: "movie" | "tv" | "game", item: CatalogueItem, ownerReady: boolean): HubResult {
  const id = kind === "movie" ? `tmdb:${item.id}` : item.id;
  return {
    kind, id, title: item.title, year: item.year,
    subtitle: item.platforms?.length ? item.platforms.join(", ") : item.genres[0],
    poster: item.poster, overview: item.overview,
    // Without the owning app nothing can say whether we hold it. A TV show found
    // only on TMDB has no TVDB id either, so it cannot be added from here.
    status: "unknown", owner: OWNER[kind],
    actionable: kind === "tv" ? false : actionableFor("unknown", ownerReady),
  };
}

function fromBook(kind: "book" | "audiobook", w: OpenLibraryWork): HubResult {
  return {
    kind, id: w.id, title: w.title, year: w.year, subtitle: w.author, poster: w.poster, overview: w.overview,
    // No backend knows what the library holds yet; say so instead of guessing.
    status: "unknown", owner: "intake",
    // No book grab path exists yet, so offering an Add would be a dead button.
    actionable: false,
  };
}

async function searchKind(deps: HubDeps, kind: HubKind, q: string): Promise<HubResult[]> {
  switch (kind) {
    case "movie":
    case "tv": {
      const service = ARR_OF[kind];
      const a = deps.arr(service);
      if (a) {
        const [hits, queued] = await Promise.all([a.lookupHits(q), queuedIds(a)]);
        return hits.map((h) => fromHit(kind, h, queued));
      }
      const t = deps.tmdb();
      if (!t) throw new SourceUnavailable(`Neither ${service} nor TMDB is configured. Add one under Services.`);
      return (await t.search(kind, q)).items.map((i) => fromCatalogue(kind, i, false));
    }
    case "music": {
      const a = deps.arr("lidarr");
      if (!a) throw new SourceUnavailable("Lidarr is not configured. Add it under Services.");
      const [hits, queued] = await Promise.all([a.lookupHits(q), queuedIds(a)]);
      return hits.map((h) => fromHit("music", h, queued));
    }
    case "game": {
      const r = deps.rawg();
      if (!r) throw new SourceUnavailable("RAWG is not configured. Add an API key under Services.");
      return (await r.search(q)).items.map((i) => fromCatalogue("game", i, deps.prowlarrConfigured()));
    }
    case "book":
    case "audiobook":
      return (await deps.openLibrary.search(q)).map((w) => fromBook(kind, w));
  }
}

/** Alternate between kinds so the best of each shows first, rather than one kind burying the rest. */
function interleave(groups: HubResult[][]): HubResult[] {
  const out: HubResult[] = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) {
    for (const g of groups) if (i < g.length) out.push(g[i]!);
  }
  return out;
}

export async function hubSearch(
  deps: HubDeps, q: string, kinds: readonly HubKind[],
): Promise<{ results: HubResult[]; sources: HubSource[] }> {
  const wanted = HUB_KINDS.filter((k) => kinds.includes(k)); // canonical order, deduped
  const settled = await Promise.all(wanted.map(async (kind) => {
    try {
      const rows = await withTimeout(searchKind(deps, kind, q), deps.timeoutMs);
      return { source: { kind, available: true } as HubSource, rows: rows.slice(0, PER_KIND_LIMIT) };
    } catch (e) {
      return { source: { kind, available: false, detail: describeFailure(e, deps.timeoutMs) } as HubSource, rows: [] as HubResult[] };
    }
  }));
  return { results: interleave(settled.map((s) => s.rows)), sources: settled.map((s) => s.source) };
}

async function addOptionsFor(deps: HubDeps, service: "radarr" | "sonarr" | "lidarr", isAdmin: boolean): Promise<HubAddOptions> {
  const base = { service, monitored: true, searchNow: true } as const;
  const a = deps.arr(service);
  if (!a) return { ...base, basis: "none" };
  const saved = deps.savedDefaults(service);
  let qualityProfileId = saved.qualityProfileId;
  let rootFolderPath = saved.rootFolderPath;
  let metadataProfileId = saved.metadataProfileId;
  let usedFirst = false;
  try {
    if (qualityProfileId === undefined) { qualityProfileId = (await a.qualityProfiles())[0]?.id; usedFirst = true; }
    if (rootFolderPath === undefined) { rootFolderPath = (await a.rootFolders())[0]?.path; usedFirst = true; }
    if (service === "lidarr" && metadataProfileId === undefined) { metadataProfileId = (await a.metadataProfiles())[0]?.id; usedFirst = true; }
  } catch { /* leave what we have: the sheet can still show the item */ }
  const basis = usedFirst ? "arr-first" : "saved";
  return {
    ...base, basis,
    qualityProfileId,
    metadataProfileId: service === "lidarr" ? metadataProfileId : undefined,
    rootFolderPath: isAdmin ? rootFolderPath : undefined,
  };
}

export class HubItemError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export async function hubItem(deps: HubDeps, kind: HubKind, id: string, isAdmin: boolean): Promise<HubItem> {
  const run = <T>(p: Promise<T>) => withTimeout(p, deps.timeoutMs).catch((e) => {
    throw new HubItemError(describeFailure(e, deps.timeoutMs), 502);
  });

  if (kind === "movie" || kind === "tv" || kind === "music") {
    const service = ARR_OF[kind];
    const a = deps.arr(service);
    const term = lookupTerm(kind, id);
    if (!term) throw new HubItemError(`not a ${kind} id: ${id}`, 400);
    if (!a) throw new HubItemError(`${service} is not configured`, 409);
    const [hits, queued] = await run(Promise.all([a.lookupHits(term), queuedIds(a)]));
    const hit = hits.find((h) => h.selectionId === id) ?? hits[0];
    if (!hit) throw new HubItemError("not found", 404);
    const result = fromHit(kind, hit, queued);
    const albums = kind === "music" && hit.libraryId !== undefined
      ? await run(a.albums(hit.libraryId)).catch(() => undefined) : undefined;
    return {
      ...result, backdrop: hit.backdrop, genres: hit.genres, libraryId: hit.libraryId,
      seasons: kind === "tv" ? hit.seasons : undefined, albums,
      addOptions: await addOptionsFor(deps, service, isAdmin),
    };
  }

  if (kind === "game") {
    const r = deps.rawg();
    if (!r) throw new HubItemError("RAWG is not configured", 409);
    if (!/^\d{1,12}$/.test(id)) throw new HubItemError(`not a game id: ${id}`, 400);
    const d = await run(r.details(id));
    const base = fromCatalogue("game", d, deps.prowlarrConfigured());
    return {
      ...base, overview: d.overview, backdrop: d.backdrop, genres: d.genres,
      addOptions: { service: "prowlarr", monitored: false, searchNow: false, basis: "none" },
    };
  }

  const w = await run(deps.openLibrary.work(id));
  if (!w) throw new HubItemError("not found", 404);
  return {
    ...fromBook(kind, w), genres: [],
    addOptions: { service: "intake", monitored: false, searchNow: false, basis: "none" },
  };
}
