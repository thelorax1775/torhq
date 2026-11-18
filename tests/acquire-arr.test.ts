import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the adapter HTTP client so each *arr's responses are driven from the test
// and the exact request TorHQ would send can be asserted — no network.
const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => s,
}));

const { ArrAdapter } = await import("../server/src/adapters/arr.js");
const { HttpError } = await import("../server/src/adapters/http.js");

const cfg = { baseUrl: "http://radarr:7878", secret: "RADARRKEY" };

/**
 * Structurally faithful Radarr v3 release resources, trimmed from a real
 * `GET /api/v3/release?movieId=244` against Radarr 6.3.0.
 */
const RADARR_RELEASES = [
  {
    guid: "magnet:?xt=urn:btih:AAAA1111",
    indexerId: 2, indexer: "The Pirate Bay (Prowlarr)",
    title: "Avengers.Endgame.2019.1080p.BluRay.x264",
    size: 12884901888, seeders: 158, leechers: 4,
    protocol: "torrent", ageHours: 51.2,
    quality: { quality: { id: 7, name: "Bluray-1080p" } },
    rejected: false, rejections: [],
    infoUrl: "https://tpb.example/details/1",
  },
  {
    guid: "magnet:?xt=urn:btih:BBBB2222",
    indexerId: 2, indexer: "The Pirate Bay (Prowlarr)",
    title: "Avengers.Endgame.2019.UHD.BluRay.2160p.HEVC",
    size: 64368595016, seeders: 34, leechers: 1,
    protocol: "torrent",
    quality: { quality: { id: 19, name: "Bluray-2160p" } },
    rejected: true,
    rejections: ["BR-DISK is not wanted in profile", "Existing file meets cutoff: HDTV-720p []"],
  },
  {
    // Usenet: no seeder count at all. Must stay unknown, never become 0.
    guid: "urn:usenet:cccc",
    indexerId: 9, indexer: "Newz",
    title: "Avengers.Endgame.2019.1080p.WEB",
    size: 9663676416,
    protocol: "usenet",
    quality: { quality: { id: 3, name: "WEBDL-1080p" } },
    rejected: false, rejections: [],
  },
];

beforeEach(() => { httpJson.mockReset(); });

describe("ArrAdapter.releases — the *arr's own interactive search", () => {
  it("asks Radarr for a movie's releases and normalizes them", async () => {
    httpJson.mockResolvedValueOnce(RADARR_RELEASES);
    const a = new ArrAdapter("radarr", cfg);
    const out = await a.releases({ id: 244 });

    const [base, path, opts] = httpJson.mock.calls[0];
    expect(base).toBe("http://radarr:7878");
    expect(path).toBe("/api/v3/release");
    expect(opts.query).toEqual({ movieId: 244 });
    expect(opts.headers).toEqual({ "X-Api-Key": "RADARRKEY" });

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      guid: "magnet:?xt=urn:btih:AAAA1111",
      indexerId: 2,
      indexer: "The Pirate Bay (Prowlarr)",
      quality: "Bluray-1080p",
      rejected: false,
      seeders: 158,
    });
  });

  it("gives the interactive search a timeout long enough to actually finish", async () => {
    // The live call against a real stack took over a minute for 111 results;
    // the 8s adapter default would have failed every time.
    httpJson.mockResolvedValueOnce([]);
    await new ArrAdapter("radarr", cfg).releases({ id: 1 });
    expect(httpJson.mock.calls[0][2].timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("keeps an absent seeder count as null rather than zero", async () => {
    httpJson.mockResolvedValueOnce(RADARR_RELEASES);
    const out = await new ArrAdapter("radarr", cfg).releases({ id: 244 });
    expect(out[2].seeders).toBeNull();
    expect(out[2].leechers).toBeNull();
  });

  it("carries the *arr's own rejection reasons through verbatim", async () => {
    httpJson.mockResolvedValueOnce(RADARR_RELEASES);
    const out = await new ArrAdapter("radarr", cfg).releases({ id: 244 });
    expect(out[1].rejected).toBe(true);
    expect(out[1].rejections).toEqual([
      "BR-DISK is not wanted in profile",
      "Existing file meets cutoff: HDTV-720p []",
    ]);
  });

  it("flattens Sonarr/Lidarr's object-shaped rejections to their reasons", async () => {
    // Sonarr returns [{ reason, type }] where Radarr returns plain strings.
    httpJson.mockResolvedValueOnce([{
      guid: "g", indexerId: 1, indexer: "ix", title: "t", size: 1, protocol: "torrent",
      rejected: true, rejections: [{ reason: "Not a custom format upgrade", type: "permanent" }],
    }]);
    const out = await new ArrAdapter("sonarr", cfg).releases({ id: 5, seasonNumber: 2 });
    expect(out[0].rejections).toEqual(["Not a custom format upgrade"]);
  });

  it("infers `rejected` from the reason list on builds that omit the flag", async () => {
    httpJson.mockResolvedValueOnce([{
      guid: "g", indexerId: 1, indexer: "ix", title: "t", size: 1, protocol: "torrent",
      rejections: ["too big"],
    }]);
    const out = await new ArrAdapter("radarr", cfg).releases({ id: 1 });
    expect(out[0].rejected).toBe(true);
  });
});

describe("ArrAdapter.releases — per-flavor query shapes", () => {
  it("sends Sonarr a series + season, which is the only thing it accepts", async () => {
    httpJson.mockResolvedValueOnce([]);
    await new ArrAdapter("sonarr", { ...cfg, baseUrl: "http://sonarr:8989" }).releases({ id: 12, seasonNumber: 3 });
    expect(httpJson.mock.calls[0][1]).toBe("/api/v3/release");
    expect(httpJson.mock.calls[0][2].query).toEqual({ seriesId: 12, seasonNumber: 3 });
  });

  it("refuses a Sonarr search with no season instead of asking for the whole series", async () => {
    // Sonarr answers a seriesId-only search with an error; failing here gives
    // the user a sentence they can act on rather than an opaque 500.
    const a = new ArrAdapter("sonarr", cfg);
    await expect(a.releases({ id: 12 })).rejects.toThrow(/season at a time/i);
    expect(httpJson).not.toHaveBeenCalled();
  });

  it("searches a Lidarr album when given one, and the artist otherwise", async () => {
    const a = new ArrAdapter("lidarr", { ...cfg, baseUrl: "http://lidarr:8686" });
    httpJson.mockResolvedValueOnce([]);
    await a.releases({ id: 7, albumId: 99 });
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/release"); // Lidarr is v1
    expect(httpJson.mock.calls[0][2].query).toEqual({ albumId: 99 });

    httpJson.mockResolvedValueOnce([]);
    await a.releases({ id: 7 });
    expect(httpJson.mock.calls[1][2].query).toEqual({ artistId: 7 });
  });
});

describe("ArrAdapter.grabRelease", () => {
  it("posts the guid and indexer back to the *arr so the *arr owns the download", async () => {
    httpJson.mockResolvedValueOnce({});
    await new ArrAdapter("radarr", cfg).grabRelease("magnet:?xt=urn:btih:AAAA1111", 2);
    const [, path, opts] = httpJson.mock.calls[0];
    expect(path).toBe("/api/v3/release");
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({ guid: "magnet:?xt=urn:btih:AAAA1111", indexerId: 2 });
  });

  it("uses Lidarr's v1 path", async () => {
    httpJson.mockResolvedValueOnce({});
    await new ArrAdapter("lidarr", cfg).grabRelease("g", 3);
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/release");
  });
});

describe("ArrAdapter.seasons / .albums", () => {
  it("reads a series' seasons with their file counts", async () => {
    httpJson.mockResolvedValueOnce({
      seasons: [
        { seasonNumber: 0, monitored: false, statistics: { episodeFileCount: 0, totalEpisodeCount: 3 } },
        { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8, totalEpisodeCount: 10 } },
      ],
    });
    const out = await new ArrAdapter("sonarr", cfg).seasons(12);
    expect(httpJson.mock.calls[0][1]).toBe("/api/v3/series/12");
    expect(out).toEqual([
      { seasonNumber: 0, monitored: false, episodeFileCount: 0, totalEpisodeCount: 3 },
      { seasonNumber: 1, monitored: true, episodeFileCount: 8, totalEpisodeCount: 10 },
    ]);
  });

  it("survives a series with no statistics block", async () => {
    httpJson.mockResolvedValueOnce({ seasons: [{ seasonNumber: 1, monitored: true }] });
    const out = await new ArrAdapter("sonarr", cfg).seasons(12);
    expect(out[0]).toEqual({
      seasonNumber: 1, monitored: true, episodeFileCount: undefined, totalEpisodeCount: undefined,
    });
  });

  it("reads an artist's albums and derives the year from the release date", async () => {
    httpJson.mockResolvedValueOnce([
      { id: 3, title: "Kid A", monitored: true, releaseDate: "2000-10-02T00:00:00Z" },
      { id: 4, title: "Untitled", monitored: false },
    ]);
    const out = await new ArrAdapter("lidarr", cfg).albums(7);
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/album");
    expect(httpJson.mock.calls[0][2].query).toEqual({ artistId: 7 });
    expect(out).toEqual([
      { id: 3, title: "Kid A", year: 2000, monitored: true },
      { id: 4, title: "Untitled", year: undefined, monitored: false },
    ]);
  });

  it("returns nothing for the flavors that have no such concept", async () => {
    expect(await new ArrAdapter("radarr", cfg).seasons(1)).toEqual([]);
    expect(await new ArrAdapter("radarr", cfg).albums(1)).toEqual([]);
    expect(await new ArrAdapter("sonarr", cfg).albums(1)).toEqual([]);
    expect(httpJson).not.toHaveBeenCalled();
  });
});

describe("ArrAdapter.parse — the *arr's own release-name parser", () => {
  // Shapes trimmed from real GET /api/v3/parse responses against Radarr 6.3.0.
  it("reads Radarr's parse and the library entry it matched", async () => {
    httpJson.mockResolvedValueOnce({
      parsedMovieInfo: {
        primaryMovieTitle: "Avengers Endgame", year: 2019,
        quality: { quality: { name: "Bluray-1080p" } },
      },
      movie: { id: 244, title: "Avengers: Endgame", year: 2019 },
    });
    const out = await new ArrAdapter("radarr", cfg).parse("Avengers.Endgame.2019.1080p.BluRay.x264-SPARKS");

    expect(httpJson.mock.calls[0][1]).toBe("/api/v3/parse");
    expect(httpJson.mock.calls[0][2].query).toEqual({ title: "Avengers.Endgame.2019.1080p.BluRay.x264-SPARKS" });
    expect(out).toEqual({
      service: "radarr", title: "Avengers Endgame", year: 2019,
      quality: "Bluray-1080p", matchedId: 244, matchedTitle: "Avengers: Endgame",
    });
  });

  it("reports a parse that matched nothing in the library as matchedId null", async () => {
    // Still useful: the parsed title is a good lookup term. What must not happen
    // is a falsy-but-present id being mistaken for a real match.
    httpJson.mockResolvedValueOnce({
      parsedMovieInfo: { primaryMovieTitle: "Some Film", year: 2024 },
      movie: { id: 0 },
    });
    const out = await new ArrAdapter("radarr", cfg).parse("Some.Film.2024");
    expect(out?.matchedId).toBeNull();
    expect(out?.title).toBe("Some Film");
  });

  it("keeps the season from Sonarr's parse, which is what makes a TV hit actionable", async () => {
    httpJson.mockResolvedValueOnce({
      parsedEpisodeInfo: { seriesTitle: "Severance", seasonNumber: 2, quality: { quality: { name: "WEBDL-1080p" } } },
      series: { id: 12, title: "Severance", year: 2022 },
    });
    const out = await new ArrAdapter("sonarr", cfg).parse("Severance.S02E01.1080p.WEB");
    expect(out).toMatchObject({ service: "sonarr", seasonNumber: 2, matchedId: 12, matchedTitle: "Severance" });
  });

  it("uses Lidarr's v1 path and its artist shape", async () => {
    httpJson.mockResolvedValueOnce({
      parsedAlbumInfo: { artistName: "Radiohead", releaseYear: 2000 },
      artist: { id: 3, artistName: "Radiohead" },
    });
    const out = await new ArrAdapter("lidarr", cfg).parse("Radiohead - Kid A (2000) FLAC");
    expect(httpJson.mock.calls[0][1]).toBe("/api/v1/parse");
    expect(out).toMatchObject({ service: "lidarr", title: "Radiohead", matchedId: 3 });
  });

  it("treats a 404 as 'this *arr cannot answer', not as a failure", async () => {
    // Lidarr's parse surface has moved between builds. One *arr lacking it must
    // not throw and take the whole identification ladder down with it.
    const err: any = new HttpError("HTTP 404", 404);
    httpJson.mockRejectedValueOnce(err);
    await expect(new ArrAdapter("lidarr", cfg).parse("anything")).resolves.toBeNull();
  });

  it("propagates a real failure rather than silently reporting 'no idea'", async () => {
    const err: any = new HttpError("HTTP 500", 500);
    httpJson.mockRejectedValueOnce(err);
    await expect(new ArrAdapter("radarr", cfg).parse("anything")).rejects.toBeTruthy();
  });

  it("returns null for a response with nothing parsed in it", async () => {
    httpJson.mockResolvedValueOnce({});
    await expect(new ArrAdapter("radarr", cfg).parse("!!!")).resolves.toBeNull();
  });
});

describe("lookupHits reads file state from the library record, not /lookup", () => {

  it("radarr: lookup row has an id but no hasFile; /movie/{id} says it has a file", async () => {
    httpJson.mockImplementation(async (_b: string, path: string) => {
      if (path.endsWith("/movie/lookup")) return [{ title: "Avengers: Endgame", tmdbId: 299534, id: 244, monitored: true }];
      if (path.endsWith("/movie/244")) return { id: 244, tmdbId: 299534, monitored: true, hasFile: true };
      throw new Error("unexpected " + path);
    });
    const [hit] = await new ArrAdapter("radarr", cfg).lookupHits("Avengers: Endgame");
    expect(hit).toMatchObject({ libraryId: 244, fileCount: 1, monitored: true });
  });

  it("sonarr: zeroed lookup statistics are replaced by the series record's", async () => {
    httpJson.mockImplementation(async (_b: string, path: string) => {
      if (path.endsWith("/series/lookup")) return [{ title: "Adventure Time", tvdbId: 152831, id: 35, monitored: true, statistics: { episodeFileCount: 0 } }];
      if (path.endsWith("/series/35")) return { id: 35, tvdbId: 152831, monitored: true, statistics: { episodeFileCount: 292 },
        seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 26, totalEpisodeCount: 26 } }] };
      throw new Error("unexpected " + path);
    });
    const [hit] = await new ArrAdapter("sonarr", { ...cfg, baseUrl: "http://sonarr:8989" }).lookupHits("Adventure Time");
    expect(hit.fileCount).toBe(292);
    expect(hit.seasons?.[0]).toMatchObject({ seasonNumber: 1, episodeFileCount: 26 });
  });

  it("lidarr: empty lookup statistics; /artist/{id} has the track files", async () => {
    httpJson.mockImplementation(async (_b: string, path: string) => {
      if (path.endsWith("/artist/lookup")) return [{ artistName: "Title Fight", foreignArtistId: "abc", id: 230, monitored: true, statistics: {} }];
      if (path.endsWith("/artist/230")) return { id: 230, foreignArtistId: "abc", monitored: true, statistics: { trackFileCount: 33 } };
      throw new Error("unexpected " + path);
    });
    const [hit] = await new ArrAdapter("lidarr", { ...cfg, baseUrl: "http://lidarr:8686" }).lookupHits("Title Fight");
    expect(hit.fileCount).toBe(33);
  });

  it("a title not in the library is not fetched, and a failing record read keeps the lookup values", async () => {
    httpJson.mockImplementation(async (_b: string, path: string) => {
      if (path.endsWith("/movie/lookup")) return [
        { title: "New", tmdbId: 1 }, { title: "Held", tmdbId: 2, id: 9, monitored: true }];
      throw new Error("boom");
    });
    const hits = await new ArrAdapter("radarr", cfg).lookupHits("x");
    expect(hits.map((h) => h.libraryId)).toEqual([undefined, 9]);
    expect(httpJson.mock.calls.filter((c) => /\/movie\/\d+$/.test(c[1]))).toHaveLength(1);
  });
});
