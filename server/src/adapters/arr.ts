import { httpJson, HttpError } from "./http.js";
import type { AdapterConfig, ArrActivity, ArrCandidate, ArrItem, HealthResult, ServiceAdapter } from "./types.js";

/**
 * Radarr/Sonarr/Lidarr adapter. Radarr and Sonarr speak the *arr **v3** API;
 * Lidarr speaks **v1** with a different add surface (it requires a
 * metadataProfileId and monitors albums, not episodes). This adapter keeps
 * those differences explicit rather than pretending all three are identical.
 *
 * FUNCTIONAL: health, wanted/missing, history, search-candidates, add-selected,
 * the download queue, and download-client configuration. TorHQ only *requests*:
 * the *arr owns search, grab, import, rename, and final placement — TorHQ never
 * touches its files.
 */
export type ArrFlavor = "radarr" | "sonarr" | "lidarr";

/**
 * A lookup candidate that remembers which *arr produced it. The acquire flow
 * searches all three at once — "dune" is legitimately a film and a series — so
 * the service has to travel with the candidate rather than with the query.
 */
export type ArrCandidateWithService = ArrCandidate & { service: ArrFlavor };

const API_VERSION: Record<ArrFlavor, string> = { radarr: "v3", sonarr: "v3", lidarr: "v1" };
/** Primary resource noun used for lookup + add. */
const RESOURCE: Record<ArrFlavor, string> = { radarr: "movie", sonarr: "series", lidarr: "artist" };

/**
 * Queue query parameters differ per flavor: each *arr names the "include the
 * items I can't match to a library entry" flag after its own primary resource,
 * and unknown items are exactly the ones a broken pipeline leaves behind — so
 * they must be asked for explicitly.
 */
const QUEUE_PARAMS: Record<ArrFlavor, Record<string, boolean>> = {
  radarr: { includeUnknownMovieItems: true, includeMovie: true },
  sonarr: { includeUnknownSeriesItems: true, includeSeries: true, includeEpisode: true },
  lidarr: { includeUnknownArtistItems: true, includeArtist: true, includeAlbum: true },
};

/**
 * "Scan this completed download folder now" — the flavor-specific command. The
 * *arr does the moving/renaming; TorHQ only asks.
 */
const SCAN_COMMAND: Record<ArrFlavor, string> = {
  radarr: "DownloadedMoviesScan",
  sonarr: "DownloadedEpisodesScan",
  lidarr: "DownloadedAlbumsScan",
};

/** One *arr queue record, normalized across the three flavors. */
export interface ArrQueueItem {
  service: ArrFlavor;
  id: number;
  title: string;
  status: string;
  /** ok | warning | error — the *arr's own verdict on the download. */
  trackedDownloadStatus?: string;
  /** downloading | importPending | importBlocked | imported | failed | … */
  trackedDownloadState?: string;
  errorMessage?: string;
  /** Flattened `statusMessages[].messages`; where import failures actually say why. */
  statusMessages: string[];
  size: number;
  sizeleft: number;
  /** The download client's id for this grab — a torrent hash for qBittorrent. */
  downloadId?: string;
  /** Where the download client put the data, as the *arr sees it. */
  outputPath?: string;
  /** ISO timestamp; absent on older *arr builds. */
  added?: string;
  /** The library entry this download belongs to: movieId / seriesId / artistId. Absent when unmatched. */
  libraryId?: number;
  /** The movie / series / artist name, as opposed to `title`, which is the release name. */
  mediaTitle?: string;
  /** Artwork for the library entry, when the *arr included it with the queue record. */
  poster?: string;
}

/** The *arr's own record of one library entry, enough to say whether it has arrived. */
export interface ArrLibraryEntry {
  title: string;
  poster?: string;
  /** Imported files: 0/1 for a movie, episode files for a series, track files for an artist. */
  fileCount: number;
  monitored: boolean;
}

/**
 * One release from an *arr's **interactive search** — the same call its own UI
 * makes. Unlike a raw indexer result this has already been parsed and scored
 * against the *arr's quality profile, which is where `rejected`/`rejections`
 * come from: the *arr saying, in its own words, why it would not have taken
 * this release automatically.
 */
export interface ArrRelease {
  /** The *arr's own handle for this release; the only thing `grabRelease` needs. */
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  /** Absent on usenet and on indexers that don't report it — null, never 0. */
  seeders: number | null;
  leechers: number | null;
  protocol: string;
  quality?: string;
  ageHours?: number;
  /** True when the *arr's profile would have refused this release. */
  rejected: boolean;
  /** Why it was refused, verbatim from the *arr. */
  rejections: string[];
  infoUrl?: string;
}

/**
 * What an *arr's own parser made of a raw release name. `matchedId` is the one
 * that matters: set means the *arr tied the release to a library entry, so a
 * grab under its category will import.
 */
export interface ArrParseResult {
  service: ArrFlavor;
  title: string;
  year?: number;
  quality?: string;
  /** Sonarr only — the season the release belongs to. */
  seasonNumber?: number;
  matchedId: number | null;
  matchedTitle?: string;
}

/** One lookup result with the library state the *arr reports for it. */
export interface ArrLookupHit {
  selectionId: string;
  /** The *arr's own library id; set only when the title is already in the library. */
  libraryId?: number;
  title: string;
  year?: number;
  subtitle?: string;
  poster?: string;
  backdrop?: string;
  overview?: string;
  monitored: boolean;
  /** Imported files: 0/1 for a movie, episode files for a series, track files for an artist. */
  fileCount: number;
  genres: string[];
  seasons?: ArrSeason[];
}

/** A season of a series, for Sonarr's per-season interactive search. */
export interface ArrSeason {
  seasonNumber: number;
  monitored: boolean;
  episodeFileCount?: number;
  totalEpisodeCount?: number;
}

/** An album, for Lidarr's per-album interactive search. */
export interface ArrAlbum {
  id: number;
  title: string;
  year?: number;
  monitored: boolean;
}

/** What identifies the thing being searched for, per flavor. */
export interface ReleaseTarget {
  /** The *arr's library id: movieId / seriesId / artistId. */
  id: number;
  /** Sonarr only, and required there — the *arr refuses a whole-series search. */
  seasonNumber?: number;
  /** Lidarr only; narrows an artist-wide search to one album. */
  albumId?: number;
}

/** A download-client path as the *arr sees it vs. as the client reports it. */
export interface RemotePathMapping {
  id: number;
  host: string;
  remotePath: string;
  localPath: string;
}

/** A download client as configured inside an *arr. */
export interface ArrDownloadClient {
  id: number;
  name: string;
  implementation: string;
  enable: boolean;
  /** Flattened `fields[]`, e.g. `{ host, port, category, urlBase }`. */
  fields: Record<string, unknown>;
}

export interface AddSelectedInput {
  term: string;
  selectionId: string;
  qualityProfileId: number;
  rootFolderPath: string;
  monitored?: boolean;
  searchNow?: boolean;
  /** Lidarr only, and required there. */
  metadataProfileId?: number;
}

export class ArrAdapter implements ServiceAdapter {
  readonly status = "functional" as const;
  constructor(readonly kind: ArrFlavor, private cfg: AdapterConfig) {}

  private hdr() { return { "X-Api-Key": this.cfg.secret }; }
  private api(path: string): string { return `/api/${API_VERSION[this.kind]}/${path.replace(/^\//, "")}`; }

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const s = await httpJson<{ version: string }>(this.cfg.baseUrl, this.api("system/status"), { headers: this.hdr() });
      return { healthy: true, version: s.version, latencyMs: Date.now() - start };
    } catch (e) {
      return { healthy: false, detail: (e as Error).message, latencyMs: Date.now() - start };
    }
  }

  /** Wanted/missing items (paged). */
  async wantedMissing(pageSize = 50): Promise<ArrItem[]> {
    const res = await httpJson<{ records: any[] }>(this.cfg.baseUrl, this.api("wanted/missing"), {
      headers: this.hdr(),
      query: { pageSize, sortKey: "title" },
    });
    return (res.records ?? []).map((r) => ({
      id: r.id,
      title: r.title ?? r.artistName ?? r.seriesTitle ?? "unknown",
      year: r.year,
      monitored: r.monitored,
      hasFile: r.hasFile,
      status: r.status,
    }));
  }

  /** Recent history/activity. */
  async history(pageSize = 30): Promise<ArrActivity[]> {
    const res = await httpJson<{ records: any[] }>(this.cfg.baseUrl, this.api("history"), {
      headers: this.hdr(),
      query: { pageSize, sortKey: "date", sortDirection: "descending" },
    });
    return (res.records ?? []).map((r) => ({
      id: r.id,
      eventType: r.eventType,
      title: r.sourceTitle ?? r.title ?? "",
      date: r.date,
    }));
  }

  /**
   * The *arr's view of what its download client is doing. This is where an
   * import that never happened shows up: `trackedDownloadStatus` goes to
   * warning/error and `statusMessages` carries the reason.
   */
  async queue(pageSize = 200): Promise<ArrQueueItem[]> {
    const res = await httpJson<{ records?: any[] } | any[]>(this.cfg.baseUrl, this.api("queue"), {
      headers: this.hdr(),
      query: { page: 1, pageSize, ...QUEUE_PARAMS[this.kind] },
    });
    // Paged on current builds; a bare array on older ones.
    const records = Array.isArray(res) ? res : res.records ?? [];
    return records.map((r) => this.normalizeQueueItem(r));
  }

  private normalizeQueueItem(r: any): ArrQueueItem {
    return {
      service: this.kind,
      id: r.id,
      title: r.title ?? r.movie?.title ?? r.series?.title ?? r.album?.title ?? r.artist?.artistName ?? "unknown",
      status: r.status ?? "unknown",
      trackedDownloadStatus: r.trackedDownloadStatus,
      trackedDownloadState: r.trackedDownloadState,
      errorMessage: r.errorMessage || undefined,
      statusMessages: flattenStatusMessages(r.statusMessages),
      size: r.size ?? 0,
      sizeleft: r.sizeleft ?? 0,
      downloadId: r.downloadId || undefined,
      outputPath: r.outputPath || undefined,
      added: r.added || undefined,
      libraryId: [r.movieId, r.seriesId, r.artistId].find((n) => typeof n === "number" && n > 0),
      mediaTitle: r.movie?.title ?? r.series?.title ?? r.artist?.artistName ?? undefined,
      poster: pickPoster((r.movie ?? r.series ?? r.artist)?.images),
    };
  }

  /** Read-only: one library entry, to learn whether a request has been imported yet. */
  async libraryEntry(id: number): Promise<ArrLibraryEntry> {
    const r = await httpJson<any>(this.cfg.baseUrl, this.api(`${RESOURCE[this.kind]}/${id}`), { headers: this.hdr() });
    const stats = r?.statistics ?? {};
    const fileCount = this.kind === "radarr"
      ? (r?.hasFile ? 1 : 0)
      : this.kind === "sonarr" ? numberOrUndefined(stats.episodeFileCount) ?? 0
      : numberOrUndefined(stats.trackFileCount) ?? 0;
    return {
      title: r?.title ?? r?.artistName ?? "unknown",
      poster: pickPoster(r?.images),
      fileCount,
      monitored: !!r?.monitored,
    };
  }

  /**
   * Drop a record from the *arr's queue. `removeFromClient` also deletes it in
   * the download client; `blocklist` tells the *arr never to grab that release
   * again. Both are the caller's explicit choice.
   */
  async removeFromQueue(id: number, opts: { removeFromClient: boolean; blocklist: boolean }): Promise<void> {
    await httpJson(this.cfg.baseUrl, this.api(`queue/${id}`), {
      method: "DELETE",
      headers: this.hdr(),
      // Older builds spell it `blacklist`; sending both keeps one call working
      // across generations (the *arr ignores the parameter it doesn't know).
      query: {
        removeFromClient: opts.removeFromClient,
        blocklist: opts.blocklist,
        blacklist: opts.blocklist,
      },
    });
  }

  /** Download clients configured *inside* the *arr (not TorHQ's own config). */
  async downloadClients(): Promise<ArrDownloadClient[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api("downloadclient"), { headers: this.hdr() });
    return (Array.isArray(res) ? res : []).map((c) => ({
      id: c.id,
      name: c.name ?? "",
      implementation: c.implementation ?? "",
      enable: c.enable ?? false,
      fields: Object.fromEntries((c.fields ?? []).map((f: any) => [f.name, f.value])),
    }));
  }

  /** Download-handling config — notably `enableCompletedDownloadHandling`. */
  async downloadClientConfig(): Promise<{ enableCompletedDownloadHandling?: boolean; autoRedownloadFailed?: boolean }> {
    return httpJson(this.cfg.baseUrl, this.api("config/downloadclient"), { headers: this.hdr() });
  }

  /** Path translations between the download client's view and the *arr's own. */
  async remotePathMappings(): Promise<RemotePathMapping[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api("remotepathmapping"), { headers: this.hdr() });
    return (Array.isArray(res) ? res : []).map((m) => ({
      id: m.id, host: m.host ?? "", remotePath: m.remotePath ?? "", localPath: m.localPath ?? "",
    }));
  }

  /**
   * Directories the *arr can see inside `path`, through its OWN filesystem. This
   * is the only way to ask "is the download directory actually mounted in your
   * container?" — a question no amount of configuration inspection answers, and
   * the usual reason a correctly-configured stack still never imports anything.
   */
  async listFolders(path: string): Promise<string[]> {
    const res = await httpJson<{ directories?: Array<{ path?: string }> }>(
      this.cfg.baseUrl, this.api("filesystem"),
      { headers: this.hdr(), query: { path, allowFoldersWithoutTrailingSlashes: true, includeFiles: false } },
    );
    return (res.directories ?? []).map((d) => d.path ?? "").filter(Boolean);
  }

  /**
   * TMDB ids of everything in the library, for the Catalogue's "in library"
   * badge. Radarr keys movies on TMDB; Sonarr v4 records a series' TMDB id
   * alongside its TVDB one (v3 does not, and its shows simply go unbadged).
   * Lidarr has no TMDB ids at all.
   */
  async libraryTmdbIds(): Promise<Set<number>> {
    if (this.kind === "lidarr") return new Set();
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api(RESOURCE[this.kind]), {
      headers: this.hdr(),
      // A large library is a large payload; give it longer than a status call.
      timeoutMs: 20_000,
    });
    const ids = new Set<number>();
    for (const r of Array.isArray(res) ? res : []) {
      if (typeof r?.tmdbId === "number" && r.tmdbId > 0) ids.add(r.tmdbId);
    }
    return ids;
  }

  private lookupPath(): string { return this.api(`${RESOURCE[this.kind]}/lookup`); }

  private async lookup(term: string): Promise<any[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.lookupPath(), { headers: this.hdr(), query: { term } });
    return Array.isArray(res) ? res : [];
  }

  /** Stable, flavor-specific selector for a raw lookup object. */
  private selectionIdOf(raw: any): string | null {
    switch (this.kind) {
      case "radarr": return raw?.tmdbId != null ? `tmdb:${raw.tmdbId}` : null;
      case "sonarr": return raw?.tvdbId != null ? `tvdb:${raw.tvdbId}` : null;
      case "lidarr": return raw?.foreignArtistId ? `mbid:${raw.foreignArtistId}` : null;
    }
  }

  /**
   * Lookup results with the library state the *arr reports for each: `id` set
   * means it is already in the library, and the file counts say whether
   * anything has been imported. Read-only.
   */
  async lookupHits(term: string): Promise<ArrLookupHit[]> {
    const out: ArrLookupHit[] = [];
    const found = await this.lookup(term);
    // /lookup does not report file state for titles already held (Radarr has no
    // hasFile, Sonarr/Lidarr zero the statistics), so read each held title's
    // own library record. Read-only; a record that can't be read keeps the
    // lookup's values rather than failing the search.
    const library = await Promise.all(found.map(async (r) => {
      if (!(typeof r?.id === "number" && r.id > 0)) return null;
      try {
        return await httpJson<any>(this.cfg.baseUrl, this.api(`${RESOURCE[this.kind]}/${r.id}`), { headers: this.hdr() });
      } catch { return null; }
    }));
    for (const [i, lookupRow] of found.entries()) {
      const r = library[i] ? { ...lookupRow, ...library[i] } : lookupRow;
      const selectionId = this.selectionIdOf(r);
      if (!selectionId) continue;
      const stats = r.statistics ?? {};
      const fileCount = this.kind === "radarr"
        ? (r.hasFile ? 1 : 0)
        : this.kind === "sonarr" ? numberOrUndefined(stats.episodeFileCount) ?? 0
        : numberOrUndefined(stats.trackFileCount) ?? 0;
      out.push({
        selectionId,
        libraryId: typeof r.id === "number" && r.id > 0 ? r.id : undefined,
        title: r.title ?? r.artistName ?? "unknown",
        year: numberOrUndefined(r.year),
        subtitle: this.kind === "lidarr" ? (r.disambiguation || undefined)
          : this.kind === "sonarr" ? (r.network || undefined) : (r.studio || undefined),
        poster: pickPoster(r.images),
        backdrop: pickImage(r.images, "fanart"),
        overview: typeof r.overview === "string" && r.overview ? r.overview.slice(0, 600) : undefined,
        monitored: !!r.monitored,
        fileCount,
        genres: Array.isArray(r.genres) ? r.genres.filter((g: unknown) => typeof g === "string") : [],
        seasons: this.kind === "sonarr" && Array.isArray(r.seasons)
          ? r.seasons.map((x: any) => ({ seasonNumber: x.seasonNumber, monitored: !!x.monitored,
              episodeFileCount: x.statistics?.episodeFileCount, totalEpisodeCount: x.statistics?.totalEpisodeCount }))
          : undefined,
      });
    }
    return out;
  }

  /** Search and return normalized candidates for the user to choose from. */
  async searchCandidates(term: string): Promise<ArrCandidate[]> {
    const raw = await this.lookup(term);
    const out: ArrCandidate[] = [];
    for (const r of raw) {
      const selectionId = this.selectionIdOf(r);
      if (!selectionId) continue; // unusable without a stable selector
      out.push({
        selectionId,
        title: r.title ?? r.artistName ?? "unknown",
        subtitle: this.kind === "lidarr" ? (r.disambiguation ?? undefined) : undefined,
        year: r.year,
        poster: pickPoster(r.images),
        overview: typeof r.overview === "string" ? r.overview.slice(0, 400) : undefined,
        alreadyAdded: typeof r.id === "number" && r.id > 0,
      });
    }
    return out;
  }

  /**
   * Add exactly the candidate the user selected. We re-run the same lookup and
   * match `selectionId`, so the object we POST is always a genuine lookup result
   * — never "the first hit". Request bodies are flavor-specific.
   */
  async addSelected(input: AddSelectedInput): Promise<{ id: number; title: string }> {
    const raw = await this.lookup(input.term);
    const chosen = raw.find((r) => this.selectionIdOf(r) === input.selectionId);
    if (!chosen) {
      throw new Error(`Selected result is no longer available for "${input.term}"; search again.`);
    }
    if (typeof chosen.id === "number" && chosen.id > 0) {
      return { id: chosen.id, title: chosen.title ?? chosen.artistName ?? input.term };
    }

    const body = this.buildAddBody(chosen, input);
    const created = await httpJson<{ id: number; title?: string; artistName?: string }>(
      this.cfg.baseUrl, this.api(RESOURCE[this.kind]),
      { method: "POST", headers: this.hdr(), body },
    );
    return { id: created.id, title: created.title ?? created.artistName ?? input.term };
  }

  private buildAddBody(chosen: any, input: AddSelectedInput): Record<string, unknown> {
    const monitored = input.monitored ?? true;
    if (this.kind === "radarr") {
      return {
        ...chosen,
        qualityProfileId: input.qualityProfileId,
        rootFolderPath: input.rootFolderPath,
        monitored,
        minimumAvailability: "released",
        addOptions: { searchForMovie: input.searchNow ?? true },
      };
    }
    if (this.kind === "sonarr") {
      return {
        ...chosen,
        qualityProfileId: input.qualityProfileId,
        // Sonarr v3 requires a languageProfileId; v4 ignores it. Keep any value
        // the lookup already provided, else default to 1 for v3 compatibility.
        languageProfileId: chosen.languageProfileId ?? 1,
        rootFolderPath: input.rootFolderPath,
        monitored,
        seasonFolder: true,
        addOptions: { searchForMissingEpisodes: input.searchNow ?? true, monitor: "all" },
      };
    }
    // lidarr — distinct surface: metadataProfileId is mandatory, and it monitors
    // albums, not episodes.
    if (input.metadataProfileId == null) {
      throw new Error("Lidarr requires a metadataProfileId; pass one from /options.");
    }
    return {
      ...chosen,
      qualityProfileId: input.qualityProfileId,
      metadataProfileId: input.metadataProfileId,
      rootFolderPath: input.rootFolderPath,
      monitored,
      addOptions: { monitor: "all", searchForMissingAlbums: input.searchNow ?? true },
    };
  }

  /** Fire an *arr command (e.g. RefreshMonitoredDownloads). */
  async command(name: string, extra: Record<string, unknown> = {}): Promise<{ id?: number }> {
    return httpJson(this.cfg.baseUrl, this.api("command"), {
      method: "POST", headers: this.hdr(), body: { name, ...extra },
    });
  }

  /**
   * Ask the *arr to run its OWN automatic search for one library item: it
   * searches its indexers, picks the best release its profile accepts and grabs
   * it into its own queue. TorHQ only issues the command (movie / series /
   * artist level); it never sees or chooses a release.
   */
  async automaticSearch(id: number): Promise<{ command: string }> {
    const spec = {
      radarr: { name: "MoviesSearch", body: { movieIds: [id] } },
      sonarr: { name: "SeriesSearch", body: { seriesId: id } },
      lidarr: { name: "ArtistSearch", body: { artistId: id } },
    }[this.kind];
    await this.command(spec.name, spec.body);
    return { command: spec.name };
  }

  /**
   * Nudge the *arr to poll its download client and import completed downloads
   * now, rather than waiting for its next interval. Used after TorHQ pushes a
   * magnet into the *arr's qBittorrent category: the *arr still owns the import,
   * TorHQ just asks it to look. (The item must be added + monitored in the *arr,
   * with Completed Download Handling enabled, for the import to happen.)
   */
  async processDownloads(): Promise<void> {
    await this.command("RefreshMonitoredDownloads");
  }

  /**
   * Ask the *arr to import a completed download it already owns. With a known
   * `outputPath` we point its own scanner straight at that folder (the precise
   * call, and the one that reports back per-file); without one we fall back to a
   * full download-client refresh. Either way the *arr does the moving and
   * renaming — TorHQ never touches the files.
   */
  async rescanDownload(input: { outputPath?: string; downloadId?: string }): Promise<{ command: string }> {
    if (!input.outputPath) {
      await this.command("RefreshMonitoredDownloads");
      return { command: "RefreshMonitoredDownloads" };
    }
    const name = SCAN_COMMAND[this.kind];
    // No importMode: the *arr's configured copy/hardlink behaviour stays authoritative.
    await this.command(name, { path: input.outputPath, downloadClientId: input.downloadId });
    return { command: name };
  }

  /**
   * Run the *arr's **interactive search** for one library item and return what
   * its indexers offered. This is the call that makes the acquisition loop
   * close: every release here is one the *arr can grab into its own queue, so
   * the import, rename and final placement that follow are entirely its own.
   *
   * Slow by nature — it queries every indexer synchronously, and 100+ results
   * over two minutes is normal. Callers must not run it on a request the user
   * is waiting on; see `lib/releaseSearch.ts`.
   */
  async releases(target: ReleaseTarget): Promise<ArrRelease[]> {
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api("release"), {
      headers: this.hdr(),
      query: this.releaseQuery(target),
      // Every indexer, in series, behind one HTTP call.
      timeoutMs: 180_000,
    });
    return (Array.isArray(res) ? res : []).map((r) => this.normalizeRelease(r));
  }

  /**
   * Which id the *arr wants for an interactive search. The flavors genuinely
   * differ: Radarr takes a movie, Lidarr an artist or an album, and Sonarr
   * refuses a whole-series search outright — it wants a season.
   */
  private releaseQuery(target: ReleaseTarget): Record<string, string | number> {
    switch (this.kind) {
      case "radarr":
        return { movieId: target.id };
      case "sonarr":
        if (target.seasonNumber == null) {
          throw new Error("Sonarr searches a season at a time — choose one first.");
        }
        return { seriesId: target.id, seasonNumber: target.seasonNumber };
      case "lidarr":
        return target.albumId != null ? { albumId: target.albumId } : { artistId: target.id };
    }
  }

  private normalizeRelease(r: any): ArrRelease {
    const rejections: string[] = Array.isArray(r?.rejections)
      // Sonarr/Lidarr return objects ({ reason, type }); Radarr returns strings.
      ? r.rejections.map((x: any) => (typeof x === "string" ? x : x?.reason)).filter(Boolean)
      : [];
    return {
      guid: r.guid ?? "",
      indexerId: r.indexerId ?? 0,
      indexer: r.indexer ?? "unknown",
      title: r.title ?? "untitled",
      size: r.size ?? 0,
      // A missing seeder count is unknown, not zero — sorting by "0 seeders"
      // buries usenet and quiet-indexer results that are perfectly grabbable.
      seeders: typeof r.seeders === "number" ? r.seeders : null,
      leechers: typeof r.leechers === "number" ? r.leechers : null,
      protocol: r.protocol ?? "unknown",
      quality: r.quality?.quality?.name ?? undefined,
      ageHours: typeof r.ageHours === "number" ? r.ageHours : undefined,
      // `rejected` is authoritative when present; older builds only send the list.
      rejected: typeof r.rejected === "boolean" ? r.rejected : rejections.length > 0,
      rejections,
      infoUrl: r.infoUrl || undefined,
    };
  }

  /**
   * Tell the *arr to grab a release it found itself. It goes into that *arr's
   * own queue and download client, which is the whole point: the *arr tracks it,
   * imports it on completion, and renames it into its root folder. TorHQ never
   * sees the file.
   *
   * The *arr accepts a release its profile rejected — that is a deliberate
   * override, exactly as its own UI allows.
   */
  async grabRelease(guid: string, indexerId: number): Promise<void> {
    await httpJson(this.cfg.baseUrl, this.api("release"), {
      method: "POST",
      headers: this.hdr(),
      body: { guid, indexerId },
      // The *arr resolves the release against the indexer before answering.
      timeoutMs: 120_000,
    });
  }

  /** Sonarr: the seasons of a series, so one can be searched. */
  async seasons(seriesId: number): Promise<ArrSeason[]> {
    if (this.kind !== "sonarr") return [];
    const s = await httpJson<{ seasons?: any[] }>(this.cfg.baseUrl, this.api(`series/${seriesId}`), {
      headers: this.hdr(),
    });
    return (s.seasons ?? []).map((x) => ({
      seasonNumber: x.seasonNumber,
      monitored: !!x.monitored,
      episodeFileCount: x.statistics?.episodeFileCount,
      totalEpisodeCount: x.statistics?.totalEpisodeCount,
    }));
  }

  /** Lidarr: the albums of an artist, so one can be searched. */
  async albums(artistId: number): Promise<ArrAlbum[]> {
    if (this.kind !== "lidarr") return [];
    const res = await httpJson<any[]>(this.cfg.baseUrl, this.api("album"), {
      headers: this.hdr(),
      query: { artistId },
    });
    return (Array.isArray(res) ? res : []).map((a) => ({
      id: a.id,
      title: a.title ?? "untitled",
      year: a.releaseDate ? new Date(a.releaseDate).getUTCFullYear() : undefined,
      monitored: !!a.monitored,
    }));
  }

  /**
   * Ask the *arr what a raw release name refers to, using **its own parser** —
   * the same one it runs when deciding whether to import something.
   *
   * This is the first and best rung of identification, and it is free: no LLM
   * beats "the component that will actually perform the import already says it
   * maps this exact string to movie 244". It handles far more than it looks
   * like it should, including titles carrying a transliterated name alongside
   * the English one.
   *
   * `matchedId` is the load-bearing field: when it is set, the *arr has tied the
   * release to a library entry, and a grab under that *arr's category will
   * import. When it is null the name parsed but matches nothing in the library —
   * still useful, because `title`/`year` are then a good lookup term.
   */
  async parse(releaseName: string): Promise<ArrParseResult | null> {
    let res: any;
    try {
      res = await httpJson<any>(this.cfg.baseUrl, this.api("parse"), {
        headers: this.hdr(),
        query: { title: releaseName },
        timeoutMs: 20_000,
      });
    } catch (e) {
      // Lidarr's parse surface has moved between builds; a 404 means "this *arr
      // cannot answer", which is a null, not a failure of the whole ladder.
      if (e instanceof HttpError && e.statusCode === 404) return null;
      throw e;
    }
    return this.normalizeParse(res);
  }

  private normalizeParse(res: any): ArrParseResult | null {
    if (!res || typeof res !== "object") return null;

    if (this.kind === "radarr") {
      const info = res.parsedMovieInfo;
      const movie = res.movie;
      if (!info && !movie) return null;
      return {
        service: this.kind,
        title: info?.primaryMovieTitle ?? info?.movieTitle ?? movie?.title ?? "",
        year: numberOrUndefined(info?.year ?? movie?.year),
        quality: info?.quality?.quality?.name,
        matchedId: typeof movie?.id === "number" && movie.id > 0 ? movie.id : null,
        matchedTitle: movie?.title,
      };
    }

    if (this.kind === "sonarr") {
      const info = res.parsedEpisodeInfo;
      const series = res.series;
      if (!info && !series) return null;
      return {
        service: this.kind,
        title: info?.seriesTitle ?? series?.title ?? "",
        year: numberOrUndefined(info?.year ?? series?.year),
        quality: info?.quality?.quality?.name,
        // Sonarr searches a season at a time, so the parsed season is what makes
        // an identified TV release actionable.
        seasonNumber: numberOrUndefined(info?.seasonNumber),
        matchedId: typeof series?.id === "number" && series.id > 0 ? series.id : null,
        matchedTitle: series?.title,
      };
    }

    const info = res.parsedAlbumInfo ?? res.parsedTrackInfo;
    const artist = res.artist;
    if (!info && !artist) return null;
    return {
      service: this.kind,
      title: info?.artistName ?? artist?.artistName ?? "",
      year: numberOrUndefined(info?.releaseYear),
      quality: info?.quality?.quality?.name,
      matchedId: typeof artist?.id === "number" && artist.id > 0 ? artist.id : null,
      matchedTitle: artist?.artistName,
    };
  }

  async qualityProfiles(): Promise<Array<{ id: number; name: string }>> {
    return httpJson(this.cfg.baseUrl, this.api("qualityprofile"), { headers: this.hdr() });
  }

  async rootFolders(): Promise<Array<{ id: number; path: string; accessible?: boolean; freeSpace?: number }>> {
    return httpJson(this.cfg.baseUrl, this.api("rootfolder"), { headers: this.hdr() });
  }

  /** Lidarr-only: metadata profiles are required to add an artist. */
  async metadataProfiles(): Promise<Array<{ id: number; name: string }>> {
    if (this.kind !== "lidarr") return [];
    return httpJson(this.cfg.baseUrl, this.api("metadataprofile"), { headers: this.hdr() });
  }
}

/**
 * `statusMessages` is `[{ title, messages[] }]` — the title is usually the file
 * and the messages the reason it could not be imported. Flatten to plain lines,
 * keeping the title when it carries the only information.
 */
function flattenStatusMessages(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const m of raw) {
    const messages = Array.isArray(m?.messages) ? m.messages.filter((s: unknown) => typeof s === "string" && s) : [];
    if (messages.length) out.push(...messages);
    else if (typeof m?.title === "string" && m.title) out.push(m.title);
  }
  return [...new Set(out)];
}

function pickImage(images: any, coverType: string): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const img = images.find((i) => i?.coverType === coverType);
  return img?.remoteUrl ?? img?.url ?? undefined;
}

function pickPoster(images: any): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const poster = images.find((i) => i?.coverType === "poster") ?? images[0];
  return poster?.remoteUrl ?? poster?.url ?? undefined;
}

/** A field that is only meaningful when it is actually a number. */
function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
