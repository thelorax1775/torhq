// Pins behaviour a Fastify / @fastify/static / @fastify/cookie / rate-limit
// major upgrade could change silently: route matching, static-file confinement,
// session cookie flags and the login throttle.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDist = join(repoRoot, "web", "dist");
let createdDist = false;
let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  // buildApp serves web/dist only when it exists; make sure it does. If there
  // is no build, create a minimal one and remove it afterwards.
  if (!existsSync(webDist)) {
    mkdirSync(join(webDist, "assets"), { recursive: true });
    writeFileSync(join(webDist, "index.html"), "<!doctype html><title>TorHQ</title><div id=root></div>");
    createdDist = true;
  }
  dataDir = mkdtempSync(join(tmpdir(), "torhq-upg-"));
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
  if (createdDist) rmSync(webDist, { recursive: true, force: true });
});

// 403 is accepted: @fastify/static 10 answers a path with an empty segment
// (/api//services) with 403 where v7 gave 404. Either way no service data.
describe("unauthenticated access to the services route", () => {
  for (const url of ["/api/services", "/api//services", "/api/services/", "/API/services", "/api/%73ervices"]) {
    it(`${url} never returns service data`, async () => {
      const r = await app.inject({ method: "GET", url });
      const isIndex = r.statusCode === 200 && /<html|<!doctype/i.test(r.body);
      expect(r.statusCode === 401 || r.statusCode === 403 || r.statusCode === 404 || isIndex, `got ${r.statusCode}`).toBe(true);
      expect(r.body).not.toContain('"services"');
      if (r.statusCode === 200) expect(r.headers["content-type"]).toContain("text/html");
    });
  }
});

describe("static file serving stays inside web/dist", () => {
  const pkg = readFileSync(join(repoRoot, "package.json"), "utf8");
  for (const url of [
    "/..%2f..%2fpackage.json",
    "/assets/..%2f..%2f..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
    "/../../package.json",
    "/assets/../../../package.json",
  ]) {
    it(`${url} does not return a file outside web/dist`, async () => {
      const r = await app.inject({ method: "GET", url });
      expect(r.body).not.toContain('"workspaces"');
      expect(r.body).not.toBe(pkg);
      expect([200, 400, 403, 404]).toContain(r.statusCode);
      if (r.statusCode === 200) expect(r.headers["content-type"]).toContain("text/html");
    });
  }
});

describe("session cookie and login throttle", () => {
  it("sets the session cookie HttpOnly, SameSite=Lax, Path=/", async () => {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
    expect(reg.statusCode).toBe(200);
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "supersecret1" } });
    expect(r.statusCode).toBe(200);
    const raw = r.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw.join("\n") : String(raw);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
  });

  it("answers the eleventh login attempt within a minute with 429", async () => {
    const codes: number[] = [];
    // the previous test already used one attempt from the same client + register
    const fresh = await buildFresh();
    try {
      for (let i = 0; i < 11; i++) {
        const r = await fresh.inject({ method: "POST", url: "/api/auth/login", payload: { username: "nobody", password: "wrong-password" } });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});

async function buildFresh(): Promise<FastifyInstance> {
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  const a = await buildApp(makeContext(env));
  await a.ready();
  return a;
}
