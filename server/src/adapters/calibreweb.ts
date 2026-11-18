import { httpJson, basicAuth, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Calibre-Web, READ-ONLY: health and "is this book in the library?" over its
 * OPDS feed (HTTP Basic auth, secret = "username:password"; enable OPDS and use
 * a normal reader account).
 *
 * Deliberately no import. Calibre-Web has no watched ingest folder: the library
 * is a Calibre `metadata.db` plus a folder tree Calibre-Web owns, and the only
 * supported ways in are its UI upload or `calibredb add` (both rewrite
 * metadata.db). Dropping files into that tree from outside leaves the database
 * out of step with the disk, so TorHQ's intake imports into Kavita instead and
 * only asks Calibre-Web whether a title is already held.
 */
export class CalibreWebAdapter implements ServiceAdapter {
  readonly kind = "calibreweb";
  readonly status = "functional" as const;
  constructor(private cfg: AdapterConfig) {}

  private hdr() { return { authorization: basicAuth(this.cfg.secret), accept: "application/atom+xml" }; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      await httpJson(this.cfg.baseUrl, "/opds/", { headers: this.hdr() });
      return { healthy: true, detail: "OPDS reachable", latencyMs: Date.now() - start };
    } catch (e) {
      const detail = e instanceof HttpError && e.statusCode === 401
        ? "the username:password was rejected (is OPDS enabled for this account?)"
        : (e as Error).message;
      return { healthy: false, detail, latencyMs: Date.now() - start };
    }
  }

  /** Titles in the library matching a search term. */
  async searchTitles(term: string): Promise<string[]> {
    const feed = await httpJson<string>(this.cfg.baseUrl, `/opds/search/${encodeURIComponent(term)}`, { headers: this.hdr() });
    return parseOpdsTitles(typeof feed === "string" ? feed : "");
  }
}

const decode = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&amp;/g, "&");

/** Entry titles from an OPDS/Atom feed (the feed's own title is not inside an entry). */
export function parseOpdsTitles(xml: string): string[] {
  const out: string[] = [];
  for (const entry of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(entry[0]);
    if (t?.[1]) out.push(decode(t[1].trim()));
  }
  return out;
}
