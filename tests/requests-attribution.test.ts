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
const { recentActivity } = await import("../server/src/lib/activity.js");

let app: FastifyInstance;
let dataDir: string;
let adminCookie = "", adminCsrf = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-attr-"));
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

  httpJson.mockResolvedValue({ version: "1.0" });
  await app.inject({
    method: "POST", url: "/api/services",
    headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    payload: { kind: "radarr", label: "Radarr", baseUrl: "http://radarr.local", secret: "APIKEY" },
  });
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("request attribution", () => {
  it("records the requesting username in the activity log", async () => {
    await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "sam", password: "friendpass1" },
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "friendpass1" } });
    const memberCookie = login.cookies[0].name + "=" + login.cookies[0].value;
    const memberCsrf = login.json().csrfToken;

    httpJson.mockImplementation(async (...args: any[]) => {
      const [, path, opts] = args;
      if (String(path).endsWith("/lookup")) return [{ title: "Dune", year: 2021, tmdbId: 438631 }];
      if (String(path).endsWith("/rootfolder")) return [{ id: 1, path: "/movies" }];
      if (String(path).endsWith("/qualityprofile")) return [{ id: 1, name: "Any" }];
      if (opts?.method === "POST") return { id: 42, title: "Dune" };
      return {};
    });

    const r = await app.inject({
      method: "POST", url: "/api/requests/movie",
      headers: { cookie: memberCookie, "x-csrf-token": memberCsrf },
      payload: { term: "dune", selectionId: "tmdb:438631", qualityProfileId: 1, searchNow: true },
    });
    expect(r.statusCode).toBe(200);

    const entries = recentActivity(5);
    expect(entries[0].message).toBe("Requested Dune (by sam)");
  });
});
