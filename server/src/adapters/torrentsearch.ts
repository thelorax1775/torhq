import { request } from "undici";
import { parse } from "node-html-parser";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Generic torrent-index scraper (KickassTorrents-style layout by default).
 *
 * TorHQ has no first-party relationship with any public torrent site, and those
 * "unblock" proxy mirrors rot constantly (domain changes, markup drift, Cloudflare
 * challenges). So this adapter is **configuration-driven, not hardcoded**: the base
 * URL, the search-path template, and every CSS selector live in the service's
 * `extra` config and can be changed without touching code. An optional solver URL
 * lets it get through Cloudflare's browser check when a mirror requires it: any
 * service speaking FlareSolverr's `/v1` API will do — FlareSolverr itself, or a
 * drop-in such as Byparr, which clears challenges FlareSolverr no longer can.
 *
 * It only *reads* search pages and extracts magnet links. Pushing a magnet to a
 * download client is a separate, explicit action (see the qBittorrent adapter and
 * the /api/search/grab route) — this adapter never starts a download itself.
 */
export interface TorrentResult {
  title: string;
  magnet: string;
  seeders: number | null;
  leechers: number | null;
  sizeBytes: number | null;
  detailUrl: string | null;
}

/** Selector/URL profile with sane KAT-mirror defaults; all overridable via extra. */
export interface SiteProfile {
  /** `{query}` and `{page}` are substituted (query is URL-encoded). */
  searchPath: string;
  rowSelector: string;
  titleSelector: string;
  magnetSelector: string;
  seedersSelector: string;
  leechersSelector: string;
  sizeSelector: string;
  detailLinkSelector: string;
  /** When true, magnets live on each result's detail page, not the search page. */
  magnetOnDetailPage: boolean;
}

export const DEFAULT_PROFILE: SiteProfile = {
  searchPath: "/usearch/{query}/{page}/",
  rowSelector: "table.data tr.odd, table.data tr.even",
  titleSelector: "a.cellMainLink",
  magnetSelector: "a[href^='magnet:']",
  seedersSelector: "td.green.center",
  leechersSelector: "td.red.center",
  sizeSelector: "td.nobr.center",
  detailLinkSelector: "a.cellMainLink",
  magnetOnDetailPage: false,
};

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_DETAIL_FETCHES = 10; // cap the N+1 when magnets are only on detail pages
/**
 * Two minutes, because a browser-driving solver needs it. FlareSolverr either
 * answered inside a minute or failed, so 60s used to be plenty; Byparr launches
 * a real browser per challenge and a cold one regularly runs past that.
 */
const DEFAULT_SOLVER_TIMEOUT_MS = 120_000;
/** Let the solver's own deadline expire first, so we get its error, not a hang-up. */
const SOLVER_GRACE_MS = 5_000;
/**
 * A liveness check on the solver itself — not on the mirror behind it. Answering
 * "is this source usable?" must never cost a Cloudflare solve; see health().
 */
const SOLVER_PING_TIMEOUT_MS = 5_000;

export class TorrentSearchAdapter implements ServiceAdapter {
  readonly kind = "torrentsearch";
  readonly status = "functional" as const;
  private readonly profile: SiteProfile;
  private readonly flaresolverrUrl: string | null;
  private readonly solverTimeoutMs: number;

  constructor(private cfg: AdapterConfig) {
    const extra = (cfg.extra ?? {}) as Record<string, unknown>;
    this.profile = {
      searchPath: str(extra.searchPath) ?? DEFAULT_PROFILE.searchPath,
      rowSelector: str(extra.rowSelector) ?? DEFAULT_PROFILE.rowSelector,
      titleSelector: str(extra.titleSelector) ?? DEFAULT_PROFILE.titleSelector,
      magnetSelector: str(extra.magnetSelector) ?? DEFAULT_PROFILE.magnetSelector,
      seedersSelector: str(extra.seedersSelector) ?? DEFAULT_PROFILE.seedersSelector,
      leechersSelector: str(extra.leechersSelector) ?? DEFAULT_PROFILE.leechersSelector,
      sizeSelector: str(extra.sizeSelector) ?? DEFAULT_PROFILE.sizeSelector,
      detailLinkSelector: str(extra.detailLinkSelector) ?? DEFAULT_PROFILE.detailLinkSelector,
      magnetOnDetailPage: extra.magnetOnDetailPage === true,
    };
    this.flaresolverrUrl = str(extra.flaresolverrUrl) ?? null;
    this.solverTimeoutMs = num(extra.solverTimeoutMs) ?? DEFAULT_SOLVER_TIMEOUT_MS;
  }

  /**
   * Is this source usable?
   *
   * When a solver is configured this deliberately does NOT fetch the mirror.
   * Every fetch through the solver launches a real browser and takes 15-45s, and
   * this is called by a page that re-polls on a timer — so probing the mirror
   * meant starting a browser a minute, forever, with solves overlapping. That is
   * enough to exhaust a small Docker host, and it did.
   *
   * The cheap question is the one worth asking: is the solver up? If it is, the
   * source is usable, and a real search reports anything the mirror itself gets
   * wrong. Without a solver a direct fetch is cheap, so it stays.
   */
  async health(): Promise<HealthResult> {
    const start = Date.now();
    if (this.flaresolverrUrl) {
      try {
        await pingSolver(this.flaresolverrUrl);
        return {
          healthy: true,
          detail: "challenge solver reachable — the mirror itself is exercised on a real search",
          latencyMs: Date.now() - start,
        };
      } catch (e) {
        return {
          healthy: false,
          detail: `challenge solver unreachable: ${(e as Error).message}`,
          latencyMs: Date.now() - start,
        };
      }
    }
    try {
      await this.fetchHtml(this.cfg.baseUrl);
      return { healthy: true, detail: "reachable", latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Search the configured site and return normalized magnet results. */
  async search(query: string, page = 1): Promise<TorrentResult[]> {
    const url = this.searchUrl(query, page);
    const html = await this.fetchHtml(url);
    const rows = parseSearchResults(html, this.profile, this.baseWithSlash());
    const results = rows.filter((r) => r.magnet);

    // When magnets live on detail pages, resolve them for the rows still missing one.
    if (this.profile.magnetOnDetailPage) {
      const needDetail = rows.filter((r) => !r.magnet && r.detailUrl).slice(0, MAX_DETAIL_FETCHES);
      for (const r of needDetail) {
        try {
          const magnet = await this.magnetFromDetail(r.detailUrl!);
          if (magnet) results.push({ ...r, magnet });
        } catch {
          /* skip results whose detail page fails; a partial list beats none */
        }
      }
    }
    return results;
  }

  // --- internals -----------------------------------------------------------

  private searchUrl(query: string, page: number): string {
    const path = this.profile.searchPath
      .replace("{query}", encodeURIComponent(query.trim()))
      .replace("{page}", String(Math.max(1, page)));
    return new URL(path.replace(/^\//, ""), this.baseWithSlash()).toString();
  }

  private baseWithSlash(): string {
    return this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
  }

  private async magnetFromDetail(detailUrl: string): Promise<string | null> {
    const html = await this.fetchHtml(detailUrl);
    const el = parse(html).querySelector(this.profile.magnetSelector);
    const href = el?.getAttribute("href") ?? "";
    return href.startsWith("magnet:") ? href : null;
  }

  private async fetchHtml(url: string): Promise<string> {
    const html = this.flaresolverrUrl
      ? await this.fetchViaSolver(url)
      : await this.fetchDirect(url);
    assertNotChallenge(html, url);
    return html;
  }

  private async fetchDirect(url: string): Promise<string> {
    const res = await request(url, {
      method: "GET",
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" },
      headersTimeout: 15000,
      bodyTimeout: 15000,
      maxRedirections: 3,
    });
    const text = await readCapped(res.body);
    if (res.statusCode >= 400) {
      const hint = res.statusCode === 403 || res.statusCode === 503
        ? " (likely a Cloudflare block — set a solver URL in this service's config)"
        : "";
      throw new Error(`torrent site returned HTTP ${res.statusCode}${hint}`);
    }
    return text;
  }

  /**
   * Route the fetch through the challenge solver. The wire format is
   * FlareSolverr's `/v1`, which Byparr and the other drop-ins also implement, so
   * this speaks to whichever one the URL points at.
   *
   * Our own socket timeouts sit above the solver's own budget: the solver
   * answers a timed-out solve with a JSON error explaining what it was doing,
   * and that is worth far more than an aborted socket.
   */
  private async fetchViaSolver(url: string): Promise<string> {
    const res = await request(solverEndpoint(this.flaresolverrUrl!), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: this.solverTimeoutMs }),
      headersTimeout: this.solverTimeoutMs + SOLVER_GRACE_MS,
      bodyTimeout: this.solverTimeoutMs + SOLVER_GRACE_MS,
    });
    const text = await readCapped(res.body);
    if (res.statusCode >= 400) throw new Error(`the challenge solver returned HTTP ${res.statusCode}`);
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw new Error("the challenge solver returned a non-JSON response"); }
    if (parsed?.status !== "ok" || typeof parsed?.solution?.response !== "string") {
      throw new Error(`the challenge solver could not fetch the page: ${parsed?.message ?? "unknown error"}`);
    }
    return parsed.solution.response as string;
  }
}

// --- parsing (pure, unit-testable without network) -------------------------

/**
 * Extract results from a search-results HTML page using the given profile.
 * Rows without a title are dropped; `magnet` is "" when the page doesn't carry
 * one (the caller then resolves it from the detail page). Detail links are kept
 * only when same-origin as `baseUrl` (SSRF guard).
 */
export function parseSearchResults(html: string, profile: SiteProfile, baseUrl: string): TorrentResult[] {
  const root = parse(html);
  const out: TorrentResult[] = [];
  for (const row of root.querySelectorAll(profile.rowSelector)) {
    const title = row.querySelector(profile.titleSelector)?.textContent?.trim();
    if (!title) continue;
    const magnet = row.querySelector(profile.magnetSelector)?.getAttribute("href") ?? "";
    const detailHref = row.querySelector(profile.detailLinkSelector)?.getAttribute("href") ?? null;
    out.push({
      title,
      magnet: magnet.startsWith("magnet:") ? magnet : "",
      seeders: parseIntOrNull(row.querySelector(profile.seedersSelector)?.textContent),
      leechers: parseIntOrNull(row.querySelector(profile.leechersSelector)?.textContent),
      sizeBytes: parseSize(row.querySelector(profile.sizeSelector)?.textContent),
      detailUrl: detailHref ? absolutizeSameOrigin(detailHref, baseUrl) : null,
    });
  }
  return out;
}

function absolutizeSameOrigin(href: string, baseUrl: string): string | null {
  try {
    const abs = new URL(href, baseUrl);
    return abs.host === new URL(baseUrl).host ? abs.toString() : null;
  } catch {
    return null;
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * Build the solver's `/v1` endpoint from a configured base URL, tolerating both
 * `http://host:8191` and `http://host:8191/`. Getting this wrong silently POSTs
 * to the wrong path and reads as "the solver is broken".
 */
/**
 * Confirm the solver is up, in one cheap round-trip to its root.
 *
 * Any HTTP reply at all is the answer we want — the question is whether the
 * service is listening and serving, not whether it can defeat a challenge. The
 * deeper endpoints are traps for a check that runs on a timer: Byparr's
 * `/health` drives a real browser and costs ~6s, while `sessions.list` (which
 * FlareSolverr answers) returns 500 there. `GET /` costs about 3ms on both.
 * A real search is what reports an unhealthy solver, and it reports it properly.
 */
async function pingSolver(baseUrl: string): Promise<void> {
  const res = await request(baseUrl, {
    method: "GET",
    headersTimeout: SOLVER_PING_TIMEOUT_MS,
    bodyTimeout: SOLVER_PING_TIMEOUT_MS,
  });
  await readCapped(res.body);
}

export function solverEndpoint(baseUrl: string): string {
  return new URL("v1", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").toString();
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function parseIntOrNull(text: string | undefined): number | null {
  if (!text) return null;
  const n = parseInt(text.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4,
};

/** Parse "1.7 GB", "700 MB", "1,024 KiB", "1,5 GB" → bytes. */
export function parseSize(text: string | undefined): number | null {
  if (!text) return null;
  // A comma before exactly three digits is a thousands separator; any other
  // comma between digits is a decimal point (e.g. European "1,5 GB").
  const normalized = text.replace(/,(?=\d{3}(?!\d))/g, "").replace(/(\d),(\d)/g, "$1.$2");
  const m = normalized.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase().replace("i", ""); // KiB -> kb
  const mult = SIZE_UNITS[unit];
  if (!Number.isFinite(value) || !mult) return null;
  return Math.round(value * mult);
}

async function readCapped(body: import("undici").Dispatcher.ResponseData["body"]): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_HTML_BYTES) { body.destroy(); break; }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Detect a Cloudflare/anti-bot interstitial so we fail loudly, not silently. */
function assertNotChallenge(html: string, url: string): void {
  const markers = ["Just a moment", "cf-browser-verification", "Attention Required! | Cloudflare", "Checking your browser before"];
  const lower = html.slice(0, 4000);
  if (markers.some((m) => lower.includes(m))) {
    throw new Error(`blocked by an anti-bot challenge at ${url} — configure a solver URL or try another mirror`);
  }
}
