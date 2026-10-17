import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const { getAdapter } = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("../server/src/adapters/registry.js", () => ({
  getAdapter,
  checkAllHealth: vi.fn(async () => ({})),
  testConfig: vi.fn(async () => ({ healthy: true })),
}));

const { initDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");
const { upsertService, getServiceDecrypted, upsertLibrary } = await import("../server/src/config/store.js");
const { driveOf, defaultRootFor, saveDriveSettings } = await import("../server/src/config/drives.js");
const { runIntake } = await import("../server/src/queue/intake.js");
const { deriveKey } = await import("../server/src/lib/crypto.js");

const DRIVES = {
  drives: [
    { id: "1tb", label: "1TB", paths: ["/mnt/storage2", "/mnt/storage-1tb"], downloadPath: "/mnt/torrents-1tb" },
    { id: "4tb", label: "4TB", paths: ["/mnt/storage", "/mnt/storage-4tb", "/mnt/music"], downloadPath: "/mnt/torrents" },
    { id: "4tb-x2", label: "4TB-x2", paths: ["/mnt/storage-x2", "/mnt/storage-4tb-x2", "/mnt/music-x2"], downloadPath: "/mnt/torrents-x2" },
  ],
  defaults: { default: "4tb-x2", movies: "1tb" },
};

const RADARR_ROOTS = [
  { id: 1, path: "/mnt/storage/movies", freeSpace: 1 },
  { id: 2, path: "/mnt/storage2/movies", freeSpace: 2 },
  { id: 13, path: "/mnt/storage-x2/movies", freeSpace: 3 },
];
const LIDARR_ROOTS = [
  { id: 1, path: "/mnt/music", freeSpace: 1 },
  { id: 3, path: "/mnt/music-x2", freeSpace: 3 },
];

let app: FastifyInstance;
let dataDir: string;
let masterKey: Buffer;
let cookie = "", csrf = "", memberCookie = "";
let adapters: Record<string, any> = {};

function arrStub(roots: unknown[]) {
  return {
    qualityProfiles: vi.fn(async () => [{ id: 4, name: "HD" }]),
    rootFolders: vi.fn(async () => roots),
    metadataProfiles: vi.fn(async () => [{ id: 1, name: "Standard" }]),
    addSelected: vi.fn(async () => ({ id: 77, title: "Dune" })),
    processDownloads: vi.fn(async () => {}),
  };
}

const put = (payload: object) =>
  app.inject({ method: "PUT", url: "/api/drives", headers: { cookie, "x-csrf-token": csrf }, payload });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-drives-"));
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  const ctx = makeContext(env);
  masterKey = ctx.masterKey;
  getAdapter.mockImplementation((kind: string) => adapters[kind] ?? null);
  app = await buildApp(ctx);
  await app.ready();

  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
  csrf = reg.json().csrfToken;
  cookie = reg.cookies[0]!.name + "=" + reg.cookies[0]!.value;
  await app.inject({
    method: "POST", url: "/api/users", headers: { cookie, "x-csrf-token": csrf },
    payload: { username: "sam", password: "friendpass1" },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "friendpass1" } });
  memberCookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  adapters = { radarr: arrStub(RADARR_ROOTS), lidarr: arrStub(LIDARR_ROOTS) };
  saveDriveSettings(DRIVES);
  upsertService({
    kind: "radarr", label: "Radarr", baseUrl: "http://radarr.local", secret: "KEY",
    extra: { rootFolderPath: "/mnt/storage-x2/movies", qualityProfileId: 4 },
  }, masterKey);
});

describe("which drive a path is on", () => {
  const { drives } = DRIVES;

  it("matches whole path segments, so /mnt/storage2 is not the 4TB's /mnt/storage", () => {
    expect(driveOf("/mnt/storage2/movies", drives)?.id).toBe("1tb");
    expect(driveOf("/mnt/storage/movies", drives)?.id).toBe("4tb");
    expect(driveOf("/mnt/storage-x2/movies/", drives)?.id).toBe("4tb-x2");
    expect(driveOf("/mnt/storagex/movies", drives)).toBeUndefined();
  });

  it("gives a disk mounted over part of another the path below it", () => {
    const withSsd = [...drives, { id: "ssd", label: "SSD", paths: ["/mnt/storage-4tb/literature"] }];
    expect(driveOf("/mnt/storage-4tb/literature/Books", withSsd)?.id).toBe("ssd");
    expect(driveOf("/mnt/storage-4tb/music", withSsd)?.id).toBe("4tb");
  });
});

describe("the default root folder", () => {
  it("prefers the content type's own drive, then the instance default", () => {
    expect(defaultRootFor("movies", RADARR_ROOTS, DRIVES)).toBe("/mnt/storage2/movies");
    expect(defaultRootFor("tv", RADARR_ROOTS, DRIVES)).toBe("/mnt/storage-x2/movies");
  });

  it("falls back to the per-*arr root when the *arr has no folder on the default drive", () => {
    const s = { ...DRIVES, defaults: { music: "1tb" } };
    expect(defaultRootFor("music", LIDARR_ROOTS, s, "/mnt/music-x2")).toBe("/mnt/music-x2");
    expect(defaultRootFor("music", LIDARR_ROOTS, s, "/mnt/gone")).toBeUndefined();
  });
});

describe("drive settings", () => {
  it("are admin-only and round-trip through the API", async () => {
    expect((await app.inject({ method: "GET", url: "/api/drives", headers: { cookie: memberCookie } })).statusCode).toBe(403);
    const r = await app.inject({ method: "GET", url: "/api/drives", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().drives.map((d: { id: string }) => d.id)).toEqual(["1tb", "4tb", "4tb-x2"]);
    expect(r.json().defaults).toEqual({ default: "4tb-x2", movies: "1tb" });
  });

  it("refuse one path claimed by two drives", async () => {
    const bad = structuredClone(DRIVES);
    bad.drives[1]!.paths.push("/mnt/storage2");
    const r = await put(bad);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/already on drive "1tb"/);
  });

  it("refuse a default naming a drive that does not exist", async () => {
    const r = await put({ ...DRIVES, defaults: { books: "nas" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/no drive with id "nas"/);
  });

  it("refuse a relative path", async () => {
    const r = await put({ drives: [{ id: "x", label: "X", paths: ["mnt/x"] }] });
    expect(r.statusCode).toBe(400);
  });
});

describe("placing *arr items by drive", () => {
  it("starts a member's request on the movies drive, over the root saved before drives existed", async () => {
    const r = await app.inject({ method: "GET", url: "/api/requests/movie/options", headers: { cookie: memberCookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.defaultRootFolderPath).toBe("/mnt/storage2/movies");
    expect(body.roots.find((x: { id: number }) => x.id === 2).drive).toEqual({ id: "1tb", label: "1TB" });
    expect(body.drives).toHaveLength(3);
  });

  it("adds to the movies drive's root when the Get page sends no root", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/acquire/prepare", headers: { cookie, "x-csrf-token": csrf },
      payload: { service: "radarr", term: "dune", selectionId: "tmdb:1" },
    });
    expect(r.statusCode).toBe(200);
    expect(adapters.radarr.addSelected).toHaveBeenCalledWith(expect.objectContaining({ rootFolderPath: "/mnt/storage2/movies" }));
  });

  it("remembers a chosen root as the movies drive and drops the old per-*arr root", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/acquire/prepare", headers: { cookie, "x-csrf-token": csrf },
      payload: { service: "radarr", term: "dune", selectionId: "tmdb:1", rootFolderPath: "/mnt/storage/movies", remember: true },
    });
    expect(r.statusCode).toBe(200);
    const drives = await app.inject({ method: "GET", url: "/api/drives", headers: { cookie } });
    expect(drives.json().defaults.movies).toBe("4tb");
    expect(getServiceDecrypted("radarr", masterKey)?.extra.rootFolderPath).toBeUndefined();
    expect(getServiceDecrypted("radarr", masterKey)?.extra.qualityProfileId).toBe(4);
  });
});

describe("raw grabs by drive", () => {
  const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
  const grab = (payload: Record<string, unknown>) => app.inject({
    method: "POST", url: "/api/search/grab", headers: { cookie, "x-csrf-token": csrf },
    payload: { source: "site", magnet, title: "Some Book", ...payload },
  });

  beforeEach(() => { adapters.qbittorrent = { addTorrent: vi.fn(async () => {}) }; });

  it("saves into the chosen drive's download folder, under the category", async () => {
    const r = await grab({ target: "qbittorrent", drive: "1tb" });
    expect(r.statusCode).toBe(200);
    expect(r.json().drive).toBe("1TB");
    expect(adapters.qbittorrent.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ category: "torhq-manual", savePath: "/mnt/torrents-1tb/torhq-manual" }),
    );
  });

  it("uses the downloads default when no drive is chosen", async () => {
    await grab({ target: "games" });
    expect(adapters.qbittorrent.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ category: "torhq-games", savePath: "/mnt/torrents-x2/torhq-games" }),
    );
  });

  it("leaves an *arr grab to the *arr's own folders", async () => {
    await grab({ target: "radarr", drive: "1tb" });
    expect(adapters.qbittorrent.addTorrent).toHaveBeenCalledWith(expect.objectContaining({ category: "radarr", savePath: undefined }));
  });

  it("refuses a drive qBittorrent cannot reach", async () => {
    saveDriveSettings({ drives: [{ id: "nas", label: "NAS", paths: ["/mnt/nas"] }], defaults: {} });
    const r = await grab({ target: "qbittorrent", drive: "nas" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/NAS has no download folder/);
    expect(adapters.qbittorrent.addTorrent).not.toHaveBeenCalled();
  });
});

describe("a link import from another drive", () => {
  it("copies instead of failing, and keeps the source", async () => {
    const root = join(dataDir, "intake");
    const src = join(root, "downloads", "Some Book");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "book.epub"), "the text");
    upsertLibrary({
      key: "books-other-drive", label: "Books", kind: "books", targetService: "kavita",
      destPath: join(root, "library"), stagingPath: join(root, "staging"), rescan: false, importMode: "link",
    });
    const link = vi.spyOn(fsp, "link").mockRejectedValue(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    try {
      const out = await runIntake("job-cross-drive", { libraryKey: "books-other-drive", sourcePath: src }, [root], deriveKey("k"));
      expect(readFileSync(join(out.destPath, "book.epub"), "utf8")).toBe("the text");
      expect(existsSync(join(src, "book.epub"))).toBe(true);
    } finally {
      link.mockRestore();
    }
  });
});
