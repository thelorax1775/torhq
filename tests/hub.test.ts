import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";
import { setHubDepsForTest } from "../server/src/routes/hub.js";
import { hubSearch, hubItem, statusFor, HUB_KINDS, type HubDeps } from "../server/src/lib/hub.js";

const hit = (over: Record<string, unknown>) => ({
  selectionId: "tmdb:1", title: "T", monitored: false, fileCount: 0, genres: [], ...over,
});
const page = (items: any[]) => ({ items, page: 1, totalPages: 1 });
const SECRET = "sk-super-secret-key";

function deps(over: Partial<HubDeps> = {}): HubDeps {
  const radarr = {
    lookupHits: async () => [
      hit({ selectionId: "tmdb:10", title: "Have", year: 2020, libraryId: 5, monitored: true, fileCount: 1 }),
      hit({ selectionId: "tmdb:11", title: "Wanted", libraryId: 6, monitored: true, fileCount: 0 }),
      hit({ selectionId: "tmdb:12", title: "Paused", libraryId: 7, monitored: false, fileCount: 0 }),
      hit({ selectionId: "tmdb:13", title: "Pulling", libraryId: 8, monitored: true, fileCount: 0 }),
      hit({ selectionId: "tmdb:14", title: "New" }),
    ],
    queue: async () => [{ libraryId: 8 }] as any,
    albums: async () => [], qualityProfiles: async () => [{ id: 4, name: "HD" }],
    rootFolders: async () => [{ id: 1, path: "/data/movies" }], metadataProfiles: async () => [],
  };
  const lidarr = {
    ...radarr,
    lookupHits: async () => [hit({ selectionId: "mbid:abc", title: "Band", libraryId: 2, monitored: true, fileCount: 12 })],
    queue: async () => [],
    albums: async () => [{ id: 1, title: "Album One", year: 1999, monitored: true }],
    metadataProfiles: async () => [{ id: 3, name: "Standard" }],
  };
  return {
    arr: (s) => (s === "radarr" ? radarr : s === "lidarr" ? lidarr : null) as any,
    tmdb: () => ({
      search: async (kind: string) => page([{ kind, id: "99", title: "TMDB only", year: 2001, genres: ["Drama"] }]),
      details: async () => ({}) as any,
    }),
    rawg: () => ({
      search: async () => page([{ kind: "game", id: "3498", title: "GTA V", year: 2013, genres: [], platforms: ["PC"] }]),
      details: async () => ({ kind: "game", id: "3498", title: "GTA V", genres: ["Action"], overview: "Long text" }) as any,
    }),
    prowlarrConfigured: () => true,
    openLibrary: {
      search: async () => [{ id: "OL1W", title: "Dune", year: 1965, author: "Frank Herbert" }],
      work: async (id) => (id === "OL1W" ? { id, title: "Dune", overview: "Spice." } : null),
    },
    savedDefaults: () => ({}),
    timeoutMs: 200,
    ...over,
  };
}

describe("statusFor", () => {
  it("maps *arr facts to a status", () => {
    expect(statusFor({ monitored: true, fileCount: 0 }, false)).toBe("none");
    expect(statusFor({ libraryId: 1, monitored: true, fileCount: 3 }, false)).toBe("available");
    expect(statusFor({ libraryId: 1, monitored: true, fileCount: 0 }, false)).toBe("requested");
    expect(statusFor({ libraryId: 1, monitored: false, fileCount: 0 }, false)).toBe("missing");
    expect(statusFor({ libraryId: 1, monitored: true, fileCount: 0 }, true)).toBe("downloading");
  });
});

describe("hubSearch", () => {
  it("maps status per kind and names the owner", async () => {
    const r = await hubSearch(deps(), "x", ["movie", "music", "game", "book", "audiobook"]);
    const by = (t: string) => r.results.find((x) => x.title === t)!;
    expect(by("Have")).toMatchObject({ kind: "movie", status: "available", owner: "radarr", actionable: false });
    expect(by("Wanted")).toMatchObject({ status: "requested", actionable: false });
    expect(by("Paused")).toMatchObject({ status: "missing", actionable: true });
    expect(by("Pulling")).toMatchObject({ status: "downloading", actionable: false });
    expect(by("New")).toMatchObject({ status: "none", actionable: true });
    expect(by("Band")).toMatchObject({ kind: "music", id: "mbid:abc", status: "available", owner: "lidarr" });
    expect(by("GTA V")).toMatchObject({ kind: "game", status: "unknown", owner: "prowlarr", actionable: true });
    expect(by("Dune")).toMatchObject({ kind: "book", id: "OL1W", status: "unknown", owner: "intake", subtitle: "Frank Herbert" });
    expect(r.results.filter((x) => x.title === "Dune").map((x) => x.kind)).toEqual(["book", "audiobook"]);
  });

  it("interleaves kinds in a stable order so no kind buries the others", async () => {
    const r = await hubSearch(deps(), "x", [...HUB_KINDS]);
    const kinds = r.results.map((x) => x.kind);
    expect(kinds.slice(0, 6)).toEqual(["movie", "tv", "music", "game", "book", "audiobook"]);
    expect(r.sources.map((s) => s.kind)).toEqual(["movie", "tv", "music", "game", "book", "audiobook"]);
    // movie rows keep the *arr's order
    expect(r.results.filter((x) => x.kind === "movie").map((x) => x.title)).toEqual(["Have", "Wanted", "Paused", "Pulling", "New"]);
  });

  it("only queries the requested kinds", async () => {
    const r = await hubSearch(deps(), "x", ["book"]);
    expect(r.sources).toEqual([{ kind: "book", available: true }]);
  });

  it("degrades a throwing source without failing the others", async () => {
    const d = deps({ openLibrary: { search: async () => { throw new Error(`boom http://internal:1/?apikey=${SECRET}`); }, work: async () => null } });
    const r = await hubSearch(d, "x", ["movie", "book"]);
    expect(r.results.some((x) => x.kind === "movie")).toBe(true);
    const src = r.sources.find((s) => s.kind === "book")!;
    expect(src.available).toBe(false);
    expect(src.detail).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain("internal");
  });

  it("degrades a source that exceeds its timeout", async () => {
    const d = deps({ timeoutMs: 30, openLibrary: { search: () => new Promise(() => {}), work: async () => null } });
    const t = Date.now();
    const r = await hubSearch(d, "x", ["movie", "audiobook"]);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(r.sources.find((s) => s.kind === "audiobook")).toMatchObject({ available: false, detail: expect.stringMatching(/timed out/) });
    expect(r.results.some((x) => x.kind === "movie")).toBe(true);
  });

  it("explains an unconfigured source, and falls back to TMDB when the *arr is missing", async () => {
    const r = await hubSearch(deps({ rawg: () => null }), "x", ["game", "tv"]);
    expect(r.sources.find((s) => s.kind === "game")).toMatchObject({ available: false, detail: expect.stringMatching(/RAWG/) });
    // no Sonarr in the mock: TMDB answers, status unknown, and a show with no TVDB id is not actionable
    expect(r.results[0]).toMatchObject({ kind: "tv", title: "TMDB only", status: "unknown", owner: "sonarr", actionable: false });
  });

  it("treats an unreadable queue as 'not downloading', not as a failure", async () => {
    const d = deps();
    const radarr = d.arr("radarr")!;
    const r = await hubSearch({ ...d, arr: (s) => (s === "radarr" ? { ...radarr, queue: async () => { throw new Error("x"); } } : null) as any }, "x", ["movie"]);
    expect(r.sources[0]!.available).toBe(true);
    expect(r.results.find((x) => x.title === "Pulling")!.status).toBe("requested");
  });
});

describe("hubItem", () => {
  it("returns music detail with albums and the defaults the server would use", async () => {
    const i = await hubItem(deps(), "music", "mbid:abc", true);
    expect(i).toMatchObject({ title: "Band", status: "available", libraryId: 2 });
    expect(i.albums).toEqual([{ id: 1, title: "Album One", year: 1999, monitored: true }]);
    expect(i.addOptions).toMatchObject({ service: "lidarr", qualityProfileId: 4, metadataProfileId: 3, rootFolderPath: "/data/movies", basis: "arr-first" });
  });

  it("hides filesystem paths from members and prefers saved defaults", async () => {
    const d = deps({ savedDefaults: () => ({ rootFolderPath: "/mnt/films", qualityProfileId: 9 }) });
    const member = await hubItem(d, "movie", "tmdb:14", false);
    expect(member.addOptions).toMatchObject({ qualityProfileId: 9, basis: "saved" });
    expect(member.addOptions!.rootFolderPath).toBeUndefined();
    expect((await hubItem(d, "movie", "tmdb:14", true)).addOptions!.rootFolderPath).toBe("/mnt/films");
  });

  it("detail for game, book; 404/400/409 otherwise", async () => {
    expect(await hubItem(deps(), "game", "3498", false)).toMatchObject({ overview: "Long text", owner: "prowlarr" });
    expect(await hubItem(deps(), "audiobook", "OL1W", false)).toMatchObject({ kind: "audiobook", overview: "Spice.", owner: "intake" });
    await expect(hubItem(deps(), "book", "OL9W", false)).rejects.toMatchObject({ statusCode: 404 });
    await expect(hubItem(deps(), "movie", "bogus", false)).rejects.toMatchObject({ statusCode: 400 });
    await expect(hubItem(deps(), "tv", "tvdb:1", false)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("/api/hub routes", () => {
  let app: FastifyInstance, dataDir: string, adminCookie = "", memberCookie = "";
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "torhq-hub-"));
    const env = loadEnv({ NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789", TORHQ_DATA_DIR: dataDir, TORHQ_APPROVED_ROOTS: dataDir } as any);
    initDb(env.TORHQ_DATA_DIR);
    runMigrations();
    app = await buildApp(makeContext(env));
    await app.ready();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
    adminCookie = reg.cookies[0]!.name + "=" + reg.cookies[0]!.value;
    await app.inject({ method: "POST", url: "/api/users", headers: { cookie: adminCookie, "x-csrf-token": reg.json().csrfToken }, payload: { username: "friend", password: "friendpass1" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "friend", password: "friendpass1" } });
    memberCookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value;
    setHubDepsForTest(deps());
  });
  afterAll(async () => { setHubDepsForTest(null); await app.close(); rmSync(dataDir, { recursive: true, force: true }); });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/hub/search?q=x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/hub/item?kind=movie&id=tmdb:1" })).statusCode).toBe(401);
  });

  it.each([["admin"], ["member"]])("lets %s search and read detail", async (who) => {
    const cookie = who === "admin" ? adminCookie : memberCookie;
    const s = await app.inject({ method: "GET", url: "/api/hub/search?q=dune&kinds=movie,book", headers: { cookie } });
    expect(s.statusCode).toBe(200);
    expect(s.json().sources.map((x: any) => x.kind)).toEqual(["movie", "book"]);
    expect(s.json().results[0]).toMatchObject({ kind: "movie", title: "Have", status: "available", owner: "radarr" });
    const i = await app.inject({ method: "GET", url: "/api/hub/item?kind=music&id=mbid:abc", headers: { cookie } });
    expect(i.statusCode).toBe(200);
    const path = i.json().item.addOptions.rootFolderPath;
    expect(path === undefined).toBe(who === "member");
  });

  it("searches every kind when kinds is omitted, and rejects bad input with 400", async () => {
    const s = await app.inject({ method: "GET", url: "/api/hub/search?q=x", headers: { cookie: memberCookie } });
    expect(s.json().sources).toHaveLength(6);
    expect((await app.inject({ method: "GET", url: "/api/hub/search?q=x&kinds=movie,vinyl", headers: { cookie: memberCookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/hub/search", headers: { cookie: memberCookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/hub/item?kind=book&id=OL9W", headers: { cookie: memberCookie } })).statusCode).toBe(404);
  });

  it("returns 200 with degraded sources when an upstream breaks, and leaks no secrets", async () => {
    setHubDepsForTest(deps({ openLibrary: { search: async () => { throw new Error(`x-api-key ${SECRET}`); }, work: async () => null } }));
    const s = await app.inject({ method: "GET", url: "/api/hub/search?q=x", headers: { cookie: memberCookie } });
    setHubDepsForTest(deps());
    expect(s.statusCode).toBe(200);
    expect(s.json().sources.find((x: any) => x.kind === "book").available).toBe(false);
    expect(s.body).not.toContain(SECRET);
    expect(s.body).not.toMatch(/api[_-]?key|secret/i);
  });
});
