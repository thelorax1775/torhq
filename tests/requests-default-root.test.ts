import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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
let adminCookie = "", adminCsrf = "";
let memberCookie = "";

const ROOTS = [
  { id: 1, path: "/mnt/storage/movies", freeSpace: 1 },
  { id: 13, path: "/mnt/storage-x2/movies", freeSpace: 999 },
];

async function saveRadarr(extra: Record<string, unknown> | undefined): Promise<void> {
  httpJson.mockResolvedValue({ version: "1.0" });
  const r = await app.inject({
    method: "POST", url: "/api/services",
    headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    payload: { kind: "radarr", label: "Radarr", baseUrl: "http://radarr.local", secret: "APIKEY", extra },
  });
  expect(r.statusCode).toBe(200);
}

async function memberOptions(): Promise<{ defaultRootFolderPath?: string; roots: unknown[] }> {
  httpJson.mockImplementation(async (...args: any[]) => {
    const path = String(args[1]);
    if (path.endsWith("/rootfolder")) return ROOTS;
    return [];
  });
  const r = await app.inject({ method: "GET", url: "/api/requests/movie/options", headers: { cookie: memberCookie } });
  expect(r.statusCode).toBe(200);
  return r.json();
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-reqroot-"));
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  app = await buildApp(makeContext(env));
  await app.ready();

  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
  adminCsrf = reg.json().csrfToken;
  adminCookie = reg.cookies[0].name + "=" + reg.cookies[0].value;

  await app.inject({
    method: "POST", url: "/api/users",
    headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    payload: { username: "sam", password: "friendpass1" },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "friendpass1" } });
  memberCookie = login.cookies[0].name + "=" + login.cookies[0].value;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("request form default root folder", () => {
  it("offers a member the root folder the admin saved as the default", async () => {
    await saveRadarr({ rootFolderPath: "/mnt/storage-x2/movies" });
    const opts = await memberOptions();
    expect(opts.defaultRootFolderPath).toBe("/mnt/storage-x2/movies");
    expect(opts.roots).toHaveLength(2);
  });

  it("offers no default when the saved folder is no longer one of the *arr's roots", async () => {
    await saveRadarr({ rootFolderPath: "/mnt/gone/movies" });
    expect((await memberOptions()).defaultRootFolderPath).toBeUndefined();
  });

  it("offers no default when none was saved", async () => {
    await saveRadarr(undefined);
    expect((await memberOptions()).defaultRootFolderPath).toBeUndefined();
  });
});
