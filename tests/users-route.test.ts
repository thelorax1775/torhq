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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-users-"));
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

  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "admin", password: "supersecret1" },
  });
  adminCsrf = reg.json().csrfToken;
  adminCookie = reg.cookies[0].name + "=" + reg.cookies[0].value;
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("user management", () => {
  it("blocks a non-admin session from every /api/users route", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "outsider", password: "friendpass1" },
    });
    expect(create.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "outsider", password: "friendpass1" },
    });
    const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
    const csrf = login.json().csrfToken;

    const list = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
    expect(list.statusCode).toBe(403);

    const post = await app.inject({
      method: "POST", url: "/api/users", headers: { cookie, "x-csrf-token": csrf },
      payload: { username: "nope", password: "wontwork1" },
    });
    expect(post.statusCode).toBe(403);
  });

  it("admin creates a friend account with role=member, never admin", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "sam", password: "friendpass1" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.role).toBe("member");
    expect(r.json().user).not.toHaveProperty("passwordHash");
  });

  it("refuses a duplicate username", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "sam", password: "anotherpass1" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("refuses a username that differs only in case", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "SAM", password: "anotherpass1" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("allows a genuinely different username", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "samantha", password: "anotherpass1" },
    });
    expect(r.statusCode).toBe(200);
  });

  it("lists accounts without ever including a password hash", async () => {
    const r = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).not.toMatch(/scrypt\$/);
    const usernames = r.json().users.map((u: any) => u.username);
    expect(usernames).toContain("sam");
  });

  it("a password reset invalidates the friend's existing session", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "friendpass1" } });
    const samCookie = login.cookies[0].name + "=" + login.cookies[0].value;
    const samId = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } }))
      .json().users.find((u: any) => u.username === "sam").id;

    const before = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: samCookie } });
    expect(before.statusCode).toBe(200);

    const reset = await app.inject({
      method: "POST", url: `/api/users/${samId}/password`,
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { password: "newfriendpass1" },
    });
    expect(reset.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: samCookie } });
    expect(after.statusCode).toBe(401); // old session is gone

    const relogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "newfriendpass1" } });
    expect(relogin.statusCode).toBe(200);
  });

  it("revoking an account 404s afterwards and kills its session", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "temp", password: "temppass1" },
    });
    const id = create.json().user.id;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "temp", password: "temppass1" } });
    const tempCookie = login.cookies[0].name + "=" + login.cookies[0].value;

    const del = await app.inject({
      method: "DELETE", url: `/api/users/${id}`,
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: tempCookie } });
    expect(after.statusCode).toBe(401);

    const again = await app.inject({
      method: "DELETE", url: `/api/users/${id}`,
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    });
    expect(again.statusCode).toBe(404);
  });

  it("refuses to delete the last remaining admin", async () => {
    const admins = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } }))
      .json().users.filter((u: any) => u.role === "admin");
    expect(admins).toHaveLength(1);
    const r = await app.inject({
      method: "DELETE", url: `/api/users/${admins[0].id}`,
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
    });
    expect(r.statusCode).toBe(409);
  });

  it("exposes role on /api/auth/me for both admin and member", async () => {
    const meAdmin = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: adminCookie } });
    expect(meAdmin.json().role).toBe("admin");

    await app.inject({
      method: "POST", url: "/api/users",
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { username: "roletest", password: "roletestpass1" },
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "roletest", password: "roletestpass1" } });
    const memberCookie = login.cookies[0].name + "=" + login.cookies[0].value;
    const meMember = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: memberCookie } });
    expect(meMember.json().role).toBe("member");
  });
});
