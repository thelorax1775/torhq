import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * General web search — the "look it up on the open web" widget that sits next
 * to the torrent-index search. See `WebSearchExtra` in config/extra.ts for the
 * four providers. Google's HTML search page is never scraped: it blocks
 * server-side fetches and scraping it would violate Google's terms.
 *
 * Three of the providers answer here, on the server. The fourth, `widget`, does
 * not: it is Google's own embeddable Programmable Search Engine, which runs in
 * the browser. All this adapter does for it is hand the search-engine id to the
 * page — there is no request to make and therefore nothing that can fail
 * server-side, which is exactly why it needs no API key and has no quota.
 *
 * A configured provider that is missing credentials, rate-limited, or simply
 * down never fails the request: the adapter falls back to `link` behaviour and
 * reports why in `degraded`, so the widget is never dead.
 */
export interface WebResult {
  title: string;
  url: string;
  displayUrl?: string;
  snippet?: string;
}

/** A one-click "search this term on <site>" URL handed to the browser. */
export interface WebLink {
  label: string;
  url: string;
}

export interface WebSearchResponse {
  provider: "link" | "widget" | "google" | "searxng";
  /** Inline results; always empty for the `link` and `widget` providers. */
  results: WebResult[];
  /** Open-in-a-tab query URLs; always present so the widget is never useless. */
  links: WebLink[];
  /**
   * Google Programmable Search engine id, set only for the `widget` provider.
   * The browser needs it to load Google's embed; it is public by design (it
   * appears in the script URL of every site using PSE), so unlike the API key
   * it is safe to send to the page.
   */
  cx?: string;
  /** Set when a configured provider failed and TorHQ fell back to links. */
  degraded?: string;
}

export type WebSearchProvider = WebSearchResponse["provider"];

/** Always offered, needs no configuration, and is a link — not a scrape. */
const GOOGLE_LINK_TEMPLATE = "https://www.google.com/search?q={q}";
const GOOGLE_API_BASE = "https://www.googleapis.com";
/** Google's free Programmable Search tier caps a page at 10 results. */
const GOOGLE_PAGE_SIZE = 10;
const SEARXNG_MAX_RESULTS = 20;
/** Bound on user-supplied shortcuts, so a pasted file can't flood the UI. */
const MAX_LINK_TEMPLATES = 12;
const MAX_SNIPPET = 400;

export class WebSearchAdapter implements ServiceAdapter {
  readonly kind = "websearch";
  readonly status = "functional" as const;
  readonly provider: WebSearchProvider;
  private readonly googleCx: string | null;
  private readonly googleApiKey: string | null;
  private readonly searxngUrl: string | null;
  private readonly linkTemplates: string | null;

  constructor(protected cfg: AdapterConfig) {
    const extra = (cfg.extra ?? {}) as Record<string, unknown>;
    this.provider = isProvider(extra.provider) ? extra.provider : "link";
    this.googleCx = str(extra.googleCx) ?? null;
    this.googleApiKey = str(extra.googleApiKey) ?? null;
    // The SearXNG instance lives in `extra`, but fall back to the service's own
    // baseUrl so a config that only filled the standard field still works.
    this.searxngUrl = str(extra.searxngUrl) ?? str(cfg.baseUrl) ?? null;
    this.linkTemplates = str(extra.linkTemplates) ?? null;
  }

  async health(): Promise<HealthResult> {
    if (this.provider === "link") {
      return { healthy: true, detail: "link provider (no backend call)" };
    }
    if (this.provider === "widget") {
      // Nothing to probe: the embed is fetched by the browser, not by TorHQ.
      return this.googleCx
        ? { healthy: true, detail: "Google Programmable Search widget configured (renders in the browser)" }
        : { healthy: false, detail: this.widgetConfigError()! };
    }
    if (this.provider === "google") {
      const missing = this.googleConfigError();
      // Deliberately not probed: the free Programmable Search tier allows only
      // 100 queries a day, and health is polled far more often than that.
      return missing
        ? { healthy: false, detail: missing }
        : { healthy: true, detail: "google Programmable Search configured (not probed — 100 queries/day quota)" };
    }
    if (!this.searxngUrl) return { healthy: false, detail: "SearXNG URL is not set" };
    const start = Date.now();
    try {
      await this.searxng("torhq");
      return { healthy: true, detail: "searxng JSON API reachable", latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /**
   * Search the open web. `links` is built first and returned whatever happens,
   * so a provider outage degrades the widget instead of breaking it.
   */
  async search(query: string): Promise<WebSearchResponse> {
    const links = buildLinks(query, this.linkTemplates);
    if (this.provider === "link") return { provider: "link", results: [], links };

    // The widget renders client-side, so the query is not searched here at all;
    // the response only carries what the page needs to mount Google's embed.
    if (this.provider === "widget") {
      const missing = this.widgetConfigError();
      return missing
        ? { provider: "link", results: [], links, degraded: `${missing} — showing links only` }
        : { provider: "widget", results: [], links, cx: this.googleCx! };
    }

    const configError = this.provider === "google" ? this.googleConfigError() : this.searxngConfigError();
    if (configError) return { provider: "link", results: [], links, degraded: `${configError} — showing links only` };

    try {
      const results = this.provider === "google" ? await this.google(query) : await this.searxng(query);
      return { provider: this.provider, results, links };
    } catch (e) {
      return { provider: "link", results: [], links, degraded: degradedReason(this.provider, e as Error) };
    }
  }

  // --- providers -----------------------------------------------------------

  private widgetConfigError(): string | null {
    return this.googleCx ? null : "The Google search widget needs a search-engine id (cx)";
  }

  private googleConfigError(): string | null {
    if (!this.googleApiKey) return "Google Programmable Search needs an API key";
    if (!this.googleCx) return "Google Programmable Search needs a search-engine id (cx)";
    return null;
  }

  private searxngConfigError(): string | null {
    return this.searxngUrl ? null : "SearXNG URL is not set";
  }

  /** Google Programmable Search JSON API — the supported, non-scraping path. */
  private async google(query: string): Promise<WebResult[]> {
    const res = await httpJson<{ items?: any[] }>(GOOGLE_API_BASE, "/customsearch/v1", {
      query: { key: this.googleApiKey!, cx: this.googleCx!, q: query, num: GOOGLE_PAGE_SIZE },
      timeoutMs: 10000,
    });
    return (Array.isArray(res?.items) ? res.items : [])
      .map((i) => toResult(i?.title, i?.link, i?.displayLink, i?.snippet))
      .filter((r): r is WebResult => r !== null);
  }

  /** A self-hosted SearXNG instance's JSON API — no key, no quota. */
  private async searxng(query: string): Promise<WebResult[]> {
    const res = await httpJson<{ results?: any[] }>(this.searxngUrl!, "/search", {
      query: { q: query, format: "json" },
      timeoutMs: 10000,
    });
    if (!res || !Array.isArray(res.results)) {
      // SearXNG ships with the JSON format disabled; say so instead of "no results".
      throw new Error("SearXNG did not return JSON — add `json` to search.formats in its settings.yml");
    }
    return res.results
      .slice(0, SEARXNG_MAX_RESULTS)
      .map((i) => toResult(i?.title, i?.url, i?.pretty_url ?? i?.parsed_url?.[1], i?.content))
      .filter((r): r is WebResult => r !== null);
  }
}

// --- link building (pure, unit-testable without network) -------------------

/**
 * Build the always-present "open this query on <site>" links: Google first,
 * then the user's own `Label|https://example.com/search?q={q}` lines. Templates
 * that aren't http(s) are dropped — these URLs are handed straight to the
 * browser, so a `javascript:` line must never survive.
 */
export function buildLinks(query: string, templates?: string | null): WebLink[] {
  const q = encodeURIComponent(query.trim());
  const links: WebLink[] = [{ label: "Google", url: GOOGLE_LINK_TEMPLATE.replaceAll("{q}", q) }];
  for (const line of (templates ?? "").split(/\r?\n/)) {
    if (links.length >= MAX_LINK_TEMPLATES) break;
    const sep = line.indexOf("|");
    if (sep <= 0) continue;
    const label = line.slice(0, sep).trim();
    const template = line.slice(sep + 1).trim();
    if (!label || !template) continue;
    const url = template.replaceAll("{q}", q);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    links.push({ label: label.slice(0, 64), url });
  }
  return links;
}

// --- helpers ---------------------------------------------------------------

/** Turn a provider hit into a result, or null when it has no usable link. */
function toResult(title: unknown, url: unknown, displayUrl: unknown, snippet: unknown): WebResult | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      title: typeof title === "string" && title.trim() ? title.trim() : parsed.hostname,
      url,
      displayUrl: typeof displayUrl === "string" && displayUrl ? displayUrl : parsed.hostname,
      ...(typeof snippet === "string" && snippet.trim() ? { snippet: snippet.trim().slice(0, MAX_SNIPPET) } : {}),
    };
  } catch {
    return null;
  }
}

/** Human-readable "why you're looking at links" line for the widget. */
function degradedReason(provider: WebSearchProvider, err: Error): string {
  const label = provider === "searxng" ? "SearXNG" : "Google Programmable Search";
  if (err instanceof HttpError && (err.statusCode === 429 || err.statusCode === 403)) {
    return `${label} quota exceeded or rate-limited — showing links only`;
  }
  return `${label} failed (${err.message}) — showing links only`;
}

function isProvider(v: unknown): v is WebSearchProvider {
  return v === "link" || v === "widget" || v === "google" || v === "searxng";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
