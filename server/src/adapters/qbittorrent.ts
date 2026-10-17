import { request } from "undici";
import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, HealthResult, ServiceAdapter } from "./types.js";

/**
 * qBittorrent WebUI API v2. FUNCTIONAL: cookie login, torrent list by category,
 * transfer info, category management, and torrent control (pause/resume/
 * recheck/priority/category/delete).
 *
 * Control stops at the download client. TorHQ NEVER moves or renames
 * Radarr/Sonarr/Lidarr media — `deleteWithFiles` removes only the payload
 * qBittorrent itself still owns, and is always an explicit user action.
 */
export interface QbTorrent {
  hash: string;
  name: string;
  category: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  size: number;
  eta: number;
  savePath: string;
  ratio: number;
  /** Unix seconds, as qBittorrent reports it. */
  addedOn: number;
  tags: string[];
}

export class QbittorrentAdapter implements ServiceAdapter {
  readonly kind = "qbittorrent";
  readonly status = "functional" as const;
  private cookie: string | null = null;
  constructor(private cfg: AdapterConfig) {}

  private creds() {
    const [username, ...rest] = this.cfg.secret.split(":");
    return { username: username ?? "", password: rest.join(":") };
  }

  private async login(): Promise<void> {
    const { username, password } = this.creds();
    const base = this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
    const res = await request(new URL("api/v2/auth/login", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: this.cfg.baseUrl },
      body: new URLSearchParams({ username, password }).toString(),
    });
    const setCookie = res.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!raw) throw new Error("qBittorrent login failed (no SID cookie)");
    this.cookie = raw.split(";")[0]!;
  }

  private async authed<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    if (!this.cookie) await this.login();
    try {
      return await httpJson<T>(this.cfg.baseUrl, path, { headers: { cookie: this.cookie! }, query });
    } catch (e) {
      this.cookie = null; // retry once after re-login (SID may have expired)
      await this.login();
      return httpJson<T>(this.cfg.baseUrl, path, { headers: { cookie: this.cookie! }, query });
    }
  }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const v = await this.authed<string>("/api/v2/app/version");
      return { healthy: true, version: String(v), latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  async torrents(category?: string): Promise<QbTorrent[]> {
    const list = await this.authed<any[]>("/api/v2/torrents/info", category ? { category } : undefined);
    return list.map((t) => ({
      hash: t.hash, name: t.name, category: t.category, state: t.state,
      progress: t.progress, dlspeed: t.dlspeed, upspeed: t.upspeed, size: t.size, eta: t.eta,
      savePath: t.save_path ?? "", ratio: t.ratio ?? 0, addedOn: t.added_on ?? 0,
      // `tags` is a comma-separated string on the wire; an empty string means none.
      tags: String(t.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    }));
  }

  async transferInfo(): Promise<{ dl_info_speed: number; up_info_speed: number }> {
    return this.authed("/api/v2/transfer/info");
  }

  async categories(): Promise<Record<string, { name: string; savePath: string }>> {
    return this.authed("/api/v2/torrents/categories");
  }

  /** Application preferences; `save_path` is the default download directory. */
  async preferences(): Promise<Record<string, unknown> & { save_path?: string }> {
    return this.authed("/api/v2/app/preferences");
  }

  /** Ensure ownership-distinguishing categories exist (radarr/sonarr/torhq-*). */
  async ensureCategory(name: string, savePath: string): Promise<void> {
    await this.postForm("api/v2/torrents/createCategory", { category: name, savePath });
  }

  /**
   * Add a magnet (or .torrent URL) to qBittorrent. This is the ONLY write TorHQ
   * makes to qBittorrent, and it is always an explicit, user-initiated grab. The
   * `category` tags ownership: `torhq-manual` for raw grabs, or an *arr's category
   * (radarr/sonarr/lidarr) so that *arr adopts and imports the download.
   * `savePath` overrides the category's folder for this torrent alone, which
   * is how a raw grab lands on a chosen drive; automatic torrent management is
   * switched off for it, or qBittorrent would move it back to the category's.
   */
  async addTorrent(input: { url: string; category?: string; paused?: boolean; savePath?: string }): Promise<void> {
    const form: Record<string, string> = { urls: input.url };
    if (input.category) form.category = input.category;
    if (input.savePath) { form.savepath = input.savePath; form.autoTMM = "false"; }
    if (input.paused) form.paused = "true";
    const res = await this.postForm("api/v2/torrents/add", form);
    // qBittorrent replies with the literal body "Ok." on success, "Fails." otherwise.
    if (res.trim().toLowerCase().startsWith("fails")) {
      throw new Error("qBittorrent rejected the torrent (Fails.)");
    }
  }

  // ---------------------------------------------------------------------------
  // Torrent control. Every one of these is an explicit, user-initiated action on
  // the download client; none of them touch an *arr root folder.
  // ---------------------------------------------------------------------------

  /** Stop the given torrents. */
  async pause(hashes: string[]): Promise<void> {
    await this.torrentPost("pause", { hashes: hashList(hashes) }, "stop");
  }

  /** Start the given torrents. */
  async resume(hashes: string[]): Promise<void> {
    await this.torrentPost("resume", { hashes: hashList(hashes) }, "start");
  }

  /** Force a hash re-check of the data already on disk. */
  async recheck(hashes: string[]): Promise<void> {
    await this.torrentPost("recheck", { hashes: hashList(hashes) });
  }

  /** Remove the torrents from qBittorrent but leave the downloaded data alone. */
  async delete(hashes: string[]): Promise<void> {
    await this.torrentPost("delete", { hashes: hashList(hashes), deleteFiles: "false" });
  }

  /**
   * Remove the torrents AND the data qBittorrent downloaded for them. Destructive
   * and deliberately separate from `delete`: callers must have an explicit user
   * confirmation and must log it to the activity feed. This only ever removes
   * files inside qBittorrent's own save path — media an *arr has already imported
   * lives in that *arr's root folder and is never touched here.
   */
  async deleteWithFiles(hashes: string[]): Promise<void> {
    await this.torrentPost("delete", { hashes: hashList(hashes), deleteFiles: "true" });
  }

  /** Move to the front of the queue (qBittorrent queueing must be enabled). */
  async topPriority(hashes: string[]): Promise<void> {
    await this.torrentPost("topPrio", { hashes: hashList(hashes) });
  }

  /** Move to the back of the queue. */
  async bottomPriority(hashes: string[]): Promise<void> {
    await this.torrentPost("bottomPrio", { hashes: hashList(hashes) });
  }

  /**
   * Re-tag ownership. Changing a torrent's category is how a mis-tagged grab is
   * handed to the right *arr; qBittorrent may also relocate the data into the
   * category's save path, which is qBittorrent's own bookkeeping, not an import.
   */
  async setCategory(hashes: string[], category: string): Promise<void> {
    await this.torrentPost("setCategory", { hashes: hashList(hashes), category });
  }

  /**
   * POST to /api/v2/torrents/<action>. qBittorrent 5 renamed pause/resume to
   * stop/start; when the primary name 404s we retry the modern alias once so the
   * adapter works against both generations.
   */
  private async torrentPost(action: string, fields: Record<string, string>, alias?: string): Promise<void> {
    try {
      await this.postForm(`api/v2/torrents/${action}`, fields);
    } catch (e) {
      if (!alias || !(e instanceof HttpError) || e.statusCode !== 404) throw e;
      await this.postForm(`api/v2/torrents/${alias}`, fields);
    }
  }

  /** POST an x-www-form-urlencoded body to an authed endpoint, re-logging in once. */
  private async postForm(path: string, fields: Record<string, string>): Promise<string> {
    if (!this.cookie) await this.login();
    const base = this.cfg.baseUrl.endsWith("/") ? this.cfg.baseUrl : this.cfg.baseUrl + "/";
    const url = new URL(path, base).toString();
    const send = async () => request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.cookie!, referer: this.cfg.baseUrl },
      body: new URLSearchParams(fields).toString(),
    });
    let res = await send();
    if (res.statusCode === 403) { // SID expired — re-login once and retry.
      this.cookie = null;
      await this.login();
      res = await send();
    }
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new HttpError(`qBittorrent HTTP ${res.statusCode} for ${path}`, res.statusCode, text.slice(0, 500));
    }
    return text;
  }
}

/** qBittorrent takes a batch of torrents as a `|`-separated hash list. */
function hashList(hashes: string[]): string {
  return hashes.join("|");
}
