import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Kavita API. FUNCTIONAL: health via /api/health; library scan is triggered by
 * Kavita's own folder watcher after atomic import. secret = API key; Kavita
 * exchanges it for a JWT via /api/Plugin/authenticate.
 * The scan API requires a numeric libraryId (configured per destination library);
 * when absent, Kavita's directory watcher picks up the new files — documented.
 */
export class KavitaAdapter implements ServiceAdapter {
  readonly kind = "kavita";
  readonly status = "functional" as const;
  private jwt: string | null = null;
  constructor(private cfg: AdapterConfig) {}

  private async token(): Promise<string> {
    if (this.jwt) return this.jwt;
    const r = await httpJson<{ token: string }>(this.cfg.baseUrl, "/api/Plugin/authenticate", {
      method: "POST", query: { apiKey: this.cfg.secret, pluginName: "torhq" },
    });
    this.jwt = r.token;
    return this.jwt;
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const r = await httpJson<any>(this.cfg.baseUrl, "/api/health");
      return { healthy: true, detail: typeof r === "string" ? r : "ok", latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /**
   * Optional explicit scan when a libraryId is configured. When called with no
   * argument, the id is taken from the service's `extra.libraryId` config; if
   * neither is present we rely on Kavita's own folder watcher.
   */
  async scanLibrary(libraryId?: number): Promise<void> {
    const id = libraryId ?? this.configuredLibraryId();
    if (!id) return; // rely on Kavita's folder watcher
    const jwt = await this.token();
    await httpJson(this.cfg.baseUrl, "/api/Library/scan", {
      method: "POST", headers: { authorization: `Bearer ${jwt}` }, query: { libraryId: id },
    });
  }

  /**
   * Titles Kavita holds that match a search term (Kavita's own search, series
   * level). Used only to answer "do we already have it?" for the hub.
   */
  async searchTitles(term: string): Promise<string[]> {
    const get = async () => httpJson<{ series?: Array<{ name?: string; originalName?: string; localizedName?: string }> }>(
      this.cfg.baseUrl, "/api/Search/search",
      { query: { queryString: term }, headers: { authorization: `Bearer ${await this.token()}` } },
    );
    let res;
    try {
      res = await get();
    } catch (e) {
      if (!(e instanceof HttpError) || e.statusCode !== 401) throw e;
      this.jwt = null; // the JWT expired: authenticate again, once
      res = await get();
    }
    const out: string[] = [];
    for (const s of res?.series ?? []) {
      for (const n of [s.name, s.originalName, s.localizedName]) if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }

  private configuredLibraryId(): number | undefined {
    const raw = this.cfg.extra?.libraryId;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
}
