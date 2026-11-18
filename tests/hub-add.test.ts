import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const { httpJson } = vi.hoisted(() => ({ httpJson: vi.fn() }));
vi.mock("../server/src/adapters/http.js", () => ({
  httpJson,
  HttpError: class HttpError extends Error {},
  basicAuth: (s: string) => s,
}));

const { initDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");

let app: FastifyInstance;
let dataDir: string;
let admin = { cookie: "", csrf: "" };
let member = { cookie: "", csrf: "" };

const hdr = (u: { cookie: string; csrf: string }) => ({ cookie: u.cookie, "x-csrf-token": u.csrf });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-hubadd-"));
  const env = loadEnv({
    NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir, TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  app = await buildApp(makeContext(env));
  await app.ready();

  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
  admin = { csrf: reg.json().csrfToken, cookie: reg.cookies[0].name + "=" + reg.cookies[0].value };

  httpJson.mockResolvedValue({ version: "1.0" });
  for (const kind of ["radarr", "sonarr", "lidarr"]) {
    await app.inject({
      method: "POST", url: "/api/services", headers: hdr(admin),
      payload: { kind, label: kind, baseUrl: `http://${kind}.local`, secret: "APIKEY" },
    });
  }
  await app.inject({ method: "POST", url: "/api/users", headers: hdr(admin), payload: { username: "sam", password: "friendpass1" } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "friendpass1" } });
  member = { csrf: login.json().csrfToken, cookie: login.cookies[0].name + "=" + login.cookies[0].value };
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => httpJson.mockClear());

describe("POST /api/acquire/auto-search", () => {
  it.each([
    ["radarr", "MoviesSearch", { movieIds: [7] }],
    ["sonarr", "SeriesSearch", { seriesId: 7 }],
    ["lidarr", "ArtistSearch", { artistId: 7 }],
  ])("%s: asks the *arr to search by itself and never lists releases", async (service, name, extra) => {
    httpJson.mockResolvedValue({ id: 1 });
    const r = await app.inject({
      method: "POST", url: "/api/acquire/auto-search", headers: hdr(admin), payload: { service, id: 7 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, service, command: name });
    const post = httpJson.mock.calls.find((c) => c[2]?.method === "POST")!;
    expect(String(post[1])).toMatch(/\/command$/);
    expect(post[2].body).toEqual({ name, ...extra });
    // Nothing touches releases or grabs: the *arr does that itself.
    expect(httpJson.mock.calls.some((c) => /release/.test(String(c[1])))).toBe(false);
  });

  it("is admin-only: a member gets 403 and nothing reaches the *arr", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/acquire/auto-search", headers: hdr(member), payload: { service: "radarr", id: 7 },
    });
    expect(r.statusCode).toBe(403);
    expect(httpJson).not.toHaveBeenCalled();
  });
});

describe("POST /api/requests/:route without explicit placement", () => {
  it("falls back to the *arr's first profile and root folder for a member", async () => {
    httpJson.mockImplementation(async (...args: any[]) => {
      const [, path, opts] = args;
      const p = String(path);
      if (p.endsWith("/lookup")) return [{ title: "Dune", year: 2021, tmdbId: 438631 }];
      if (p.endsWith("/qualityprofile")) return [{ id: 4, name: "HD" }];
      if (p.endsWith("/rootfolder")) return [{ id: 1, path: "/movies" }];
      if (opts?.method === "POST") return { id: 42, title: "Dune" };
      return {};
    });
    const r = await app.inject({
      method: "POST", url: "/api/requests/movie", headers: hdr(member),
      payload: { term: "dune", selectionId: "tmdb:438631" },
    });
    expect(r.statusCode).toBe(200);
    const post = httpJson.mock.calls.find((c) => c[2]?.method === "POST" && String(c[1]).endsWith("/movie"))!;
    expect(post[2].body).toMatchObject({ qualityProfileId: 4, rootFolderPath: "/movies", addOptions: { searchForMovie: true } });
  });

  it("still refuses a member on admin-only prepare", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/acquire/prepare", headers: hdr(member),
      payload: { service: "radarr", term: "x", selectionId: "tmdb:1" },
    });
    expect(r.statusCode).toBe(403);
  });
});
