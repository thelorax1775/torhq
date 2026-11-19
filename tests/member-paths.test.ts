import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// A member must never read a server path or choose where files go. The
// registry is stubbed with a fake qBittorrent and a fake Radarr.
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

const SAVE = "/srv/secret-save/radarr";
const CONTENT = "/srv/secret-save/radarr/Blade.Runner.mkv";
const ROOT = "/srv/secret-media/movies";

let app: FastifyInstance;
let dataDir: string;
let admin = { cookie: "", "x-csrf-token": "" };
let member = { cookie: "", "x-csrf-token": "" };
let adapters: Record<string, any> = {};
let addSelected: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-memberpaths-"));
  const env = loadEnv({
    NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir, TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  app = await buildApp(makeContext(env));
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
  admin = { cookie: reg.cookies[0]!.name + "=" + reg.cookies[0]!.value, "x-csrf-token": reg.json().csrfToken };
  await app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { username: "friend", password: "friendpass1" } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "friend", password: "friendpass1" } });
  member = { cookie: login.cookies[0]!.name + "=" + login.cookies[0]!.value, "x-csrf-token": login.json().csrfToken };
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  addSelected = vi.fn(async () => ({ id: 9, title: "Blade Runner" }));
  adapters = {
    qbittorrent: {
      torrents: vi.fn(async () => [{
        hash: "0123456789abcdef0123456789abcdef01234567", name: "Blade Runner", category: "radarr",
        state: "downloading", progress: 0.5, dlspeed: 1, upspeed: 0, size: 10, eta: 1,
        savePath: SAVE, contentPath: CONTENT, ratio: 0, addedOn: 1, tags: [],
      }]),
      transferInfo: vi.fn(async () => ({ dl_info_speed: 4242, up_info_speed: 77 })),
      categories: vi.fn(async () => ({ radarr: { name: "radarr", savePath: SAVE } })),
    },
    radarr: {
      qualityProfiles: vi.fn(async () => [{ id: 4, name: "HD-1080p" }]),
      rootFolders: vi.fn(async () => [{ id: 1, path: ROOT }]),
      metadataProfiles: vi.fn(async () => []),
      queue: vi.fn(async () => []),
      addSelected,
    },
  };
  getAdapter.mockImplementation((kind: string) => adapters[kind] ?? null);
});

describe("GET /api/downloads", () => {
  it("gives a member only the transfer totals, no torrents or paths", async () => {
    const r = await app.inject({ method: "GET", url: "/api/downloads", headers: { cookie: member.cookie } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.torrents).toEqual([]);
    expect(body.categories).toEqual({});
    expect(body.transfer).toEqual({ dlspeed: 4242, upspeed: 77 });
    expect(r.body).not.toContain(SAVE);
    expect(r.body).not.toContain(CONTENT);
  });

  it("gives an admin the full response", async () => {
    const r = await app.inject({ method: "GET", url: "/api/downloads", headers: { cookie: admin.cookie } });
    expect(r.json().torrents).toHaveLength(1);
    expect(r.body).toContain(SAVE);
    expect(r.json().transfer).toEqual({ dlspeed: 4242, upspeed: 77 });
  });
});

describe("GET /api/requests/movie/options", () => {
  it("gives a member the profiles but no root folders", async () => {
    const r = await app.inject({ method: "GET", url: "/api/requests/movie/options", headers: { cookie: member.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().profiles).toEqual([{ id: 4, name: "HD-1080p" }]);
    expect(r.json().roots).toEqual([]);
    expect(r.body).not.toContain(ROOT);
  });

  it("gives an admin the root folders", async () => {
    const r = await app.inject({ method: "GET", url: "/api/requests/movie/options", headers: { cookie: admin.cookie } });
    expect(r.json().roots).toEqual([{ id: 1, path: ROOT }]);
    expect(r.body).toContain(ROOT);
  });
});

describe("POST /api/requests/movie rootFolderPath", () => {
  const base = { term: "blade runner", selectionId: "tmdb:335984", qualityProfileId: 4 };
  const post = (who: typeof member, extra: object = {}) =>
    app.inject({ method: "POST", url: "/api/requests/movie", headers: who, payload: { ...base, ...extra } });

  it("refuses a member who picks a folder, and adds nothing", async () => {
    const r = await post(member, { rootFolderPath: "/etc/anywhere-a-member-says" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/members cannot choose the folder/i);
    expect(addSelected).not.toHaveBeenCalled();
  });

  it("refuses a member who sends a real root too", async () => {
    const r = await post(member, { rootFolderPath: ROOT });
    expect(r.statusCode).toBe(400);
    expect(addSelected).not.toHaveBeenCalled();
  });

  it("adds a member's request with the first root when no folder is sent", async () => {
    const r = await post(member);
    expect(r.statusCode).toBe(200);
    expect(addSelected).toHaveBeenCalledTimes(1);
    expect((addSelected.mock.calls[0] as any[])[0].rootFolderPath).toBe(ROOT);
  });

  it("refuses an admin folder that is not one of Radarr's roots", async () => {
    const r = await post(admin, { rootFolderPath: "/etc/not-a-root" });
    expect(r.statusCode).toBe(400);
    expect(addSelected).not.toHaveBeenCalled();
  });

  it("accepts an admin folder that Radarr lists", async () => {
    const r = await post(admin, { rootFolderPath: ROOT });
    expect(r.statusCode).toBe(200);
    expect((addSelected.mock.calls[0] as any[])[0].rootFolderPath).toBe(ROOT);
  });
});
