import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Mocked Audiobookshelf + Prowlarr + qBittorrent: nothing touches the network.
const { getAdapter, httpJson } = vi.hoisted(() => ({ getAdapter: vi.fn(), httpJson: vi.fn() }));
vi.mock("../server/src/adapters/registry.js", () => ({
  getAdapter,
  checkAllHealth: vi.fn(async () => ({})),
  testConfig: vi.fn(async () => ({ healthy: true })),
}));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {
    constructor(message: string, readonly statusCode: number, readonly body?: string) { super(message); }
  },
  basicAuth: (s: string) => "Basic " + s,
}));

const { AudiobookshelfAdapter } = await import("../server/src/adapters/audiobookshelf.js");
const { HttpError } = await import("../server/src/adapters/http.js");
const { initDb, getDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");
const { upsertLibrary, getServiceDecrypted } = await import("../server/src/config/store.js");
const { jobs, wantedItems, services } = await import("../server/src/db/schema.js");
const { rankAudiobookReleases, detectAudioFormat, bestAudiobookRelease, AUDIOBOOK_CATEGORIES } = await import("../server/src/lib/audiobooks.js");
const { reconcileWanted, getWanted, tagFor } = await import("../server/src/lib/wanted.js");
const { setWantedDepsForTest } = await import("../server/src/routes/books.js");
const { hubSearch } = await import("../server/src/lib/hub.js");
const { Worker } = await import("../server/src/queue/queue.js");
const { normalizeReleases } = await import("../server/src/adapters/prowlarr.js");

beforeEach(() => httpJson.mockReset());

const rel = (over: Record<string, unknown>) => ({
  guid: "g", indexerId: 1, indexer: "idx", title: "Dune - Frank Herbert (m4b)", size: 1_000_000,
  seeders: 5, leechers: 0, protocol: "torrent", publishDate: null, categories: [{ id: 3030, name: "Audio/Audiobook" }], ...over,
}) as any;

const MAGNET = "magnet:?xt=urn:btih:" + "c".repeat(40);

describe("AudiobookshelfAdapter", () => {
  const abs = () => new AudiobookshelfAdapter({ baseUrl: "http://abs", secret: "TOKEN" });

  it("health makes an authorised call with the bearer token and reports the version", async () => {
    httpJson.mockResolvedValueOnce({ user: { username: "root" }, serverSettings: { version: "2.38.0" } });
    const h = await abs().health();
    expect(h).toMatchObject({ healthy: true, version: "2.38.0" });
    const [base, path, opts] = httpJson.mock.calls[0];
    expect([base, path, opts.method]).toEqual(["http://abs", "/api/authorize", "POST"]);
    expect(opts.headers.authorization).toBe("Bearer TOKEN");
  });

  it("health is unhealthy, in words, when the token is rejected", async () => {
    httpJson.mockRejectedValueOnce(new HttpError("HTTP 401", 401));
    const h = await abs().health();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/token was rejected/);
  });

  it("lists libraries, searches the first book library, and triggers a scan", async () => {
    httpJson.mockResolvedValueOnce({ libraries: [
      { id: "pod", name: "Podcasts", mediaType: "podcast" }, { id: "lib1", name: "Audiobooks", mediaType: "book", extra: 1 },
    ] });
    expect(await abs().libraries()).toEqual([
      { id: "pod", name: "Podcasts", mediaType: "podcast" }, { id: "lib1", name: "Audiobooks", mediaType: "book" },
    ]);

    httpJson.mockReset();
    httpJson
      .mockResolvedValueOnce({ libraries: [{ id: "pod", name: "P", mediaType: "podcast" }, { id: "lib1", name: "A", mediaType: "book" }] })
      .mockResolvedValueOnce({ book: [{ libraryItem: { media: { metadata: { title: "Dune", authorName: "Frank Herbert" } } } }] });
    expect(await abs().searchTitles("dune")).toEqual(["Dune", "Dune Frank Herbert"]);
    const [, path, opts] = httpJson.mock.calls[1];
    expect(path).toBe("/api/libraries/lib1/search");
    expect(opts.query).toMatchObject({ q: "dune" });
    expect(opts.headers.authorization).toBe("Bearer TOKEN");

    httpJson.mockReset();
    httpJson.mockResolvedValueOnce(undefined);
    await new AudiobookshelfAdapter({ baseUrl: "http://abs", secret: "TOKEN", extra: { libraryId: "pinned" } }).scanLibrary();
    expect(httpJson).toHaveBeenCalledTimes(1); // a pinned library needs no lookup
    expect(httpJson.mock.calls[0].slice(0, 2)).toEqual(["http://abs", "/api/libraries/pinned/scan"]);
    expect(httpJson.mock.calls[0][2].method).toBe("POST");
  });
});

describe("audiobook ranking", () => {
  it("detects the best audio format", () => {
    expect(detectAudioFormat("Dune [M4B]")).toBe("m4b");
    expect(detectAudioFormat("Dune MP3 128kbps")).toBe("mp3");
    expect(detectAudioFormat("Dune mp3 + m4b")).toBe("m4b");
    expect(detectAudioFormat("Dune unabridged")).toBeNull();
    expect([...AUDIOBOOK_CATEGORIES]).toEqual([3030]);
  });

  it("m4b beats an mp3 folder even when the mp3 has more seeders; dead and usenet drop", () => {
    const ranked = rankAudiobookReleases([
      rel({ guid: "mp3-many", title: "Dune Frank Herbert mp3", seeders: 400 }),
      rel({ guid: "m4b-few", title: "Dune Frank Herbert m4b", seeders: 3 }),
      rel({ guid: "m4b-many", title: "Dune Frank Herbert m4b", seeders: 30 }),
      rel({ guid: "mp3-few", title: "Dune Frank Herbert mp3", seeders: 6 }),
      rel({ guid: "dead-m4b", title: "Dune Frank Herbert m4b", seeders: 0 }),
      rel({ guid: "usenet", title: "Dune Frank Herbert m4b", protocol: "usenet" }),
      rel({ guid: "wrong", title: "Foundation m4b", seeders: 900 }),
    ], { title: "Dune" });
    expect(ranked.map((r) => r.guid)).toEqual(["m4b-many", "m4b-few", "mp3-many", "mp3-few", "dead-m4b", "wrong"]);
    expect(bestAudiobookRelease(ranked)?.guid).toBe("m4b-many");
    expect(bestAudiobookRelease(rankAudiobookReleases([rel({ title: "Foundation m4b" })], { title: "Dune" }))).toBeNull();
  });
});

describe("hub: audiobook status from Audiobookshelf", () => {
  const base: any = {
    arr: () => null, tmdb: () => null, rawg: () => null, prowlarrConfigured: () => true,
    openLibrary: {
      search: async () => [
        { id: "OL1W", title: "Dune", author: "Frank Herbert" },
        { id: "OL2W", title: "Emma", author: "Jane Austen" },
        { id: "OL3W", title: "Persuasion", author: "Jane Austen" },
      ],
      work: async () => null,
    },
    savedDefaults: () => ({}), timeoutMs: 500,
  };
  it("held -> available; wanted -> its status; otherwise actionable", async () => {
    const r = await hubSearch({
      ...base,
      audiobooks: { ready: () => true, libraryTitles: async () => ["Dune Frank Herbert"], wanted: (id: string) => (id === "OL2W" ? { status: "grabbed" } : undefined) },
    }, "x", ["audiobook"]);
    const by = (t: string) => r.results.find((x) => x.title === t)!;
    expect(by("Dune")).toMatchObject({ kind: "audiobook", status: "available", actionable: false });
    expect(by("Emma")).toMatchObject({ status: "downloading", actionable: false });
    expect(by("Persuasion")).toMatchObject({ status: "none", actionable: true });
  });
  it("is unknown when ABS is not configured or down, and not actionable without Prowlarr/qBittorrent", async () => {
    const none = await hubSearch({ ...base, audiobooks: { ready: () => true, libraryTitles: async () => null, wanted: () => undefined } }, "x", ["audiobook"]);
    expect(none.results[0]).toMatchObject({ status: "unknown", actionable: true });
    const down = await hubSearch({ ...base, audiobooks: { ready: () => true, libraryTitles: async () => { throw new Error("x"); }, wanted: () => undefined } }, "x", ["audiobook"]);
    expect(down.results[0]!.status).toBe("unknown");
    const notReady = await hubSearch({ ...base, audiobooks: { ready: () => false, libraryTitles: async () => [], wanted: () => undefined } }, "x", ["audiobook"]);
    expect(notReady.results[0]).toMatchObject({ status: "none", actionable: false });
  });
  it("an ebook with the same Open Library id never marks the audiobook as wanted", async () => {
    const r = await hubSearch({ ...base, books: { ready: () => true, libraryTitles: async () => ["Dune"], wanted: () => ({ status: "imported" }) } }, "x", ["audiobook"]);
    expect(r.results[0]).toMatchObject({ kind: "audiobook", status: "unknown", actionable: false });
  });
});

describe("audiobooks flow: request -> grab -> download -> preview -> approve -> scan", () => {
  let app: FastifyInstance, root: string, env: any;
  let adminCookie = "", adminCsrf = "", memberCookie = "", memberCsrf = "";
  let adapters: Record<string, any>;
  let torrents: any[];
  const added: any[] = [];
  const LIB = () => ({
    key: "abs-audiobooks", label: "Audiobooks", kind: "audiobooks", targetService: "audiobookshelf",
    destPath: join(root, "library/audiobooks"), stagingPath: join(root, "staging/audiobooks"), rescan: true, importMode: "move",
  }) as const;

  const h = (cookie: string, csrf?: string) => ({ cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) });
  const post = (url: string, cookie: string, csrf: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: h(cookie, csrf), payload: payload as any });
  const ls = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
  const reconcile = () => reconcileWanted({ qb: () => ({ torrents: async () => torrents }), approvedRoots: [root] });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "torhq-audiobooks-"));
    for (const d of ["data", "downloads/torhq-audiobooks", "library/audiobooks", "staging/audiobooks"]) mkdirSync(join(root, d), { recursive: true });
    env = loadEnv({
      NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789",
      TORHQ_DATA_DIR: join(root, "data"), TORHQ_APPROVED_ROOTS: root,
    } as any);
    initDb(env.TORHQ_DATA_DIR);
    runMigrations();
    upsertLibrary(LIB());
    app = await buildApp(makeContext(env));
    await app.ready();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
    adminCsrf = reg.json().csrfToken;
    adminCookie = reg.cookies[0]!.name + "=" + reg.cookies[0]!.value;
    await app.inject({ method: "POST", url: "/api/users", headers: h(adminCookie, adminCsrf), payload: { username: "friend", password: "friendpass1" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "friend", password: "friendpass1" } });
    memberCsrf = login.json().csrfToken;
    memberCookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value;
  });
  afterAll(async () => {
    setWantedDepsForTest(null);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    added.length = 0;
    torrents = [];
    getDb().delete(wantedItems).run();
    getDb().delete(jobs).run();
    const prowlarr = {
      search: vi.fn(async () => [
        rel({ guid: "mp3", indexerId: 3, title: "Dune Frank Herbert mp3", seeders: 500 }),
        rel({ guid: "m4b", indexerId: 3, title: "Dune Frank Herbert m4b", seeders: 8 }),
      ]),
      signDownloadUrl: vi.fn((u: string) => u + "&apikey=K"),
    };
    const qb = {
      addTorrent: vi.fn(async (a: any) => { added.push(a); }),
      categories: vi.fn(async () => ({ "torhq-audiobooks": { name: "torhq-audiobooks", savePath: join(root, "downloads/torhq-audiobooks") } })),
      torrents: vi.fn(async () => torrents),
    };
    const audiobookshelf = { scanLibrary: vi.fn(async () => undefined), searchTitles: vi.fn(async () => []) };
    adapters = { prowlarr, qbittorrent: qb, audiobookshelf };
    getAdapter.mockImplementation((k: string) => adapters[k] ?? null);
    setWantedDepsForTest({ qb: () => qb as any, approvedRoots: [root] });
  });

  async function request(title = "Dune", author = "Frank Herbert", externalId = "OL1W"): Promise<string> {
    const r = await post("/api/audiobooks/request", memberCookie, memberCsrf, { title, author, externalId });
    expect(r.statusCode).toBe(200);
    return r.json().item.id;
  }
  const grab = (id: string) => post(`/api/audiobooks/wanted/${id}/grab`, adminCookie, adminCsrf, { guid: "m4b", indexerId: 3, magnet: MAGNET, title: "Dune Frank Herbert m4b" });
  function finishDownload(id: string, folder = true): string {
    const dir = join(root, "downloads/torhq-audiobooks", "Dune - Frank Herbert");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dune.m4b"), "audio bytes");
    const content = folder ? dir : join(dir, "Dune.m4b");
    torrents = [{
      hash: "h".repeat(40), name: "Dune - Frank Herbert", category: "torhq-audiobooks", state: "stalledUP", progress: 1,
      savePath: join(root, "downloads/torhq-audiobooks"), contentPath: content, tags: [tagFor(id)], addedOn: 1,
    }];
    return content;
  }

  it("a member requests an audiobook; it is its own kind, separate from the ebook of the same work", async () => {
    const id = await request();
    expect(getWanted(id)).toMatchObject({ kind: "audiobook", externalId: "OL1W" });
    const ebook = await post("/api/books/request", memberCookie, memberCsrf, { title: "Dune", author: "Frank Herbert", externalId: "OL1W" });
    expect(ebook.json()).toMatchObject({ existing: false });
    expect(ebook.json().item.id).not.toBe(id);
    const aud = await app.inject({ method: "GET", url: "/api/audiobooks/wanted", headers: h(memberCookie) });
    expect(aud.json().items.map((i: any) => i.id)).toEqual([id]);
    const books = await app.inject({ method: "GET", url: "/api/books/wanted", headers: h(memberCookie) });
    expect(books.json().items.map((i: any) => i.id)).toEqual([ebook.json().item.id]);
  });

  it("search uses Prowlarr category 3030 and ranks m4b over a better-seeded mp3", async () => {
    const id = await request();
    const r = await post(`/api/audiobooks/wanted/${id}/search`, adminCookie, adminCsrf);
    expect(r.statusCode).toBe(200);
    expect(adapters.prowlarr.search).toHaveBeenCalledWith("Dune Frank Herbert", { categories: [3030] });
    expect(r.json().releases.map((x: any) => x.guid)).toEqual(["m4b", "mp3"]);
    expect(r.json().bestGuid).toBe("m4b");
  });

  it("grab goes to qBittorrent category torhq-audiobooks, tagged for this item", async () => {
    const id = await request();
    expect((await grab(id)).statusCode).toBe(200);
    expect(added).toEqual([{ url: MAGNET, category: "torhq-audiobooks", tags: [tagFor(id)] }]);
    expect(getWanted(id)).toMatchObject({ status: "grabbed", releaseFormat: "m4b", qbCategory: "torhq-audiobooks" });
  });

  it("grabs a public-indexer (TPB/Knaben-style) release whose magnet was only in the Prowlarr guid", async () => {
    const guid = "magnet:?xt=urn:btih:" + "c".repeat(40) + "&dn=Dune";
    const [r] = normalizeReleases([{
      guid, indexerId: 7, indexer: "Knaben", title: "Dune Frank Herbert LibriVox m4b", seeders: 9, protocol: "torrent",
      magnetUrl: "http://prowlarr:9696/7/download?apikey=SECRET&link=abc&file=Dune",
      categories: [{ id: 3030, name: "Audio/Audiobook" }],
    }]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    const id = await request();
    const res = await post(`/api/audiobooks/wanted/${id}/grab`, adminCookie, adminCsrf,
      { guid: r!.guid, indexerId: r!.indexerId, ...(r!.magnetUrl ? { magnet: r!.magnetUrl } : {}), title: r!.title });
    expect(res.statusCode).toBe(200);
    expect(added).toEqual([{ url: guid, category: "torhq-audiobooks", tags: [tagFor(id)] }]);
  });

  it("an ebook id on an audiobook route (and the reverse) is a 404, never a cross-kind action", async () => {
    const book = (await post("/api/books/request", memberCookie, memberCsrf, { title: "Emma" })).json().item.id;
    expect((await post(`/api/audiobooks/wanted/${book}/grab`, adminCookie, adminCsrf, { guid: "x", indexerId: 1, magnet: MAGNET, title: "t" })).statusCode).toBe(404);
    expect((await post(`/api/audiobooks/wanted/${book}/approve`, adminCookie, adminCsrf)).statusCode).toBe(404);
    const aud = await request();
    expect((await post(`/api/books/wanted/${aud}/search`, adminCookie, adminCsrf)).statusCode).toBe(404);
    expect(added).toHaveLength(0);
  });

  it("completion builds a preview at Author/Title and NOTHING moves, or is scanned, until approval", async () => {
    const id = await request();
    await grab(id);
    const src = finishDownload(id);
    expect((await reconcile()).ready).toBe(1);
    const w = getWanted(id)!;
    expect(w).toMatchObject({ status: "ready", libraryKey: "abs-audiobooks", sourcePath: src });
    expect(JSON.parse(w.previewJson!)).toMatchObject({ destPath: join(root, "library/audiobooks/Frank Herbert/Dune"), importMode: "move" });

    // Preview only: library and download are untouched, no job, no scan.
    expect(ls(join(root, "library/audiobooks"))).toEqual([]);
    expect(existsSync(join(src, "Dune.m4b"))).toBe(true);
    expect(getDb().select().from(jobs).all()).toHaveLength(0);
    await reconcile();
    expect(getDb().select().from(jobs).all()).toHaveLength(0);
    expect(adapters.audiobookshelf.scanLibrary).not.toHaveBeenCalled();

    // The member sees the status, never a path.
    const memberView = (await app.inject({ method: "GET", url: "/api/audiobooks/wanted", headers: h(memberCookie) })).json().items[0];
    expect(memberView.status).toBe("ready");
    expect(JSON.stringify(memberView)).not.toContain(root);

    // Approve only queues the job; the worker moves the files and then asks ABS to scan.
    expect((await post(`/api/audiobooks/wanted/${id}/approve`, adminCookie, adminCsrf)).statusCode).toBe(200);
    expect(getWanted(id)!.status).toBe("importing");
    expect(ls(join(root, "library/audiobooks"))).toEqual([]);
    expect(adapters.audiobookshelf.scanLibrary).not.toHaveBeenCalled();

    await new Worker([root], Buffer.alloc(32)).tick();
    expect(ls(join(root, "library/audiobooks/Frank Herbert"))).toEqual(["Dune"]);
    expect(ls(join(root, "library/audiobooks/Frank Herbert/Dune"))).toEqual(["Dune.m4b"]);
    expect(existsSync(src)).toBe(false);
    expect(adapters.audiobookshelf.scanLibrary).toHaveBeenCalledTimes(1);

    await reconcile();
    expect(getWanted(id)!.status).toBe("imported");
  });

  it("a lone m4b file is placed inside Author/Title/", async () => {
    const id = await request();
    await grab(id);
    const file = finishDownload(id, false);
    await reconcile();
    expect(JSON.parse(getWanted(id)!.previewJson!).destPath).toBe(join(root, "library/audiobooks/Frank Herbert/Dune/Dune.m4b"));
    await post(`/api/audiobooks/wanted/${id}/approve`, adminCookie, adminCsrf);
    await new Worker([root], Buffer.alloc(32)).tick();
    expect(ls(join(root, "library/audiobooks/Frank Herbert/Dune"))).toEqual(["Dune.m4b"]);
    expect(existsSync(file)).toBe(false);
  });

  it("an author with path characters cannot escape the library", async () => {
    const r = await post("/api/audiobooks/request", memberCookie, memberCsrf, { title: "Evil", author: "../../etc" });
    const id = r.json().item.id;
    await grab(id);
    const dir = join(root, "downloads/torhq-audiobooks", "Evil");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.mp3"), "x");
    torrents = [{ hash: "e".repeat(40), name: "Evil", category: "torhq-audiobooks", state: "stalledUP", progress: 1,
      savePath: join(root, "downloads/torhq-audiobooks"), contentPath: dir, tags: [tagFor(id)], addedOn: 1 }];
    await reconcile();
    const dest = JSON.parse(getWanted(id)!.previewJson!).destPath as string;
    expect(dest.startsWith(join(root, "library/audiobooks") + "/")).toBe(true);
    expect(dest).not.toContain("..");
  });

  it("an author with a slash keeps the whole name (slashes become underscores)", async () => {
    const id = await request("Live", "AC/DC");
    await grab(id);
    const dir = join(root, "downloads/torhq-audiobooks", "Live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.m4b"), "x");
    torrents = [{ hash: "a".repeat(40), name: "Live", category: "torhq-audiobooks", state: "stalledUP", progress: 1,
      savePath: join(root, "downloads/torhq-audiobooks"), contentPath: dir, tags: [tagFor(id)], addedOn: 1 }];
    await reconcile();
    const dest = JSON.parse(getWanted(id)!.previewJson!).destPath as string;
    expect(dest).toBe(join(root, "library/audiobooks/AC_DC/Live"));
  });

  it("status reports what is missing", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/audiobooks/status", headers: h(adminCookie) });
    expect(ok.json()).toMatchObject({ ready: true, category: "torhq-audiobooks", categoryExists: true, library: { key: "abs-audiobooks" } });
    adapters.qbittorrent.categories = vi.fn(async () => ({}));
    const bad = await app.inject({ method: "GET", url: "/api/audiobooks/status", headers: h(adminCookie) });
    expect(bad.json().ready).toBe(false);
    expect(bad.json().problems.join(" ")).toMatch(/torhq-audiobooks/);
  });

  it("Audiobookshelf is configurable in Services: the token is encrypted at rest and masked on read", async () => {
    const save = await post("/api/services", adminCookie, adminCsrf, {
      kind: "audiobookshelf", label: "Audiobookshelf", baseUrl: "http://abs:13378", secret: "SUPERSECRETTOKEN123", extra: { libraryId: "lib-1" },
    });
    expect(save.statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: "/api/services", headers: h(adminCookie) })).json().services.find((s: any) => s.kind === "audiobookshelf");
    expect(list.extra).toEqual({ libraryId: "lib-1" });
    expect(JSON.stringify(list)).not.toContain("SUPERSECRETTOKEN123");
    expect(list.secretMask).toBeTruthy();
    const row = getDb().select().from(services).all().find((s) => s.kind === "audiobookshelf")!;
    expect(row.secretEnc).not.toContain("SUPERSECRETTOKEN123");
    expect(getServiceDecrypted("audiobookshelf", makeContext(env).masterKey)?.secret).toBe("SUPERSECRETTOKEN123");
  });

  it("an audiobooks library can be created targeting Audiobookshelf", async () => {
    const r = await post("/api/libraries", adminCookie, adminCsrf, { ...LIB(), key: "abs-two" });
    expect(r.statusCode).toBe(200);
  });

  describe("access", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    it.each([
      ["GET", "/api/audiobooks/status"],
      ["POST", `/api/audiobooks/wanted/${id}/search`],
      ["POST", `/api/audiobooks/wanted/${id}/grab`],
      ["POST", `/api/audiobooks/wanted/${id}/approve`],
      ["POST", `/api/audiobooks/wanted/${id}/decline`],
    ])("%s %s is 403 for a member and 401 with no session", async (method, url) => {
      const payload = method === "POST" ? {} : undefined;
      const m = await app.inject({ method: method as any, url, headers: h(memberCookie, memberCsrf), payload });
      expect(m.statusCode).toBe(403);
      const n = await app.inject({ method: method as any, url, payload });
      expect(n.statusCode).toBe(401);
    });
    it("a member may list, and request only with a session and CSRF", async () => {
      expect((await app.inject({ method: "GET", url: "/api/audiobooks/wanted", headers: h(memberCookie) })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/audiobooks/wanted" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/audiobooks/request", headers: h(memberCookie), payload: { title: "X" } })).statusCode).toBe(403);
    });
  });
});
