import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";

let app: FastifyInstance;
let dataDir: string;
let adminCookie = "", adminCsrf = "";
let memberCookie = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-guard-"));
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
    payload: { username: "friend", password: "friendpass1" },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "friend", password: "friendpass1" } });
  memberCookie = login.cookies[0].name + "=" + login.cookies[0].value;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ADMIN_ONLY_GETS = [
  "/api/services",
  "/api/libraries",
  "/api/config/roots",
  "/api/acquire/defaults",
  "/api/search/sources",
  "/api/identify/status",
  "/api/pipeline/check",
  "/api/activity/log",
  "/api/status/health",
];

const FRIEND_SAFE_GETS = [
  "/api/jobs",
  "/api/activity",
  "/api/downloads",
  "/api/queue",
  "/api/requests/movie/options",
];

describe("admin-only routes reject a member session", () => {
  it.each(ADMIN_ONLY_GETS)("%s is 403 for a member, reachable for the admin", async (url) => {
    const asMember = await app.inject({ method: "GET", url, headers: { cookie: memberCookie } });
    expect(asMember.statusCode, url).toBe(403);
    const asAdmin = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
    expect(asAdmin.statusCode, url).not.toBe(403);
    expect(asAdmin.statusCode, url).not.toBe(401);
  });
});

describe("friend-safe routes stay reachable for a member", () => {
  it.each(FRIEND_SAFE_GETS)("%s stays reachable for a member session", async (url) => {
    const r = await app.inject({ method: "GET", url, headers: { cookie: memberCookie } });
    expect(r.statusCode, url).not.toBe(401);
    expect(r.statusCode, url).not.toBe(403);
  });
});

describe("admin-only mutations", () => {
  it("intake preview is blocked for a member", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/intake/preview",
      headers: { cookie: memberCookie },
      payload: { libraryKey: "nope", sourcePath: "/tmp" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("automatic *arr search is blocked for a member", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/acquire/auto-search",
      headers: { cookie: memberCookie }, payload: { service: "radarr", id: 1 },
    });
    expect(r.statusCode).toBe(403);
  });

  it("queue mutations are blocked for a member", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/queue/refresh",
      headers: { cookie: memberCookie },
    });
    expect(r.statusCode).toBe(403);
  });
});
