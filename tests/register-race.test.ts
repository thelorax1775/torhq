import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";
import { getDb } from "../server/src/db/index.js";
import { users } from "../server/src/db/schema.js";

let app: FastifyInstance;
let dataDir: string;

async function setup() {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-race-"));
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
}

async function teardown() {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}

describe("admin registration race", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("concurrent registrations produce exactly one admin and 409 for the loser", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin1", password: "supersecret1" } }),
      app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin2", password: "supersecret1" } }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const count = getDb().select({ count: users.id }).from(users).all().length;
    expect(count).toBe(1);
  });

  it("single registration still returns 200", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin3", password: "supersecret1" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().username).toBe("admin3");
  });

  it("registration after admin exists returns 409", async () => {
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "first", password: "supersecret1" } });
    const r = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "second", password: "supersecret1" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("admin already exists");
  });
});