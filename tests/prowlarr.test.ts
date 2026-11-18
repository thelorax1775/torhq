import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the adapter HTTP client so Prowlarr's responses are driven from the test
// and the exact request TorHQ would send can be asserted — no network.
const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {},
  basicAuth: (s: string) => s,
}));

const { ProwlarrAdapter, normalizeReleases, normalizeIndexer, sortBySeeders, parseIdList } =
  await import("../server/src/adapters/prowlarr.js");

const cfg = { baseUrl: "http://prowlarr:9696", secret: "PROWLARRKEY" };

/** Structurally faithful Prowlarr v1 release resources (trimmed). */
const RELEASES = [
  {
    guid: "https://indexer.example/download.php?id=1",
    indexerId: 2, indexer: "BigFANGroup",
    title: "Blade Runner 2049 2160p",
    size: 8589934592, seeders: 42, leechers: 3,
    protocol: "torrent", publishDate: "2026-07-20T10:00:00Z",
    infoUrl: "https://indexer.example/details/1",
    downloadUrl: "http://prowlarr:9696/2/download?apikey=PROWLARRKEY&link=Q2lYRnBuQ2lj",
    fileName: "Blade Runner 2049 2160p.torrent",
    categories: [{ id: 2000, name: "Movies", subCategories: [{ id: 2040, name: "Movies/HD", subCategories: [] }] }],
  },
  {
    guid: "urn:usenet:2",
    indexerId: 5, indexer: "Newz",
    title: "Blade Runner 2049 1080p",
    size: 4294967296, seeders: null, leechers: null,
    protocol: "usenet", publishDate: "2026-07-19T10:00:00Z",
    downloadUrl: "http://prowlarr:9696/5/download?apikey=PROWLARRKEY&link=abc",
    categories: [{ id: 2000, name: "Movies", subCategories: [] }],
  },
  {
    guid: "https://indexer.example/download.php?id=3",
    indexerId: 2, indexer: "BigFANGroup",
    title: "Blade Runner 2049 720p",
    size: 2147483648, seeders: 900, leechers: 12,
    protocol: "torrent", publishDate: "2026-07-18T10:00:00Z",
    magnetUrl: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    categories: [{ id: 2000, name: "Movies", subCategories: [] }],
  },
];

beforeEach(() => httpJson.mockReset());

describe("normalizeReleases", () => {
  const out = normalizeReleases(RELEASES);

  it("maps a release to the contract's result shape", () => {
    const first = out.find((r) => r.title.endsWith("2160p"))!;
    expect(first).toMatchObject({
      guid: "https://indexer.example/download.php?id=1",
      indexerId: 2,
      indexer: "BigFANGroup",
      size: 8589934592,
      seeders: 42,
      leechers: 3,
      protocol: "torrent",
      publishDate: "2026-07-20T10:00:00Z",
      infoUrl: "https://indexer.example/details/1",
    });
  });

  it("keeps only the categories the release is in, not their subcategories", () => {
    expect(out[0]!.categories).toEqual([{ id: 2000, name: "Movies" }]);
  });

  it("strips the API key out of Prowlarr's download proxy URL", () => {
    // The raw downloadUrl carries ?apikey=... — that must never reach the browser.
    for (const r of out) {
      expect(r.downloadUrl ?? "").not.toContain("PROWLARRKEY");
    }
    const withDownload = out.find((r) => r.guid.endsWith("id=1"))!;
    expect(withDownload.downloadUrl).toContain("/2/download");
    expect(withDownload.downloadUrl).toContain("link=Q2lYRnBuQ2lj");
  });

  it("passes a magnet through when the indexer supplies one, and omits it otherwise", () => {
    const magnetish = out.find((r) => r.title.endsWith("720p"))!;
    expect(magnetish.magnetUrl).toMatch(/^magnet:\?xt=urn:btih:/);
    // Real Prowlarr releases frequently have no magnetUrl at all.
    expect(out.find((r) => r.title.endsWith("2160p"))!.magnetUrl).toBeUndefined();
  });

  it("keeps usenet releases and reports null swarm counts rather than zero", () => {
    const usenet = out.find((r) => r.protocol === "usenet")!;
    expect(usenet.seeders).toBeNull();
    expect(usenet.leechers).toBeNull();
  });

  it("drops entries that cannot be displayed or grabbed", () => {
    expect(normalizeReleases([
      { indexerId: 1, title: "no guid" },
      { guid: "g", indexerId: 1 },              // no title
      { guid: "g", title: "no indexer id" },
      { guid: "g", indexerId: 1, title: "keep me" },
    ])).toHaveLength(1);
  });

  it("tolerates a non-array payload", () => {
    expect(normalizeReleases(undefined)).toEqual([]);
    expect(normalizeReleases({ error: "boom" })).toEqual([]);
  });

  it("rejects a non-http infoUrl (never hand javascript: to the browser)", () => {
    const [r] = normalizeReleases([{ guid: "g", indexerId: 1, title: "t", infoUrl: "javascript:alert(1)" }]);
    expect(r!.infoUrl).toBeUndefined();
  });
});

describe("sortBySeeders", () => {
  it("sorts strongest-seeded first and puts unknown swarms last", () => {
    const titles = sortBySeeders(normalizeReleases(RELEASES)).map((r) => r.title);
    expect(titles).toEqual([
      "Blade Runner 2049 720p",   // 900
      "Blade Runner 2049 2160p",  // 42
      "Blade Runner 2049 1080p",  // usenet, null
    ]);
  });
});

describe("normalizeIndexer", () => {
  it("flattens the capability category tree for the filter UI", () => {
    const i = normalizeIndexer({
      id: 2, name: "BigFANGroup", enable: true, protocol: "torrent",
      capabilities: {
        categories: [
          { id: 2000, name: "Movies", subCategories: [{ id: 2040, name: "Movies/HD", subCategories: [] }] },
          { id: 2000, name: "Movies", subCategories: [] }, // duplicate parent
        ],
      },
    });
    expect(i).toMatchObject({ id: 2, name: "BigFANGroup", enable: true, protocol: "torrent" });
    expect(i.categories).toEqual([{ id: 2000, name: "Movies" }, { id: 2040, name: "Movies/HD" }]);
  });

  it("treats a missing enable flag as disabled", () => {
    expect(normalizeIndexer({ id: 1, name: "x" }).enable).toBe(false);
  });
});

describe("search request building", () => {
  it("repeats indexerIds/categories — Prowlarr rejects comma-separated lists with HTTP 400", async () => {
    httpJson.mockResolvedValue([]);
    await new ProwlarrAdapter(cfg).search("blade", { indexerIds: [2, 3], categories: [2000, 5000] });
    const path = String(httpJson.mock.calls[0]![1]);
    expect(path).toContain("indexerIds=2&indexerIds=3");
    expect(path).toContain("categories=2000&categories=5000");
    expect(path).not.toContain("indexerIds=2%2C3");
    expect(path).toContain("type=search");
  });

  it("falls back to the configured default indexers, and the caller's choice wins", async () => {
    httpJson.mockResolvedValue([]);
    const a = new ProwlarrAdapter({ ...cfg, extra: { defaultIndexerIds: "2, 5", searchLimit: 25 } });
    await a.search("blade");
    expect(String(httpJson.mock.calls[0]![1])).toContain("indexerIds=2&indexerIds=5");
    expect(String(httpJson.mock.calls[0]![1])).toContain("limit=25");

    await a.search("blade", { indexerIds: [9] });
    const second = String(httpJson.mock.calls[1]![1]);
    expect(second).toContain("indexerIds=9");
    expect(second).not.toContain("indexerIds=2");
  });

  it("searches every indexer when no default is configured", async () => {
    httpJson.mockResolvedValue([]);
    await new ProwlarrAdapter(cfg).search("blade");
    const path = String(httpJson.mock.calls[0]![1]);
    expect(path).not.toContain("indexerIds");
    expect(path).toContain("limit=100");
  });

  it("returns normalized, seeders-desc results", async () => {
    httpJson.mockResolvedValue(RELEASES);
    const results = await new ProwlarrAdapter(cfg).search("blade");
    expect(results.map((r) => r.seeders)).toEqual([900, 42, null]);
  });
});

describe("grab", () => {
  it("POSTs guid + indexerId to Prowlarr's search endpoint", async () => {
    httpJson.mockResolvedValue({});
    await new ProwlarrAdapter(cfg).grab("guid-1", 3);
    const [, path, opts] = httpJson.mock.calls[0]!;
    expect(path).toBe("/api/v1/search");
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({ guid: "guid-1", indexerId: 3 });
  });
});

/** Shaped like the live Prowlarr 2.6.5 response for TPB/Knaben (public indexers). */
const PUBLIC = {
  guid: "magnet:?xt=urn:btih:" + "c".repeat(40) + "&dn=Pride+and+Prejudice",
  indexerId: 7, indexer: "The Pirate Bay", title: "Pride and Prejudice - Jane Austen (LibriVox)",
  size: 1000, seeders: 9, leechers: 1, protocol: "torrent", publishDate: "2026-07-20T10:00:00Z",
  magnetUrl: "http://prowlarr:9696/7/download?apikey=PROWLARRKEY&link=bWFnbmV0&file=Pride",
  categories: [{ id: 3030, name: "Audio/Audiobook", subCategories: [] }],
};

describe("public-indexer releases (magnet only in guid)", () => {
  it("uses the guid magnet as magnetUrl and never leaks the proxy link or key", () => {
    const r = normalizeReleases([PUBLIC])[0]!;
    expect(r.magnetUrl).toBe(PUBLIC.guid);
    expect(JSON.stringify(r)).not.toContain("PROWLARRKEY");
    expect(JSON.stringify(r)).not.toContain("/download?");
  });

  it("keeps a real magnetUrl in preference to the guid", () => {
    const real = "magnet:?xt=urn:btih:" + "d".repeat(40);
    expect(normalizeReleases([{ ...PUBLIC, magnetUrl: real }])[0]!.magnetUrl).toBe(real);
  });

  it("treats an http magnetUrl as a downloadUrl (key stripped, re-signable) when guid is no magnet", () => {
    const r = normalizeReleases([{ ...PUBLIC, guid: "https://idx.example/t/1" }])[0]!;
    expect(r.magnetUrl).toBeUndefined();
    expect(r.downloadUrl).toContain("/7/download");
    expect(r.downloadUrl).not.toContain("PROWLARRKEY");
    const signed = new URL(new ProwlarrAdapter(cfg).signDownloadUrl(r.downloadUrl!, 7));
    expect(signed.searchParams.get("apikey")).toBe("PROWLARRKEY");
    expect(signed.searchParams.get("link")).toBe("bWFnbmV0");
  });
});

describe("signDownloadUrl", () => {
  const a = new ProwlarrAdapter(cfg);

  it("re-attaches the API key server-side and preserves the link payload", () => {
    const stripped = normalizeReleases(RELEASES)[0]!.downloadUrl!;
    const signed = new URL(a.signDownloadUrl(stripped, 2));
    expect(signed.searchParams.get("apikey")).toBe("PROWLARRKEY");
    expect(signed.searchParams.get("link")).toBe("Q2lYRnBuQ2lj");
  });

  it("refuses a URL that is not on this Prowlarr (no SSRF via the grab body)", () => {
    expect(() => a.signDownloadUrl("http://169.254.169.254/2/download?link=x", 2))
      .toThrow(/does not belong/);
  });

  it("refuses a URL for a different indexer than the one being grabbed", () => {
    expect(() => a.signDownloadUrl("http://prowlarr:9696/9/download?link=x", 2))
      .toThrow(/does not belong/);
  });

  it("refuses junk", () => {
    expect(() => a.signDownloadUrl("not a url", 2)).toThrow(/not a valid/);
  });
});

describe("parseIdList", () => {
  it("parses a comma-separated list and ignores junk", () => {
    expect(parseIdList("1, 2,3")).toEqual([1, 2, 3]);
    expect(parseIdList("")).toEqual([]);
    expect(parseIdList("a,-1,2")).toEqual([2]);
    expect(parseIdList(undefined)).toEqual([]);
  });
});
