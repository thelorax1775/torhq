import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

export interface AbsLibrary { id: string; name: string; mediaType: string }

/**
 * Audiobookshelf API. secret = an API token (ABS Settings -> API Keys, or a
 * user token), sent as `Authorization: Bearer`. Health makes an AUTHORISED
 * call (POST /api/authorize) so a wrong or revoked token shows as unhealthy,
 * not just "the server answers".
 *
 * TorHQ only ever reads libraries and asks for a scan; ABS owns its own
 * metadata. Files are placed by TorHQ's previewed intake (Author/Title/).
 * `extra.libraryId` pins the library to search/scan; without it the first
 * book library is used.
 */
export class AudiobookshelfAdapter implements ServiceAdapter {
  readonly kind = "audiobookshelf";
  readonly status = "functional" as const;
  constructor(private cfg: AdapterConfig) {}

  private hdr() { return { authorization: `Bearer ${this.cfg.secret}` }; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const r = await httpJson<{ user?: { username?: string }; serverSettings?: { version?: string } }>(
        this.cfg.baseUrl, "/api/authorize", { method: "POST", headers: this.hdr() },
      );
      return {
        healthy: true, version: r?.serverSettings?.version,
        detail: r?.user?.username ? `authorised as ${r.user.username}` : "authorised", latencyMs: Date.now() - start,
      };
    } catch (e) {
      const detail = e instanceof HttpError && (e.statusCode === 401 || e.statusCode === 403)
        ? "the API token was rejected" : (e as Error).message;
      return { healthy: false, detail, latencyMs: Date.now() - start };
    }
  }

  async libraries(): Promise<AbsLibrary[]> {
    const r = await httpJson<{ libraries?: AbsLibrary[] }>(this.cfg.baseUrl, "/api/libraries", { headers: this.hdr() });
    return (r?.libraries ?? []).map((l) => ({ id: l.id, name: l.name, mediaType: l.mediaType }));
  }

  /** The configured library, else the first one that holds books (not podcasts). */
  async resolveLibraryId(libraryId?: string): Promise<string> {
    const wanted = libraryId ?? this.configuredLibraryId();
    if (wanted) return wanted;
    const lib = (await this.libraries()).find((l) => l.mediaType === "book");
    if (!lib) throw new Error("Audiobookshelf has no book library");
    return lib.id;
  }

  /** Titles the library holds for a search term, as "Title" and "Title Author", for the hub's availability check. */
  async searchTitles(term: string, libraryId?: string): Promise<string[]> {
    const id = await this.resolveLibraryId(libraryId);
    const r = await httpJson<{ book?: Array<{ libraryItem?: { media?: { metadata?: { title?: string; authorName?: string } } } }> }>(
      this.cfg.baseUrl, `/api/libraries/${encodeURIComponent(id)}/search`, { query: { q: term, limit: 12 }, headers: this.hdr() },
    );
    const out: string[] = [];
    for (const b of r?.book ?? []) {
      const m = b.libraryItem?.media?.metadata;
      if (!m?.title) continue;
      for (const n of [m.title, m.authorName ? `${m.title} ${m.authorName}` : ""]) if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }

  /** Ask ABS to rescan a library (the new folder appears once it finishes). */
  async scanLibrary(libraryId?: string): Promise<void> {
    const id = await this.resolveLibraryId(libraryId);
    await httpJson(this.cfg.baseUrl, `/api/libraries/${encodeURIComponent(id)}/scan`, { method: "POST", headers: this.hdr() });
  }

  private configuredLibraryId(): string | undefined {
    const raw = this.cfg.extra?.libraryId;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  }
}
