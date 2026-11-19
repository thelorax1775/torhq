import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-db-"));
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
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("authorization", () => {
  it("health is public", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });
  it("serves an OpenAPI doc with schemas and CSRF security on mutations", async () => {
    const r = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.components.schemas.Error).toBeTruthy();
    expect(doc.components.schemas.Candidate).toBeTruthy();
    // A mutating route declares the CSRF token security requirement.
    expect(doc.paths["/api/services"].post.security).toContainEqual({ cookieAuth: [], csrfToken: [] });
  });
  it("blocks unauthenticated access to protected routes", async () => {
    const r = await app.inject({ method: "GET", url: "/api/services" });
    expect(r.statusCode).toBe(401);
  });
  it("reports needsSetup before any admin exists", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(r.json().needsSetup).toBe(true);
  });
});

describe("auth flow + CSRF", () => {
  let cookie = "";
  let csrf = "";
  it("registers the first admin", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "admin", password: "supersecret1" },
    });
    expect(r.statusCode).toBe(200);
    csrf = r.json().csrfToken;
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
    expect(csrf).toBeTruthy();
  });
  it("refuses a second registration", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "x", password: "supersecret1" },
    });
    expect(r.statusCode).toBe(409);
  });
  it("allows authed read with the session cookie", async () => {
    const r = await app.inject({ method: "GET", url: "/api/services", headers: { cookie } });
    expect(r.statusCode).toBe(200);
  });
  it("rejects a mutating request without the CSRF header", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie },
      payload: { kind: "radarr", label: "Radarr", baseUrl: "http://localhost:7878", secret: "k" },
    });
    expect(r.statusCode).toBe(403);
  });
  it("accepts a mutating request with a valid CSRF header", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/services",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { kind: "radarr", label: "Radarr", baseUrl: "http://localhost:7878", secret: "k" },
    });
    expect(r.statusCode).toBe(200);
  });
  it("never returns full secrets to the client", async () => {
    const r = await app.inject({ method: "GET", url: "/api/services", headers: { cookie } });
    const svc = r.json().services.find((s: any) => s.kind === "radarr");
    expect(svc.secretMask).not.toContain("k");
    expect(svc.secretMask).toMatch(/•/);
  });
  it("rejects logout without the CSRF header (logout is a state change)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(r.statusCode).toBe(403);
  });
  it("accepts logout with a valid CSRF header", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-csrf-token": csrf } });
    expect(r.statusCode).toBe(200);
  });
});

describe("typed extra config over the API", () => {
  let cookie = "", csrf = "";
  beforeAll(async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    csrf = r.json().csrfToken;
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
  });
  it("stores a slskd webhook token but never returns it", async () => {
    const save = await app.inject({
      method: "POST", url: "/api/services", headers: { cookie, "x-csrf-token": csrf },
      payload: { kind: "slskd", label: "slskd", baseUrl: "http://localhost:5030", secret: "k", extra: { webhookToken: "topsecrettoken" } },
    });
    expect(save.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/services", headers: { cookie } });
    const slskd = list.json().services.find((s: any) => s.kind === "slskd");
    expect(slskd.extra).toEqual({ webhookTokenSet: true });
    expect(JSON.stringify(slskd)).not.toContain("topsecrettoken");
  });
  it("round-trips a non-secret kavita libraryId", async () => {
    await app.inject({
      method: "POST", url: "/api/services", headers: { cookie, "x-csrf-token": csrf },
      payload: { kind: "kavita", label: "kavita", baseUrl: "http://localhost:5000", secret: "k", extra: { libraryId: 7 } },
    });
    const list = await app.inject({ method: "GET", url: "/api/services", headers: { cookie } });
    const kavita = list.json().services.find((s: any) => s.kind === "kavita");
    expect(kavita.extra).toEqual({ libraryId: 7 });
  });
});

describe("intake path validation via API", () => {
  let cookie = "", csrf = "";
  beforeAll(async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    csrf = r.json().csrfToken;
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
    await app.inject({
      method: "POST", url: "/api/libraries", headers: { cookie, "x-csrf-token": csrf },
      payload: { key: "kavita-books", label: "Books", kind: "books", targetService: "kavita",
        destPath: join(dataDir, "libraries", "books"), stagingPath: join(dataDir, "staging", "books") },
    });
  });
  it("rejects an intake source that escapes approved roots", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/intake/preview", headers: { cookie, "x-csrf-token": csrf },
      payload: { libraryKey: "kavita-books", sourcePath: "/etc/passwd" },
    });
    expect(r.statusCode).toBe(400);
  });
  it("rejects a library destPath outside approved roots", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/libraries", headers: { cookie, "x-csrf-token": csrf },
      payload: { key: "bad", label: "Bad", kind: "books", targetService: "kavita",
        destPath: "/etc/evil", stagingPath: "/etc/evil" },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("library folders behind a symlink", () => {
  it("rejects a destPath or stagingPath that reaches outside the roots through a symlink", async () => {
    const r0 = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    const csrf = r0.json().csrfToken;
    const cookie = r0.cookies[0].name + "=" + r0.cookies[0].value;
    const outside = mkdtempSync(join(tmpdir(), "torhq-outside-"));
    try {
      mkdirSync(join(dataDir, "lib"), { recursive: true });
      symlinkSync(outside, join(dataDir, "lib", "portal"));
      const good = join(dataDir, "libraries", "ok");
      const bad = join(dataDir, "lib", "portal", "newdir");
      for (const [key, destPath, stagingPath] of [["sl-dest", bad, join(dataDir, "staging", "ok")], ["sl-stage", good, bad]]) {
        const r = await app.inject({
          method: "POST", url: "/api/libraries", headers: { cookie, "x-csrf-token": csrf },
          payload: { key, label: key, kind: "books", targetService: "kavita", destPath, stagingPath },
        });
        expect(r.statusCode).toBe(400);
      }
      const list = await app.inject({ method: "GET", url: "/api/libraries", headers: { cookie } });
      const keys = list.json().libraries.map((l: any) => l.key);
      expect(keys).not.toContain("sl-dest");
      expect(keys).not.toContain("sl-stage");
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe("removing a library", () => {
  let cookie = "", csrf = "";
  const create = (key: string) => app.inject({
    method: "POST", url: "/api/libraries", headers: { cookie, "x-csrf-token": csrf },
    payload: { key, label: key, kind: "books", targetService: "kavita",
      destPath: join(dataDir, "libraries", "books"), stagingPath: join(dataDir, "staging", "books") },
  });
  const list = async () => (await app.inject({ method: "GET", url: "/api/libraries", headers: { cookie } }))
    .json().libraries.map((l: any) => l.key);

  beforeAll(async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    csrf = r.json().csrfToken;
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
  });

  it("removes a library it knows about", async () => {
    await create("kavita-scratch");
    expect(await list()).toContain("kavita-scratch");
    const r = await app.inject({
      method: "DELETE", url: "/api/libraries/kavita-scratch", headers: { cookie, "x-csrf-token": csrf },
    });
    expect(r.statusCode).toBe(200);
    expect(await list()).not.toContain("kavita-scratch");
  });

  it("404s on a library that does not exist", async () => {
    const r = await app.inject({
      method: "DELETE", url: "/api/libraries/nosuchlibrary", headers: { cookie, "x-csrf-token": csrf },
    });
    expect(r.statusCode).toBe(404);
  });

  it("refuses without the CSRF header", async () => {
    await create("kavita-guarded");
    const r = await app.inject({ method: "DELETE", url: "/api/libraries/kavita-guarded", headers: { cookie } });
    expect(r.statusCode).toBe(403);
    expect(await list()).toContain("kavita-guarded");
  });

  it("refuses a key that is not a valid library key", async () => {
    const r = await app.inject({
      method: "DELETE", url: "/api/libraries/..%2F..%2Fetc", headers: { cookie, "x-csrf-token": csrf },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("query parameters that reach the database", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    cookie = r.cookies[0].name + "=" + r.cookies[0].value;
  });

  // Regression: `limit` went to Drizzle unchecked. SQLite reads a negative
  // LIMIT as "no limit", so this returned the whole activity table, and a
  // non-numeric value reached the driver as NaN and threw.
  it.each(["/api/activity", "/api/activity/log"])("%s rejects a bad ?limit instead of running it", async (base) => {
    for (const limit of ["-1", "0", "abc", "", "99999"]) {
      const r = await app.inject({ method: "GET", url: `${base}?limit=${limit}`, headers: { cookie } });
      expect(r.statusCode, `${base}?limit=${limit}`).toBe(400);
    }
  });

  it("accepts a sane limit and defaults when absent", async () => {
    for (const url of ["/api/activity", "/api/activity?limit=25"]) {
      const r = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(r.statusCode, url).toBe(200);
      expect(Array.isArray(r.json().items)).toBe(true);
    }
    for (const url of ["/api/activity/log", "/api/activity/log?limit=25"]) {
      const r = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(r.statusCode, url).toBe(200);
      expect(Array.isArray(r.json().activity)).toBe(true);
    }
  });

  it("rejects an unknown job status rather than silently returning nothing", async () => {
    const bad = await app.inject({ method: "GET", url: "/api/jobs?status=nonsense", headers: { cookie } });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: "GET", url: "/api/jobs?status=queued", headers: { cookie } });
    expect(good.statusCode).toBe(200);
  });

  it("names the offending field in a validation error", async () => {
    const r = await app.inject({ method: "GET", url: "/api/activity?limit=-1", headers: { cookie } });
    expect(r.json().error).toContain("limit");
  });
});
