import { httpJson } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Prowlarr v1 API — TorHQ's primary search backend.
 *
 * Prowlarr already aggregates every indexer you run, so TorHQ searches *it*
 * rather than scraping public sites (see torrentsearch.ts, kept as a fallback).
 * FUNCTIONAL: health, indexer list, aggregated release search, and grab.
 *
 * Two things about Prowlarr's release payload shape the code below:
 *  - `downloadUrl` is a Prowlarr-proxied URL that **carries the API key in its
 *    query string**, so it is never handed to the browser as-is: normalization
 *    strips `apikey`, and `signDownloadUrl` re-attaches it server-side (after
 *    checking the URL still points at this Prowlarr) when a grab needs it.
 *  - `magnetUrl` is only a real magnet for some indexers. Public ones put the
 *    magnet in `guid` instead and a Prowlarr proxy link in `magnetUrl`;
 *    normalization falls back to the guid magnet, else treats that proxy link
 *    like `downloadUrl`. Grabbing by `guid` + `indexerId` also always works.
 */
export interface ProwlarrCategory {
  id: number;
  name: string;
}

export interface ProwlarrIndexer {
  id: number;
  name: string;
  enable: boolean;
  protocol: string;
  /** Flattened newznab categories (parents + subcategories) for the filter UI. */
  categories: ProwlarrCategory[];
}

export interface ProwlarrRelease {
  /** Opaque indexer-side id; required (with indexerId) to grab the release. */
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  protocol: "torrent" | "usenet";
  publishDate: string | null;
  categories: ProwlarrCategory[];
  infoUrl?: string;
  magnetUrl?: string;
  /** Prowlarr download proxy URL with the API key stripped (see class doc). */
  downloadUrl?: string;
}

export interface ProwlarrSearchOptions {
  indexerIds?: number[];
  categories?: number[];
  limit?: number;
}

const DEFAULT_SEARCH_LIMIT = 100;

export class ProwlarrAdapter implements ServiceAdapter {
  readonly kind = "prowlarr";
  readonly status = "functional" as const;
  /** Indexer ids searched when the caller doesn't pick any; empty = all. */
  readonly defaultIndexerIds: number[];
  readonly searchLimit: number;

  constructor(private cfg: AdapterConfig) {
    const extra = (cfg.extra ?? {}) as Record<string, unknown>;
    this.defaultIndexerIds = parseIdList(extra.defaultIndexerIds);
    const limit = Number(extra.searchLimit);
    this.searchLimit = Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.max(10, Math.trunc(limit))) : DEFAULT_SEARCH_LIMIT;
  }

  private hdr() { return { "X-Api-Key": this.cfg.secret }; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const s = await httpJson<{ version: string }>(this.cfg.baseUrl, "/api/v1/system/status", { headers: this.hdr() });
      return { healthy: true, version: s.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Configured indexers with their categories, for the search filter UI. */
  async indexers(): Promise<ProwlarrIndexer[]> {
    const list = await httpJson<any[]>(this.cfg.baseUrl, "/api/v1/indexer", { headers: this.hdr() });
    return (Array.isArray(list) ? list : []).map(normalizeIndexer);
  }

  /**
   * Aggregated release search across the selected indexers, seeders-desc.
   * Prowlarr binds `indexerIds`/`categories` as repeated query parameters —
   * a comma-separated value is rejected with HTTP 400 — so the query string is
   * built here rather than via httpJson's single-value `query` option.
   */
  async search(query: string, opts: ProwlarrSearchOptions = {}): Promise<ProwlarrRelease[]> {
    const indexerIds = opts.indexerIds?.length ? opts.indexerIds : this.defaultIndexerIds;
    const params = new URLSearchParams({
      query: query.trim(),
      type: "search",
      limit: String(opts.limit ?? this.searchLimit),
    });
    for (const id of indexerIds) params.append("indexerIds", String(id));
    for (const c of opts.categories ?? []) params.append("categories", String(c));

    const raw = await httpJson<any[]>(this.cfg.baseUrl, `/api/v1/search?${params.toString()}`, {
      headers: this.hdr(),
      // Indexer fan-out is slow; Prowlarr's own UI waits far longer than 8s.
      timeoutMs: 45000,
    });
    return sortBySeeders(normalizeReleases(raw));
  }

  /**
   * Hand the release back to Prowlarr, which pushes it to the download client
   * (or application) it is configured with. This is the grab path that always
   * works — including for releases with no magnet and for usenet.
   */
  async grab(guid: string, indexerId: number): Promise<void> {
    await httpJson(this.cfg.baseUrl, "/api/v1/search", {
      method: "POST",
      headers: this.hdr(),
      body: { guid, indexerId },
      timeoutMs: 30000,
    });
  }

  /**
   * Re-attach the API key to a download URL that came back from `search()`.
   * The URL is only trusted if it still points at this Prowlarr instance and at
   * the given indexer's download proxy, so a caller can never smuggle an
   * arbitrary URL through TorHQ into qBittorrent.
   */
  signDownloadUrl(downloadUrl: string, indexerId: number): string {
    let url: URL;
    let base: URL;
    try {
      url = new URL(downloadUrl);
      base = new URL(this.cfg.baseUrl);
    } catch {
      throw new Error("not a valid Prowlarr download URL");
    }
    if (url.origin !== base.origin || !url.pathname.endsWith(`/${indexerId}/download`)) {
      throw new Error("download URL does not belong to this Prowlarr indexer");
    }
    url.searchParams.set("apikey", this.cfg.secret);
    return url.toString();
  }
}

// --- normalization (pure, unit-testable without network) -------------------

/** Prowlarr indexer resource → the id/name/enable/protocol/categories the UI needs. */
export function normalizeIndexer(raw: any): ProwlarrIndexer {
  return {
    id: Number(raw?.id),
    name: String(raw?.name ?? "unknown"),
    enable: raw?.enable === true,
    protocol: typeof raw?.protocol === "string" ? raw.protocol : "torrent",
    // The capability tree nests subcategories; the filter UI wants a flat list
    // because releases are tagged with either a parent or a child id.
    categories: dedupeCategories(flattenCategories(raw?.capabilities?.categories)),
  };
}

/**
 * Prowlarr release resources → the contract's result shape. Entries without a
 * guid or title are dropped (they cannot be grabbed or displayed), and the API
 * key is stripped from `downloadUrl` so no secret reaches the browser.
 */
export function normalizeReleases(raw: unknown): ProwlarrRelease[] {
  if (!Array.isArray(raw)) return [];
  const out: ProwlarrRelease[] = [];
  for (const r of raw as any[]) {
    const guid = typeof r?.guid === "string" ? r.guid : "";
    const title = typeof r?.title === "string" ? r.title.trim() : "";
    const indexerId = Number(r?.indexerId);
    if (!guid || !title || !Number.isInteger(indexerId)) continue;
    const infoUrl = httpUrl(r?.infoUrl);
    // Public indexers (TPB, Knaben...) put the real magnet in `guid` and a
    // Prowlarr proxy link (with the API key) in `magnetUrl`.
    const magnet = magnetUrl(r?.magnetUrl) ?? magnetUrl(guid);
    const downloadUrl = stripApiKey(r?.downloadUrl) ?? (magnet ? undefined : stripApiKey(r?.magnetUrl));
    out.push({
      guid,
      indexerId,
      indexer: typeof r?.indexer === "string" ? r.indexer : "unknown",
      title,
      size: numOrNull(r?.size),
      // Usenet releases carry no swarm counts at all; null, not 0, says so.
      seeders: numOrNull(r?.seeders),
      leechers: numOrNull(r?.leechers),
      protocol: r?.protocol === "usenet" ? "usenet" : "torrent",
      publishDate: typeof r?.publishDate === "string" ? r.publishDate : null,
      // Only the categories the release is actually in — not their children.
      categories: dedupeCategories(topLevelCategories(r?.categories)),
      ...(infoUrl ? { infoUrl } : {}),
      ...(magnet ? { magnetUrl: magnet } : {}),
      ...(downloadUrl ? { downloadUrl } : {}),
    });
  }
  return out;
}

/** Strongest-seeded first; releases with no seeder count sort last. */
export function sortBySeeders(releases: ProwlarrRelease[]): ProwlarrRelease[] {
  return releases.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
}

/** Parse a comma-separated id list ("1, 2,3") into numbers, ignoring junk. */
export function parseIdList(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "") // Number("") is 0, which would add a phantom id 0
    .map((p) => Number(p))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

// --- helpers ---------------------------------------------------------------

function topLevelCategories(cats: unknown): ProwlarrCategory[] {
  if (!Array.isArray(cats)) return [];
  return cats
    .filter((c: any) => Number.isInteger(Number(c?.id)))
    .map((c: any) => ({ id: Number(c.id), name: String(c?.name ?? c.id) }));
}

function flattenCategories(cats: unknown): ProwlarrCategory[] {
  const out: ProwlarrCategory[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const c of list as any[]) {
      if (Number.isInteger(Number(c?.id))) out.push({ id: Number(c.id), name: String(c?.name ?? c.id) });
      walk(c?.subCategories);
    }
  };
  walk(cats);
  return out;
}

function dedupeCategories(cats: ProwlarrCategory[]): ProwlarrCategory[] {
  const byId = new Map<number, ProwlarrCategory>();
  for (const c of cats) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function numOrNull(v: unknown): number | null {
  // Guard the empty cases first: Number(null) and Number("") are both 0, which
  // would report "no seeders" as "zero seeders" — a different claim.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

function magnetUrl(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("magnet:?") ? v : undefined;
}

/** Prowlarr's download proxy URL embeds the API key — never leak it outward. */
function stripApiKey(v: unknown): string | undefined {
  const url = httpUrl(v);
  if (!url) return undefined;
  const u = new URL(url);
  u.searchParams.delete("apikey");
  return u.toString();
}
