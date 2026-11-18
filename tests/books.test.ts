import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Mocked Prowlarr + qBittorrent behind the adapter registry: the routes and the
// wanted-item state machine are under test, nothing touches the network.
const { getAdapter } = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("../server/src/adapters/registry.js", () => ({
  getAdapter,
  checkAllHealth: vi.fn(async () => ({})),
  testConfig: vi.fn(async () => ({ healthy: true })),
}));

const { initDb, getDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");
const { upsertLibrary } = await import("../server/src/config/store.js");
const { jobs, wantedItems } = await import("../server/src/db/schema.js");
const { rankBookReleases, detectFormat, bestBookRelease, bookQuery, BOOK_CATEGORIES } = await import("../server/src/lib/books.js");
const { reconcileWanted, getWanted, tagFor } = await import("../server/src/lib/wanted.js");
const { setWantedDepsForTest } = await import("../server/src/routes/books.js");
const { hubSearch, libraryHolds } = await import("../server/src/lib/hub.js");
const { parseOpdsTitles } = await import("../server/src/adapters/calibreweb.js");
const { Worker } = await import("../server/src/queue/queue.js");

const rel = (over: Record<string, unknown>) => ({
  guid: "g", indexerId: 1, indexer: "idx", title: "Dune - Frank Herbert (epub)", size: 1_000_000,
  seeders: 5, leechers: 0, protocol: "torrent", publishDate: null, categories: [{ id: 7020, name: "Books/EBook" }], ...over,
}) as any;

const MAGNET_B = "magnet:?xt=urn:btih:" + "b".repeat(40);

describe("ranking", () => {
  it("detects the best format in a release name", () => {
    expect(detectFormat("Dune [EPUB]")).toBe("epub");
    expect(detectFormat("Dune.AZW3")).toBe("azw3");
    expect(detectFormat("Dune pdf, mobi, epub pack")).toBe("epub");
    expect(detectFormat("Dune (2021) 1080p")).toBeNull();
    expect(detectFormat("Dune epubs")).toBeNull(); // a word, not a format
  });

  it("ranks epub > azw3 > mobi > pdf, then seeders; dead or usenet releases drop down or out", () => {
    const ranked = rankBookReleases([
      rel({ guid: "pdf-many", title: "Dune Frank Herbert pdf", seeders: 900 }),
      rel({ guid: "mobi", title: "Dune Frank Herbert mobi", seeders: 50 }),
      rel({ guid: "epub-few", title: "Dune Frank Herbert epub", seeders: 2 }),
      rel({ guid: "epub-many", title: "Dune Frank Herbert epub", seeders: 40 }),
      rel({ guid: "azw3", title: "Dune Frank Herbert azw3", seeders: 10 }),
      rel({ guid: "dead-epub", title: "Dune Frank Herbert epub", seeders: 0 }),
      rel({ guid: "nofmt", title: "Dune Frank Herbert collection", seeders: 30 }),
      rel({ guid: "usenet", title: "Dune Frank Herbert epub", protocol: "usenet", seeders: null }),
    ], { title: "Dune" });
    expect(ranked.map((r) => r.guid)).toEqual([
      "epub-many", "epub-few", "azw3", "mobi", "pdf-many", "nofmt", "dead-epub",
    ]);
  });

  it("a release for a different title never outranks a match, and is never the best match", () => {
    const r = rankBookReleases([
      rel({ guid: "wrong", title: "Foundation epub", seeders: 500 }),
      rel({ guid: "right", title: "Dune pdf", seeders: 3 }),
    ], { title: "Dune" });
    expect(r.map((x) => x.guid)).toEqual(["right", "wrong"]);
    expect(bestBookRelease(r)?.guid).toBe("right");
    expect(bestBookRelease(rankBookReleases([rel({ title: "Foundation epub" })], { title: "Dune" }))).toBeNull();
    expect(bestBookRelease(rankBookReleases([rel({ title: "Dune epub", seeders: 0 })], { title: "Dune" }))).toBeNull();
  });

  it("builds a title+author query and searches the book categories", () => {
    expect(bookQuery("Dune: Messiah", "Frank Herbert")).toBe("Dune Messiah Frank Herbert");
    expect([...BOOK_CATEGORIES]).toEqual([7000, 7020, 8000]);
  });
});

describe("Calibre-Web OPDS", () => {
  it("reads entry titles, not the feed title", () => {
    const xml = `<feed><title>Search</title><entry><title>Dune &amp; Co</title></entry><entry><title>Emma</title></entry></feed>`;
    expect(parseOpdsTitles(xml)).toEqual(["Dune & Co", "Emma"]);
  });
});

describe("hub: book status from the libraries", () => {
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
  it("held -> available; wanted -> its status; otherwise none and actionable", async () => {
    const r = await hubSearch({
      ...base,
      books: {
        ready: () => true,
        libraryTitles: async () => ["Dune", "Other"],
        wanted: (id: string) => (id === "OL2W" ? { status: "grabbed" } : undefined),
      },
    }, "x", ["book"]);
    const by = (t: string) => r.results.find((x) => x.title === t)!;
    expect(by("Dune")).toMatchObject({ status: "available", actionable: false });
    expect(by("Emma")).toMatchObject({ status: "downloading", actionable: false });
    expect(by("Persuasion")).toMatchObject({ status: "none", actionable: true });
  });
  it("is unknown when no library answers, and not actionable when Prowlarr/qBittorrent are missing", async () => {
    const none = await hubSearch({ ...base, books: { ready: () => true, libraryTitles: async () => null, wanted: () => undefined } }, "x", ["book"]);
    expect(none.results[0]).toMatchObject({ status: "unknown", actionable: true });
    const notReady = await hubSearch({ ...base, books: { ready: () => false, libraryTitles: async () => [], wanted: () => undefined } }, "x", ["book"]);
    expect(notReady.results[0]).toMatchObject({ status: "none", actionable: false });
    const down = await hubSearch({ ...base, books: { ready: () => true, libraryTitles: async () => { throw new Error("boom"); }, wanted: () => undefined } }, "x", ["book"]);
    expect(down.results[0]!.status).toBe("unknown");
  });
  it("matches titles ignoring case and a leading article, but not a longer title", () => {
    expect(libraryHolds(["The Dune"], "Dune")).toBe(true);
    expect(libraryHolds(["Dune Frank Herbert"], "Dune", "Frank Herbert")).toBe(true);
    expect(libraryHolds(["Dune Messiah"], "Dune")).toBe(false);
  });
});

describe("books flow: request -> grab -> download -> preview -> approve", () => {
  let app: FastifyInstance, root: string;
  let adminCookie = "", adminCsrf = "", memberCookie = "", memberCsrf = "";
  let adapters: Record<string, any>;
  let torrents: any[];
  const added: any[] = [];

  const h = (cookie: string, csrf?: string) => ({ cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) });
  const post = (url: string, cookie: string, csrf: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: h(cookie, csrf), payload: payload as any });
  const ls = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
  const reconcile = () => reconcileWanted({ qb: () => ({ torrents: async () => torrents }), approvedRoots: [root] });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "torhq-books-"));
    for (const d of ["data", "downloads/torhq-books", "library/books", "staging/books"]) mkdirSync(join(root, d), { recursive: true });
    const env = loadEnv({
      NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789",
      TORHQ_DATA_DIR: join(root, "data"), TORHQ_APPROVED_ROOTS: root,
    } as any);
    initDb(env.TORHQ_DATA_DIR);
    runMigrations();
    upsertLibrary({
      key: "kavita-books", label: "Books", kind: "books", targetService: "kavita",
      destPath: join(root, "library/books"), stagingPath: join(root, "staging/books"), rescan: false, importMode: "move",
    });
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
        rel({ guid: "pdf", indexerId: 3, title: "Dune Frank Herbert pdf", seeders: 500 }),
        rel({ guid: "epub", indexerId: 3, title: "Dune Frank Herbert epub", seeders: 8 }),
      ]),
      signDownloadUrl: vi.fn((u: string) => u + "&apikey=K"),
    };
    const qb = {
      addTorrent: vi.fn(async (a: any) => { added.push(a); }),
      categories: vi.fn(async () => ({ "torhq-books": { name: "torhq-books", savePath: join(root, "downloads/torhq-books") } })),
      torrents: vi.fn(async () => torrents),
    };
    adapters = { prowlarr, qbittorrent: qb };
    getAdapter.mockImplementation((k: string) => adapters[k] ?? null);
    setWantedDepsForTest({ qb: () => qb as any, approvedRoots: [root] });
  });

  async function request(): Promise<string> {
    const r = await post("/api/books/request", memberCookie, memberCsrf, { title: "Dune", author: "Frank Herbert", externalId: "OL1W" });
    expect(r.statusCode).toBe(200);
    return r.json().item.id;
  }
  async function grab(id: string) {
    return post(`/api/books/wanted/${id}/grab`, adminCookie, adminCsrf, { guid: "epub", indexerId: 3, magnet: MAGNET_B, title: "Dune Frank Herbert epub" });
  }
  function finishDownload(id: string): string {
    const dir = join(root, "downloads/torhq-books", "Dune - Frank Herbert");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dune.epub"), "epub bytes");
    torrents = [{
      hash: "h".repeat(40), name: "Dune - Frank Herbert", category: "torhq-books", state: "stalledUP", progress: 1,
      savePath: join(root, "downloads/torhq-books"), contentPath: dir, tags: [tagFor(id)], addedOn: 1,
    }];
    return dir;
  }

  it("a member requests; a duplicate returns the same item; a member sees only their own, without paths", async () => {
    const id = await request();
    const again = await post("/api/books/request", adminCookie, adminCsrf, { title: "dune", author: "frank herbert" });
    expect(again.json()).toMatchObject({ existing: true, item: { id } });
    await post("/api/books/request", adminCookie, adminCsrf, { title: "Emma" });
    const asAdmin = await app.inject({ method: "GET", url: "/api/books/wanted", headers: h(adminCookie) });
    expect(asAdmin.json().items).toHaveLength(2);
    const asMember = await app.inject({ method: "GET", url: "/api/books/wanted", headers: h(memberCookie) });
    expect(asMember.json().items.map((i: any) => i.title)).toEqual(["Dune"]);
    expect(asMember.json().items[0]).not.toHaveProperty("preview");
  });

  it("search is restricted to the book categories, uses title+author, and offers the best match", async () => {
    const id = await request();
    const r = await post(`/api/books/wanted/${id}/search`, adminCookie, adminCsrf);
    expect(r.statusCode).toBe(200);
    expect(adapters.prowlarr.search).toHaveBeenCalledWith("Dune Frank Herbert", { categories: [7000, 7020, 8000] });
    expect(r.json().releases.map((x: any) => x.guid)).toEqual(["epub", "pdf"]); // epub beats a better-seeded pdf
    expect(r.json().bestGuid).toBe("epub");
  });

  it("grab goes to qBittorrent category torhq-books, tagged for this item", async () => {
    const id = await request();
    const r = await grab(id);
    expect(r.statusCode).toBe(200);
    expect(added).toEqual([{ url: MAGNET_B, category: "torhq-books", tags: [tagFor(id)] }]);
    expect(getWanted(id)).toMatchObject({ status: "grabbed", releaseFormat: "epub", qbCategory: "torhq-books" });
  });

  it("a re-grab drops the old torrent: the preview is built from the new release, not the first", async () => {
    const id = await request();
    await grab(id);
    const mk = (hash: string, name: string, addedOn: number) => {
      const dir = join(root, "downloads/torhq-books", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.epub`), "bytes");
      return { hash: hash.repeat(40), name, category: "torhq-books", state: "stalledUP", progress: 1,
        savePath: join(root, "downloads/torhq-books"), contentPath: dir, tags: [tagFor(id)], addedOn };
    };
    const a = mk("a", "Dune-A", 1);
    torrents = [{ ...a, state: "downloading", progress: 0.2 }];
    await reconcile(); // pins A's hash
    expect(getWanted(id)!.torrentHash).toBe("a".repeat(40));

    await grab(id); // re-grab B while A is still listed
    expect(getWanted(id)).toMatchObject({ status: "grabbed", torrentHash: null, previewJson: null });
    const b = mk("b", "Dune-B", 2);
    torrents = [a, b];
    expect((await reconcile()).ready).toBe(1);
    expect(getWanted(id)!.torrentHash).toBe("b".repeat(40));
    expect(getWanted(id)!.sourcePath).toBe(b.contentPath);
  });

  it("rejects a non-magnet url smuggled into the grab", async () => {
    const id = await request();
    const r = await post(`/api/books/wanted/${id}/grab`, adminCookie, adminCsrf, { guid: "x", indexerId: 3, magnet: "http://evil/x", title: "t" });
    expect(r.statusCode).toBe(400);
    expect(added).toHaveLength(0);
  });

  it("a finished download becomes a dry-run preview and NOTHING moves until approval", async () => {
    const id = await request();
    await grab(id);

    // still downloading: no preview
    torrents = [{
      hash: "h".repeat(40), name: "Dune", category: "torhq-books", state: "downloading", progress: 0.4,
      savePath: join(root, "downloads/torhq-books"), contentPath: join(root, "downloads/torhq-books/Dune"), tags: [tagFor(id)], addedOn: 1,
    }];
    await reconcile();
    expect(getWanted(id)!.status).toBe("grabbed");

    const src = finishDownload(id);
    expect((await reconcile()).ready).toBe(1);
    const w = getWanted(id)!;
    expect(w).toMatchObject({ status: "ready", libraryKey: "kavita-books", sourcePath: src });
    expect(JSON.parse(w.previewJson!)).toMatchObject({ destPath: join(root, "library/books/Dune - Frank Herbert"), importMode: "move" });

    // The preview exists; the library and the download are exactly as they were.
    expect(ls(join(root, "library/books"))).toEqual([]);
    expect(existsSync(join(src, "Dune.epub"))).toBe(true);
    expect(getDb().select().from(jobs).all()).toHaveLength(0);
    // Running the reconciler again changes nothing either.
    await reconcile();
    expect(getDb().select().from(jobs).all()).toHaveLength(0);

    // The admin sees the preview; the member sees the status but no path.
    const adminView = (await app.inject({ method: "GET", url: "/api/books/wanted", headers: h(adminCookie) })).json().items[0];
    expect(adminView.status).toBe("ready");
    expect(adminView.preview.destPath).toContain("library/books");
    const memberView = (await app.inject({ method: "GET", url: "/api/books/wanted", headers: h(memberCookie) })).json().items[0];
    expect(memberView.status).toBe("ready");
    expect(JSON.stringify(memberView)).not.toContain(root);

    // Approve queues the normal intake job; only the worker moves files.
    expect((await post(`/api/books/wanted/${id}/approve`, adminCookie, adminCsrf)).statusCode).toBe(200);
    expect(getWanted(id)!.status).toBe("importing");
    expect(ls(join(root, "library/books"))).toEqual([]);
    await new Worker([root], Buffer.alloc(32)).tick();
    expect(ls(join(root, "library/books"))).toEqual(["Dune - Frank Herbert"]);
    expect(existsSync(src)).toBe(false); // move mode consumed the download

    await reconcile();
    expect(getWanted(id)!.status).toBe("imported");
  });

  it("approve is refused before the preview exists, and a second approve is refused", async () => {
    const id = await request();
    expect((await post(`/api/books/wanted/${id}/approve`, adminCookie, adminCsrf)).statusCode).toBe(409);
    await grab(id);
    finishDownload(id);
    await reconcile();
    expect((await post(`/api/books/wanted/${id}/approve`, adminCookie, adminCsrf)).statusCode).toBe(200);
    expect((await post(`/api/books/wanted/${id}/approve`, adminCookie, adminCsrf)).statusCode).toBe(409);
    expect(getDb().select().from(jobs).all()).toHaveLength(1);
  });

  it("a download outside the approved roots never gets a preview", async () => {
    const id = await request();
    await grab(id);
    const outside = mkdtempSync(join(tmpdir(), "torhq-outside-"));
    writeFileSync(join(outside, "Dune.epub"), "x");
    torrents = [{
      hash: "h".repeat(40), name: "x", category: "torhq-books", state: "stalledUP", progress: 1,
      savePath: outside, contentPath: outside, tags: [tagFor(id)], addedOn: 1,
    }];
    await reconcile();
    const w = getWanted(id)!;
    expect(w.status).toBe("grabbed");
    expect(w.error).toBeTruthy();
    rmSync(outside, { recursive: true, force: true });
  });

  it("status reports what is missing", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/books/status", headers: h(adminCookie) });
    expect(ok.json()).toMatchObject({ ready: true, category: "torhq-books", categoryExists: true, library: { key: "kavita-books" } });
    adapters.qbittorrent.categories = vi.fn(async () => ({}));
    const bad = await app.inject({ method: "GET", url: "/api/books/status", headers: h(adminCookie) });
    expect(bad.json().ready).toBe(false);
    expect(bad.json().problems.join(" ")).toMatch(/torhq-books/);
  });

  it("decline marks the request declined", async () => {
    const id = await request();
    expect((await post(`/api/books/wanted/${id}/decline`, adminCookie, adminCsrf)).statusCode).toBe(200);
    expect(getWanted(id)!.status).toBe("declined");
  });

  describe("access", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    it.each([
      ["GET", "/api/books/status"],
      ["POST", `/api/books/wanted/${id}/search`],
      ["POST", `/api/books/wanted/${id}/grab`],
      ["POST", `/api/books/wanted/${id}/approve`],
      ["POST", `/api/books/wanted/${id}/decline`],
    ])("%s %s is 403 for a member and 401 with no session", async (method, url) => {
      const payload = method === "POST" ? {} : undefined;
      const m = await app.inject({ method: method as any, url, headers: h(memberCookie, memberCsrf), payload });
      expect(m.statusCode).toBe(403);
      const n = await app.inject({ method: method as any, url, payload });
      expect(n.statusCode).toBe(401);
    });
    it("a member may list, and request only with a session and CSRF", async () => {
      expect((await app.inject({ method: "GET", url: "/api/books/wanted", headers: h(memberCookie) })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/books/wanted" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/books/request", headers: h(memberCookie), payload: { title: "X" } })).statusCode).toBe(403);
    });
  });
});
