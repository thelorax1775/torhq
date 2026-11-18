import { z } from "zod";

/**
 * Typed, per-kind "extra" service configuration. Only the adapter settings TorHQ
 * actually needs are configurable — no arbitrary raw JSON as the primary UX.
 *
 * Secret extra fields (e.g. the slskd webhook token) are **write-only**: they are
 * stored server-side, retained when a save omits them, and never returned to the
 * browser (see `safeExtra`), only surfaced as a boolean `<key>Set` flag.
 */
const KavitaExtra = z.object({
  // Numeric Kavita libraryId; when set, intake triggers an explicit scan of it.
  libraryId: z.coerce.number().int().positive().optional(),
});

const AudiobookshelfExtra = z.object({
  // ABS library id (a uuid) to search and scan; blank = the first book library.
  libraryId: z.string().trim().max(64).optional(),
});

const SlskdExtra = z.object({
  // Shared token that authenticates the /webhooks/slskd completed-download hook.
  webhookToken: z.string().min(8).max(256).optional(),
});

// Torrent-index scraper: all site-specific knobs so a rotting mirror can be
// re-pointed without a code change. Empty/omitted fields fall back to the
// adapter's KAT-style defaults.
//
// `flaresolverrUrl` points at any FlareSolverr-compatible challenge solver —
// FlareSolverr itself, or a drop-in like Byparr that speaks the same /v1 API.
// The key keeps its original name so existing configs keep working; what it
// names is the protocol, not the implementation.
const TorrentSearchExtra = z.object({
  searchPath: z.string().max(256).optional(),
  rowSelector: z.string().max(256).optional(),
  titleSelector: z.string().max(256).optional(),
  magnetSelector: z.string().max(256).optional(),
  seedersSelector: z.string().max(256).optional(),
  leechersSelector: z.string().max(256).optional(),
  sizeSelector: z.string().max(256).optional(),
  detailLinkSelector: z.string().max(256).optional(),
  magnetOnDetailPage: z.coerce.boolean().optional(),
  flaresolverrUrl: z.string().url().max(512).optional(),
  // How long to let the solver work before giving up. FlareSolverr answered
  // within a minute or failed; a browser-driving solver like Byparr routinely
  // needs longer on a cold start, so the old fixed 60s cut off solves that
  // would have succeeded.
  solverTimeoutMs: z.coerce.number().int().min(10_000).max(300_000).optional(),
});

// Prowlarr is TorHQ's primary search backend: it already aggregates every
// indexer you run, so there is nothing site-specific to configure — only which
// indexers to query by default and how many results to keep.
const ProwlarrExtra = z.object({
  // Comma-separated indexer ids to search by default; blank = all enabled.
  defaultIndexerIds: z.string().max(256).optional(),
  searchLimit: z.coerce.number().int().min(10).max(500).optional(),
});

/**
 * General web search. Four providers, in increasing order of setup cost:
 *  - `link`     — no backend call at all; TorHQ builds Google/other query URLs
 *                 you open in a tab. Always available, nothing to configure.
 *  - `widget`   — Google's own Programmable Search Engine widget, embedded in
 *                 the page. Needs only the search-engine id (`cx`): no API key,
 *                 no daily quota, and the results are Google's own rendering.
 *                 The browser talks to Google directly, so the query and the
 *                 viewer's IP go to Google — which is also true of every other
 *                 way of putting Google results on a page.
 *  - `google`   — Google Programmable Search JSON API (needs an API key + the
 *                 search-engine id `cx`). Results render inside TorHQ, styled
 *                 like the rest of the app, but the free tier caps at 100
 *                 queries a day.
 *  - `searxng`  — a self-hosted SearXNG instance's JSON API. No key, no quota.
 * Google's HTML endpoint is deliberately NOT scraped: it blocks server-side
 * fetches and doing so would violate their terms.
 */
const WebSearchExtra = z.object({
  provider: z.enum(["link", "widget", "google", "searxng"]).optional(),
  // google provider
  googleCx: z.string().max(128).optional(),
  googleApiKey: z.string().min(8).max(256).optional(), // write-only
  // searxng provider
  searxngUrl: z.string().url().max(512).optional(),
  // Extra "search on <site>" shortcuts for the link provider, as a
  // newline-separated `Label|https://example.com/search?q={q}` list.
  linkTemplates: z.string().max(2048).optional(),
});

/**
 * Where an *arr should put things TorHQ adds to it, so the acquire flow doesn't
 * have to ask on every grab. Nothing here is secret, and nothing is required:
 * with no default saved the acquire page falls back to the *arr's first root
 * folder and first quality profile, and always shows which it picked.
 */
const ArrExtra = z.object({
  rootFolderPath: z.string().max(512).optional(),
  qualityProfileId: z.coerce.number().int().positive().optional(),
  // Lidarr only, where adding an artist is impossible without one.
  metadataProfileId: z.coerce.number().int().positive().optional(),
});

/**
 * Gemini. The API key itself is the service `secret` (encrypted at rest like
 * every other credential), so the only thing configurable here is which model
 * to use. It is a free-text field rather than an enum on purpose: model names
 * change faster than this file does, and the connection test enumerates what
 * the key can actually reach, so a wrong name is reported rather than guessed.
 */
const GeminiExtra = z.object({
  model: z.string().max(128).optional(),
});

const EXTRA_SCHEMAS: Partial<Record<string, z.ZodTypeAny>> = {
  gemini: GeminiExtra,
  radarr: ArrExtra,
  sonarr: ArrExtra,
  lidarr: ArrExtra,
  kavita: KavitaExtra,
  audiobookshelf: AudiobookshelfExtra,
  slskd: SlskdExtra,
  torrentsearch: TorrentSearchExtra,
  prowlarr: ProwlarrExtra,
  websearch: WebSearchExtra,
};

/** Fields that are secret/write-only per kind (never sent to the browser). */
const SECRET_EXTRA_KEYS: Record<string, string[]> = {
  slskd: ["webhookToken"],
  websearch: ["googleApiKey"],
};

/** Whether a service kind exposes any configurable extra settings. */
export function hasExtraConfig(kind: string): boolean {
  return kind in EXTRA_SCHEMAS;
}

/**
 * Validate submitted extra against the kind's schema and merge with existing:
 *  - non-secret fields are authoritative from the submission (omitting one clears it);
 *  - secret fields are retained from the existing config when the submission
 *    omits or blanks them, so the token survives an unrelated save.
 * Kinds without an extra schema ignore any submitted extra entirely.
 */
export function mergeExtra(
  kind: string,
  submitted: Record<string, unknown> | undefined,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const schema = EXTRA_SCHEMAS[kind];
  if (!schema) return {};
  if (submitted === undefined) return existing;
  const secretKeys = SECRET_EXTRA_KEYS[kind] ?? [];
  // A blank secret field means "keep the existing value", so strip it before
  // validation (an empty string would otherwise fail the field's constraints).
  const toParse: Record<string, unknown> = { ...submitted };
  for (const k of secretKeys) if (toParse[k] === "") delete toParse[k];
  const parsed = schema.parse(toParse) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (secretKeys.includes(k)) continue;
    if (v !== undefined) merged[k] = v;
  }
  for (const k of secretKeys) {
    const pv = parsed[k];
    if (pv !== undefined && pv !== "") merged[k] = pv;
    else if (existing[k] !== undefined) merged[k] = existing[k];
  }
  return merged;
}

/** Browser-safe projection: secret fields become a boolean `<key>Set` flag. */
export function safeExtra(kind: string, extra: Record<string, unknown>): Record<string, unknown> {
  const secretKeys = SECRET_EXTRA_KEYS[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (!secretKeys.includes(k)) out[k] = v;
  }
  for (const k of secretKeys) out[`${k}Set`] = !!extra[k];
  return out;
}
