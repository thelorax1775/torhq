# Friend/Member Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give friends their own admin-provisioned TorHQ logins that can search/request media (Requests) and view progress (Downloads/Queue/Jobs) without reaching any admin surface, then deploy it to the live `torhq` LXC (CT 111, pve-1).

**Architecture:** Turn the already-present-but-unused `users.role` column into a real authorization boundary: a new `requireAdmin` Fastify guard (403 for a logged-in non-admin, 401 for no session), applied to every admin-only route; a new admin-only `/api/users` route + `Users.tsx` page to create/reset/revoke friend accounts; the frontend hides admin nav items and redirects a member away from admin routes. No schema migration, no new crypto, no new auth mechanism — friend accounts use the exact same session/CSRF/rate-limit path as the admin.

**Tech Stack:** Fastify 4, Drizzle ORM (SQLite/better-sqlite3), Zod, Vitest (`app.inject`-based integration tests); React 18 + Vite SPA, React Router.

**Spec:** `docs/superpowers/specs/2026-09-02-friend-member-access-design.md`

## Global Constraints

- No schema migration — `users.role` already exists (`text("role").notNull().default("admin")`).
- Password minimum length is 8 chars everywhere (matches the existing `Credentials` zod schema in `routes/auth.ts`).
- Friend accounts are always created with `role: "member"` — no route may ever create a second `"admin"`.
- No public/internet exposure — reachability is Tailscale-only (operational step, not code; see Task 8).
- `PRAGMA foreign_keys = ON` is set in `db/index.ts` — deleting a `users` row requires deleting its `sessions` rows first (no `ON DELETE CASCADE` on `sessions.user_id`).
- No per-user request-history table — Downloads/Queue/Jobs stay global/shared views; attribution is a username in the `activity.message` string, not a new column.
- Server tests only (`npm run test --workspace server`, i.e. `cd server && npx vitest run`) — there is no frontend test setup in this repo; frontend tasks are verified by `npm run build --workspace web` (type-check) and a manual browser check.

---

### Task 1: Session carries role, `requireAdmin` guard, session revocation by user

**Files:**
- Modify: `server/src/auth/session.ts`
- Modify: `server/src/auth/plugin.ts`
- Modify: `server/src/routes/auth.ts` (two `createSession(user.id)` call sites → `createSession(user)`)
- Test: `tests/roles.test.ts` (new)

**Interfaces:**
- Produces: `SessionCtx { sessionId: string; csrfToken: string; userId: number; role: string; username: string }`, `createSession(user: User): SessionCtx`, `destroySessionsForUser(userId: number): void`, `app.requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>` (401 with no session, 403 for a non-admin session, passes silently for an admin session).

- [ ] **Step 1: Write the failing test**

Create `tests/roles.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { initDb, getDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { authPlugin } from "../server/src/auth/plugin.js";
import { hashPassword } from "../server/src/auth/password.js";
import { createSession, destroySessionsForUser, SESSION_COOKIE } from "../server/src/auth/session.js";
import { users, type User } from "../server/src/db/schema.js";

let app: FastifyInstance;
let dataDir: string;

async function makeUser(username: string, role: "admin" | "member"): Promise<User> {
  const db = getDb();
  const passwordHash = await hashPassword("testpassword1");
  db.insert(users).values({ username, passwordHash, role }).run();
  return db.select().from(users).where(eq(users.username, username)).get()!;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-roles-"));
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();

  app = Fastify();
  await app.register(cookie);
  await authPlugin(app);
  app.get("/admin-only", { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("requireAdmin guard", () => {
  it("401s with no session at all", async () => {
    const r = await app.inject({ method: "GET", url: "/admin-only" });
    expect(r.statusCode).toBe(401);
  });

  it("403s a member session", async () => {
    const member = await makeUser("friend", "member");
    const session = createSession(member);
    const r = await app.inject({
      method: "GET", url: "/admin-only",
      headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("passes an admin session", async () => {
    const admin = await makeUser("root", "admin");
    const session = createSession(admin);
    const r = await app.inject({
      method: "GET", url: "/admin-only",
      headers: { cookie: `${SESSION_COOKIE}=${session.sessionId}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});

describe("destroySessionsForUser", () => {
  it("invalidates every session belonging to that user, not other users'", async () => {
    const a = await makeUser("revokeme", "member");
    const b = await makeUser("keepme", "member");
    const sa = createSession(a);
    const sb = createSession(b);

    destroySessionsForUser(a.id);

    const ra = await app.inject({ method: "GET", url: "/admin-only", headers: { cookie: `${SESSION_COOKIE}=${sa.sessionId}` } });
    expect(ra.statusCode).toBe(401); // session gone entirely, not just under-privileged

    const rb = await app.inject({ method: "GET", url: "/admin-only", headers: { cookie: `${SESSION_COOKIE}=${sb.sessionId}` } });
    expect(rb.statusCode).toBe(403); // b's session still exists, just not admin
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run ../tests/roles.test.ts`
Expected: FAIL — `app.requireAdmin` is not a function, `createSession` type error (`SessionCtx` has no `role`/`username`), `destroySessionsForUser` is not exported.

- [ ] **Step 3: Implement**

Replace `server/src/auth/session.ts` in full:

```ts
import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { sessions, users, type User } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
export const SESSION_COOKIE = "torhq_sid";

export function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function createAdmin(username: string, password: string): Promise<User> {
  const db = getDb();
  const passwordHash = await hashPassword(password);
  db.insert(users).values({ username, passwordHash, role: "admin" }).run();
  return db.select().from(users).where(eq(users.username, username)).get()!;
}

export function adminExists(): boolean {
  return !!getDb().select().from(users).get();
}

export async function authenticate(username: string, password: string): Promise<User | null> {
  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) {
    // Constant-work path to reduce user-enumeration timing signal.
    await verifyPassword(password, "scrypt$32768$8$1$AAAA$AAAA");
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

export interface SessionCtx {
  sessionId: string;
  csrfToken: string;
  userId: number;
  role: string;
  username: string;
}

export function createSession(user: User): SessionCtx {
  const db = getDb();
  const sessionId = token();
  const csrfToken = token();
  db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    csrfToken,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }).run();
  return { sessionId, csrfToken, userId: user.id, role: user.role, username: user.username };
}

export function getSession(sessionId: string | undefined): SessionCtx | null {
  if (!sessionId) return null;
  const db = getDb();
  const row = db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      role: users.role,
      username: users.username,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }
  return { sessionId: row.sessionId, csrfToken: row.csrfToken, userId: row.userId, role: row.role, username: row.username };
}

export function destroySession(sessionId: string): void {
  getDb().delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function destroySessionsForUser(userId: number): void {
  getDb().delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function purgeExpiredSessions(): void {
  getDb().delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}
```

Replace `server/src/auth/plugin.ts` in full:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, getSession, type SessionCtx } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionCtx;
  }
}

/**
 * Attaches session (if any) to the request, and exposes guards:
 *  - requireAuth: 401 if no valid session
 *  - requireAdmin: 401 with no session, 403 if the session isn't an admin
 *  - requireCsrf: double-submit CSRF check for mutating requests
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("session", undefined);

  app.addHook("onRequest", async (req) => {
    const sid = req.cookies?.[SESSION_COOKIE];
    const s = getSession(sid);
    if (s) req.session = s;
  });

  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) {
      reply.code(401).send({ error: "authentication required" });
    }
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) {
      reply.code(401).send({ error: "authentication required" });
      return;
    }
    if (req.session.role !== "admin") {
      reply.code(403).send({ error: "admin access required" });
    }
  });

  app.decorate("requireCsrf", async (req: FastifyRequest, reply: FastifyReply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const header = req.headers["x-csrf-token"];
    if (!req.session || !header || header !== req.session.csrfToken) {
      reply.code(403).send({ error: "invalid CSRF token" });
    }
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCsrf: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

In `server/src/routes/auth.ts`, change both call sites (register and login handlers):

Old (appears twice):
```ts
    const s = createSession(user.id);
```
New (both occurrences):
```ts
    const s = createSession(user);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run ../tests/roles.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite to check nothing else broke**

Run: `npm run test --workspace server`
Expected: PASS — `tests/routing.test.ts`'s auth-flow tests still pass (they only relied on `s.sessionId`/`s.csrfToken`, both unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/session.ts server/src/auth/plugin.ts server/src/routes/auth.ts tests/roles.test.ts
git commit -m "Auth: session carries role, add requireAdmin guard and per-user session revocation"
```

---

### Task 2: `/api/users` — admin creates, lists, resets and revokes friend accounts

**Files:**
- Create: `server/src/routes/users.ts`
- Modify: `server/src/app.ts` (register the new route module)
- Test: `tests/users-route.test.ts` (new)

**Interfaces:**
- Consumes: `app.requireAuth`, `app.requireAdmin`, `app.requireCsrf` (Task 1); `hashPassword` from `auth/password.ts`; `destroySessionsForUser` from `auth/session.ts` (Task 1); `users` table from `db/schema.ts`.
- Produces: `GET /api/users` → `{ users: Array<{ id, username, role, createdAt }> }`; `POST /api/users` (`{ username, password }`) → `{ ok: true, user: {...} }`, always `role: "member"`; `POST /api/users/:id/password` (`{ password }`) → `{ ok: true }`; `DELETE /api/users/:id` → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

Create `tests/users-route.test.ts`:

```ts
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

    const before = await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: samCookie } });
    expect(before.statusCode).toBe(200);

    const reset = await app.inject({
      method: "POST", url: `/api/users/${samId}/password`,
      headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
      payload: { password: "newfriendpass1" },
    });
    expect(reset.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: samCookie } });
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

    const after = await app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: tempCookie } });
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
```

Note: the last test (`/api/auth/me` role) will fail until Task 5 too — that's expected and fine; Task 2's own step 4 below runs only up through Task 2+5 together is not required. Proceed with steps 2–4 now; the `role` assertions on `/api/auth/me` are satisfied once Task 5 lands (this file is shared and re-run then).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run ../tests/users-route.test.ts`
Expected: FAIL — every request to `/api/users` 404s (route doesn't exist yet), and the final test fails because `role` is `undefined`.

- [ ] **Step 3: Implement**

Create `server/src/routes/users.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { destroySessionsForUser } from "../auth/session.js";
import type { AppContext } from "../lib/context.js";

const CreateUser = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
});
const ResetPassword = z.object({ password: z.string().min(8).max(256) });
const UserIdParam = z.object({ id: z.coerce.number().int().positive() });

/** Never the password hash — this is the shape returned to the browser. */
function safeUser(u: { id: number; username: string; role: string; createdAt: number }) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}

export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  app.get("/api/users", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const rows = getDb().select().from(users).all();
    return { users: rows.map(safeUser) };
  });

  // Friend accounts only — admin creation stays on /api/auth/register, gated
  // by adminExists(). This route can never create a second admin.
  app.post("/api/users", guard, async (req, reply) => {
    const body = CreateUser.parse(req.body);
    const existing = getDb().select().from(users).where(eq(users.username, body.username)).get();
    if (existing) return reply.code(409).send({ error: `username ${body.username} already exists` });
    const passwordHash = await hashPassword(body.password);
    getDb().insert(users).values({ username: body.username, passwordHash, role: "member" }).run();
    const created = getDb().select().from(users).where(eq(users.username, body.username)).get()!;
    return { ok: true, user: safeUser(created) };
  });

  app.post("/api/users/:id/password", guard, async (req, reply) => {
    const { id } = UserIdParam.parse(req.params);
    const target = getDb().select().from(users).where(eq(users.id, id)).get();
    if (!target) return reply.code(404).send({ error: `no user with id ${id}` });
    const { password } = ResetPassword.parse(req.body);
    const passwordHash = await hashPassword(password);
    getDb().update(users).set({ passwordHash }).where(eq(users.id, id)).run();
    destroySessionsForUser(id); // a reset password should not leave old sessions valid
    return { ok: true };
  });

  app.delete("/api/users/:id", guard, async (req, reply) => {
    const { id } = UserIdParam.parse(req.params);
    const target = getDb().select().from(users).where(eq(users.id, id)).get();
    if (!target) return reply.code(404).send({ error: `no user with id ${id}` });
    if (target.role === "admin") {
      const otherAdmins = getDb().select().from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, id))).all();
      if (otherAdmins.length === 0) {
        return reply.code(409).send({ error: "cannot delete the last remaining admin" });
      }
    }
    destroySessionsForUser(id);
    getDb().delete(users).where(eq(users.id, id)).run();
    return { ok: true };
  });
}
```

In `server/src/app.ts`, add the import next to the other route imports:

Old:
```ts
import { setupRoutes } from "./routes/setup.js";
```
New:
```ts
import { setupRoutes } from "./routes/setup.js";
import { userRoutes } from "./routes/users.js";
```

And register it next to `setupRoutes(app, ctx);`:

Old:
```ts
  setupRoutes(app, ctx);
  requestRoutes(app, ctx);
```
New:
```ts
  setupRoutes(app, ctx);
  userRoutes(app, ctx);
  requestRoutes(app, ctx);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run ../tests/users-route.test.ts`
Expected: 6 of 7 pass; the `/api/auth/me` role test still fails until Task 5 — confirm the failure is exactly `role` being `undefined`, not a 500/crash.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/users.ts server/src/app.ts tests/users-route.test.ts
git commit -m "Add admin-only /api/users: create, list, reset password, revoke friend accounts"
```

---

### Task 3: Apply `requireAdmin` to every admin-only route

**Files:**
- Modify: `server/src/routes/setup.ts`
- Modify: `server/src/routes/acquire.ts`
- Modify: `server/src/routes/search.ts`
- Modify: `server/src/routes/identify.ts`
- Modify: `server/src/routes/pipeline.ts`
- Modify: `server/src/routes/status.ts`
- Modify: `server/src/routes/jobs.ts` (guard const only — the three friend-safe GETs are untouched)
- Modify: `server/src/routes/downloads.ts` (guard const only — the two friend-safe GETs are untouched)
- Test: `tests/admin-only-routes.test.ts` (new)

**Interfaces:**
- Consumes: `app.requireAdmin` (Task 1), `userRoutes` at `/api/users` (Task 2, used by the test to provision a member session).
- Produces: nothing new — every listed route now 403s for a non-admin session instead of 200ing.

- [ ] **Step 1: Write the failing test**

Create `tests/admin-only-routes.test.ts`:

```ts
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

  it("queue mutations are blocked for a member", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/queue/refresh",
      headers: { cookie: memberCookie },
    });
    expect(r.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run ../tests/admin-only-routes.test.ts`
Expected: FAIL — every `ADMIN_ONLY_GETS` entry currently returns 200/409/502 (not 403) for the member session, and both mutation tests fail (200-ish instead of 403).

- [ ] **Step 3: Implement**

Apply this exact mechanical substitution in each file (every occurrence — a file may have several):

| Old | New |
|---|---|
| `{ preHandler: [app.requireAuth, app.requireCsrf] }` | `{ preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] }` |
| `{ preHandler: app.requireAuth }` | `{ preHandler: [app.requireAuth, app.requireAdmin] }` |

**`server/src/routes/setup.ts`** — all 4 occurrences (the `guard` const, plus the 3 bare-`requireAuth` GETs: `/api/services`, `/api/libraries`, `/api/config/roots`).

**`server/src/routes/acquire.ts`** — all 5 occurrences (the `guard` const at line 121, plus GETs `/api/acquire/lookup`, `/api/acquire/defaults`, `/api/acquire/targets`, `/api/acquire/search/:id`).

**`server/src/routes/search.ts`** — all 4 occurrences (the `guard` const, plus GETs `/api/search/sources`, `/api/search/indexers`, `/api/search`).

**`server/src/routes/identify.ts`** — all 3 occurrences (the `guard` const, plus GETs `/api/identify/status`, `/api/identify/models`).

**`server/src/routes/pipeline.ts`** — all 3 occurrences (the `guard` const, plus GETs `/api/pipeline/check`, `/api/pipeline/failed-imports`).

**`server/src/routes/status.ts`** — all 7 occurrences (no `guard` const in this file — every route is a bare-`requireAuth` GET: `/api/status/health`, `/api/status/downloads`, `/api/status/arr-activity`, `/api/status/slskd`, `/api/status/failures`, `/api/status/storage`, `/api/status/mounts`).

**`server/src/routes/jobs.ts`** — **only** the `guard` const (line 33: `const guard = { preHandler: [app.requireAuth, app.requireCsrf] };`). This single change locks down `/api/intake/preview`, `/api/intake`, and `/api/jobs/:id/retry`, which all use `guard`. Do **not** touch the three bare-`requireAuth` GETs (`/api/jobs`, `/api/jobs/:id`, `/api/activity`) — those stay friend-safe.

**`server/src/routes/downloads.ts`** — **only** the `guard` const (line 54). This locks down `/api/downloads/action`, `/api/queue/refresh`, `/api/queue/:service/:id/remove`. Do **not** touch the two bare-`requireAuth` GETs (`/api/downloads`, `/api/queue`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run ../tests/admin-only-routes.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Run the full suite**

Run: `npm run test --workspace server`
Expected: PASS. Pay particular attention to `tests/routing.test.ts` (its "typed extra config" and "intake path validation" describe blocks call `/api/services`, `/api/libraries`, `/api/intake/preview` as the freshly-registered admin — those must still succeed) and `tests/intake.test.ts`, `tests/mounts.test.ts`, `tests/pipeline.test.ts`, `tests/queue-listing.test.ts` (whichever of these hit routes through `app.inject` as an authenticated admin must still pass, since the admin is unaffected by this change).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/setup.ts server/src/routes/acquire.ts server/src/routes/search.ts \
        server/src/routes/identify.ts server/src/routes/pipeline.ts server/src/routes/status.ts \
        server/src/routes/jobs.ts server/src/routes/downloads.ts tests/admin-only-routes.test.ts
git commit -m "Guard every admin-only route with requireAdmin; leave Requests/Downloads/Queue/Jobs friend-safe"
```

---

### Task 4: Attribute submitted requests to the requesting username

**Files:**
- Modify: `server/src/routes/requests.ts`
- Test: `tests/requests-attribution.test.ts` (new)

**Interfaces:**
- Consumes: `req.session.username` (Task 1); `POST /api/users` (Task 2, to create the test's member account).
- Produces: `activity.message` for a `"requested"` entry is now `Requested <title> (by <username>)`.

- [ ] **Step 1: Write the failing test**

Create `tests/requests-attribution.test.ts`:

```ts
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
      if (opts?.method === "POST") return { id: 42, title: "Dune" };
      return {};
    });

    const r = await app.inject({
      method: "POST", url: "/api/requests/movie",
      headers: { cookie: memberCookie, "x-csrf-token": memberCsrf },
      payload: { term: "dune", selectionId: "tmdb:438631", qualityProfileId: 1, rootFolderPath: "/movies", searchNow: true },
    });
    expect(r.statusCode).toBe(200);

    const entries = recentActivity(5);
    expect(entries[0].message).toBe("Requested Dune (by sam)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run ../tests/requests-attribution.test.ts`
Expected: FAIL — `entries[0].message` is `"Requested Dune"`, missing the `(by sam)` suffix.

- [ ] **Step 3: Implement**

In `server/src/routes/requests.ts`:

Old:
```ts
        const created = await a.addSelected(body);
        logActivity({ kind: "requested", service: kind, message: `Requested ${created.title}`, data: { id: created.id } });
        return { ok: true, id: created.id, title: created.title };
```
New:
```ts
        const created = await a.addSelected(body);
        logActivity({
          kind: "requested",
          service: kind,
          message: `Requested ${created.title} (by ${req.session!.username})`,
          data: { id: created.id },
        });
        return { ok: true, id: created.id, title: created.title };
```

(`req.session` is guaranteed set here — this handler is behind `guard`, which includes `app.requireAuth`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run ../tests/requests-attribution.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm run test --workspace server`
Expected: PASS (`tests/requests.test.ts` tests `ArrAdapter` directly and never asserts on `activity.message`, so it's unaffected).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/requests.ts tests/requests-attribution.test.ts
git commit -m "Attribute a submitted request to the requesting username in the activity log"
```

---

### Task 5: Expose `role` on `/api/auth/me`

**Files:**
- Modify: `server/src/routes/auth.ts`

**Interfaces:**
- Consumes: `req.session.role` (Task 1).
- Produces: `GET /api/auth/me` response gains `role: "admin" | "member" | null`.

This is covered by the last test already written in `tests/users-route.test.ts` (Task 2) — no new test file.

- [ ] **Step 1: Confirm the existing test still fails**

Run: `cd server && npx vitest run ../tests/users-route.test.ts -t "exposes role"`
Expected: FAIL — `role` is `undefined` on both assertions.

- [ ] **Step 2: Implement**

In `server/src/routes/auth.ts`:

Old:
```ts
  // Session probe for the SPA (also returns whether setup is needed).
  app.get("/api/auth/me", async (req) => {
    return {
      authenticated: !!req.session,
      needsSetup: !adminExists(),
      csrfToken: req.session?.csrfToken ?? null,
    };
  });
```
New:
```ts
  // Session probe for the SPA (also returns whether setup is needed).
  app.get("/api/auth/me", async (req) => {
    return {
      authenticated: !!req.session,
      needsSetup: !adminExists(),
      csrfToken: req.session?.csrfToken ?? null,
      role: req.session?.role ?? null,
    };
  });
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd server && npx vitest run ../tests/users-route.test.ts`
Expected: PASS (all 7 tests in the file)

- [ ] **Step 4: Run the full suite**

Run: `npm run test --workspace server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/auth.ts
git commit -m "Expose role on GET /api/auth/me"
```

---

### Task 6: Frontend — hide admin nav items and gate admin routes for a member

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Layout.tsx`

**Interfaces:**
- Consumes: `role` field on the `/api/auth/me` response (Task 5).
- Produces: a `member`-role user sees only Requests/Downloads/Queue/Jobs (+ transfer chip) in the nav, and is redirected to `/requests` if they open an admin URL directly.

No automated test (no frontend test setup in this repo). Verified by build (type-check) plus the manual browser check in Task 8.

- [ ] **Step 1: Update `web/src/components/Layout.tsx`**

Old (lines 14–47):
```tsx
interface NavItem { to: string; label: string; icon: IconName; end?: boolean }

export const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: "dashboard", end: true }],
  },
  {
    group: "Acquire",
    items: [
      { to: "/get", label: "Get", icon: "plus" },
      { to: "/search", label: "Raw search", icon: "search" },
      { to: "/downloads", label: "Downloads", icon: "download" },
      { to: "/queue", label: "Queue", icon: "queue" },
      { to: "/requests", label: "Requests", icon: "star" },
    ],
  },
  {
    group: "Library",
    items: [
      { to: "/intake", label: "Intake", icon: "inbox" },
      { to: "/libraries", label: "Libraries", icon: "book" },
      { to: "/jobs", label: "Jobs & activity", icon: "clock" },
    ],
  },
  {
    group: "System",
    items: [
      { to: "/services", label: "Services", icon: "plug" },
      { to: "/mounts", label: "Mounts", icon: "server" },
      { to: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];
```
New:
```tsx
interface NavItem { to: string; label: string; icon: IconName; end?: boolean; adminOnly?: boolean }

export const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: "dashboard", end: true, adminOnly: true }],
  },
  {
    group: "Acquire",
    items: [
      { to: "/get", label: "Get", icon: "plus", adminOnly: true },
      { to: "/search", label: "Raw search", icon: "search", adminOnly: true },
      { to: "/downloads", label: "Downloads", icon: "download" },
      { to: "/queue", label: "Queue", icon: "queue" },
      { to: "/requests", label: "Requests", icon: "star" },
    ],
  },
  {
    group: "Library",
    items: [
      { to: "/intake", label: "Intake", icon: "inbox", adminOnly: true },
      { to: "/libraries", label: "Libraries", icon: "book", adminOnly: true },
      { to: "/jobs", label: "Jobs & activity", icon: "clock" },
    ],
  },
  {
    group: "System",
    items: [
      { to: "/services", label: "Services", icon: "plug", adminOnly: true },
      { to: "/mounts", label: "Mounts", icon: "server", adminOnly: true },
      { to: "/settings", label: "Settings", icon: "settings", adminOnly: true },
      { to: "/users", label: "Users", icon: "shield", adminOnly: true },
    ],
  },
];
```

Old:
```tsx
export function Layout({ onLogout }: { onLogout: () => void }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
```
New:
```tsx
export function Layout({ onLogout, role }: { onLogout: () => void; role: "admin" | "member" | null }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const visibleNav = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || role === "admin") }))
    .filter((g) => g.items.length > 0);
```

Old:
```tsx
        <nav>
          {NAV.map((g) => (
```
New:
```tsx
        <nav>
          {visibleNav.map((g) => (
```

- [ ] **Step 2: Update `web/src/App.tsx`**

Old:
```tsx
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
```
New:
```tsx
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
```

Old:
```tsx
import { Settings } from "./pages/Settings.js";
import { NotFound } from "./pages/NotFound.js";

interface Me { authenticated: boolean; needsSetup: boolean; csrfToken: string | null }
```
New:
```tsx
import { Settings } from "./pages/Settings.js";
import { Users } from "./pages/Users.js";
import { NotFound } from "./pages/NotFound.js";

interface Me { authenticated: boolean; needsSetup: boolean; csrfToken: string | null; role: "admin" | "member" | null }

function RequireAdmin({ role, children }: { role: Me["role"]; children: ReactElement }) {
  return role === "admin" ? children : <Navigate to="/requests" replace />;
}
```

Old (the final return statement):
```tsx
  return (
    <Routes>
      <Route element={<Layout onLogout={logout} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/get" element={<Acquire />} />
        <Route path="/search" element={<Search />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/intake" element={<Intake />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/libraries" element={<Libraries />} />
        <Route path="/mounts" element={<Mounts />} />
        <Route path="/services" element={<Services />} />
        <Route path="/settings" element={<Settings />} />
        {/* Legacy hash-free aliases from the prototype's page names. */}
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
```
New:
```tsx
  return (
    <Routes>
      <Route element={<Layout onLogout={logout} role={me.role} />}>
        <Route path="/" element={<RequireAdmin role={me.role}><Dashboard /></RequireAdmin>} />
        <Route path="/get" element={<RequireAdmin role={me.role}><Acquire /></RequireAdmin>} />
        <Route path="/search" element={<RequireAdmin role={me.role}><Search /></RequireAdmin>} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/intake" element={<RequireAdmin role={me.role}><Intake /></RequireAdmin>} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/libraries" element={<RequireAdmin role={me.role}><Libraries /></RequireAdmin>} />
        <Route path="/mounts" element={<RequireAdmin role={me.role}><Mounts /></RequireAdmin>} />
        <Route path="/services" element={<RequireAdmin role={me.role}><Services /></RequireAdmin>} />
        <Route path="/settings" element={<RequireAdmin role={me.role}><Settings /></RequireAdmin>} />
        <Route path="/users" element={<RequireAdmin role={me.role}><Users /></RequireAdmin>} />
        {/* Legacy hash-free aliases from the prototype's page names. */}
        <Route path="/dashboard" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
```

(`Users` is imported here even though the page itself is written in Task 7 — that's fine, Task 7 creates the file this import resolves to; the build only needs to succeed once both tasks have landed, which Step 3 below confirms.)

- [ ] **Step 3: Type-check** (this will fail until Task 7 adds `pages/Users.tsx` — that's expected; re-run after Task 7)

Run: `npm run build --workspace web`
Expected at this point: FAIL, specifically on the missing `./pages/Users.js` module — confirms every other part of this task compiles.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/components/Layout.tsx
git commit -m "Frontend: hide admin nav for a member and redirect off admin routes"
```

---

### Task 7: `Users.tsx` admin page

**Files:**
- Create: `web/src/pages/Users.tsx`

**Interfaces:**
- Consumes: `GET /api/users`, `POST /api/users`, `POST /api/users/:id/password`, `DELETE /api/users/:id` (Task 2); `usePolled`, `useMutation`, `apiSend` (existing `web/src/lib/*`); `Alert, Async, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, TableWrap, TextField` (existing `web/src/components/ui.tsx`).
- Produces: `Users` component, imported by `App.tsx` (Task 6) at `/users`.

- [ ] **Step 1: Create `web/src/pages/Users.tsx`**

```tsx
/**
 * Users — friend accounts that can search/request media without reaching any
 * admin page. Creating an account here always sets role: "member" — a second
 * admin can never be created from this page, only at first-run setup.
 *
 * Consumes `GET /api/users`, `POST /api/users`, `POST /api/users/:id/password`,
 * `DELETE /api/users/:id`.
 */
import { useState, type FormEvent } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader,
  TableWrap, TextField,
} from "../components/ui.js";

interface UserRow { id: number; username: string; role: "admin" | "member"; createdAt: number }
interface UsersResponse { users: UserRow[] }

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function Users() {
  const q = usePolled<UsersResponse>("/api/users", 0);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [removeTarget, setRemoveTarget] = useState<UserRow | null>(null);

  const create = useMutation(
    (body: { username: string; password: string }) =>
      apiSend<{ ok: true; user: UserRow }>("/api/users", "POST", body),
    { invalidates: ["/api/users"] },
  );
  const reset = useMutation(
    (input: { id: number; password: string }) =>
      apiSend<{ ok: true }>(`/api/users/${input.id}/password`, "POST", { password: input.password }),
  );
  const remove = useMutation(
    (u: UserRow) => apiSend<{ ok: true }>(`/api/users/${u.id}`, "DELETE"),
    { invalidates: ["/api/users"] },
  );

  async function submitCreate(e: FormEvent) {
    e.preventDefault();
    const r = await create.run({ username, password });
    if (r.ok) { setUsername(""); setPassword(""); }
  }

  const canCreate = username.trim() !== "" && password.length >= 8;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Friend accounts can search and request media (Requests, Downloads, Queue, Jobs) but never reach Services, Settings, Libraries, Mounts or Intake."
      />

      <Card title="Accounts" icon="shield">
        <Async q={q} what="users">
          {(data) => (
            data.users.length === 0 ? (
              <EmptyState icon="shield" title="No accounts yet" message="This shouldn't happen — the admin account is created at first run." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Role</th>
                      <th>Created</th>
                      <th className="shrink" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.username}</td>
                        <td className="nowrap"><Badge tone={u.role === "admin" ? "info" : "neutral"}>{u.role}</Badge></td>
                        <td className="nowrap">{fmtDate(u.createdAt)}</td>
                        <td className="shrink row-nowrap">
                          {u.role === "member" && (
                            <>
                              <Button
                                size="sm" variant="ghost" icon="settings" title="Reset password"
                                aria-label={`Reset password for ${u.username}`}
                                onClick={() => { setResetPassword(""); reset.reset(); setResetTarget(u); }}
                              />
                              <Button
                                size="sm" variant="ghost" icon="trash" title="Revoke"
                                aria-label={`Revoke ${u.username}`}
                                onClick={() => { remove.reset(); setRemoveTarget(u); }}
                              />
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )
          )}
        </Async>
      </Card>

      <Card title="Add a friend" icon="plus">
        {create.error && <Alert tone="err" title="Could not create account">{create.error}</Alert>}
        {create.data && !create.error && (
          <Alert tone="ok" title="Account created">
            "{create.data.user.username}" can now sign in and use Requests, Downloads, Queue and Jobs.
          </Alert>
        )}
        <form className="stack" onSubmit={submitCreate}>
          <div className="grid-2">
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="sam"
              required
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="At least 8 characters."
              required
            />
          </div>
          <div className="row">
            <Button type="submit" variant="primary" icon="plus" pending={create.pending} disabled={!canCreate}>
              Create account
            </Button>
          </div>
        </form>
      </Card>

      {resetTarget && (
        <ConfirmDialog
          title={`Reset password for ${resetTarget.username}`}
          confirmLabel="Set new password"
          tone="primary"
          pending={reset.pending}
          error={reset.error}
          onClose={() => setResetTarget(null)}
          onConfirm={async () => {
            const r = await reset.run({ id: resetTarget.id, password: resetPassword });
            if (r.ok) setResetTarget(null);
          }}
          extra={
            <TextField
              label="New password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              hint="At least 8 characters. Signs the account out everywhere else."
              autoFocus
            />
          }
          body={<p>{resetTarget.username} will need this new password next time they sign in.</p>}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title={`Revoke ${removeTarget.username}?`}
          confirmLabel="Revoke account"
          tone="danger-solid"
          pending={remove.pending}
          error={remove.error}
          onClose={() => setRemoveTarget(null)}
          onConfirm={async () => {
            const r = await remove.run(removeTarget);
            if (r.ok) setRemoveTarget(null);
          }}
          body={<p>{removeTarget.username} is signed out immediately and can no longer log in. This does not touch anything they requested — those stay in the library.</p>}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Type-check and build**

Run: `npm run build --workspace web`
Expected: PASS (this also completes Task 6's deferred check).

- [ ] **Step 3: Run the server suite once more for a full regression check**

Run: `npm run test --workspace server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Users.tsx
git commit -m "Add admin Users page: create, reset password, revoke friend accounts"
```

---

### Task 8: Deploy to CT 111 (torhq LXC, pve-1) and verify live

**Files:** none (operational)

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Run the upgrade on the container**

`scripts/upgrade.sh` (already on the box) pulls, rebuilds, migrates (no-op here — no new migration), and restarts `torhq.service`. It refuses on a dirty working tree, so this is safe to run unattended.

```bash
ssh root@100.86.59.97 "pct exec 111 -- bash -c 'cd /srv/torhq/app && ./scripts/upgrade.sh'"
```

Expected output ends with `Upgrade complete. journalctl -u torhq -f` and no error before it.

- [ ] **Step 3: Confirm the service is healthy**

```bash
ssh root@100.86.59.97 "pct exec 111 -- systemctl is-active torhq"
ssh root@100.86.59.97 "pct exec 111 -- journalctl -u torhq -n 30 --no-pager"
```

Expected: `active`, and no error-level log lines from the restart.

- [ ] **Step 4: Verify in the browser, against the real deployed instance**

Per this project's own working rule (verify in the real thing, not just tests):

1. Open `http://192.168.10.101:8787` (or the Tailscale address `http://100.101.139.62:8787`), log in as the existing admin.
2. Open the new **Users** page (System group in the sidebar). Confirm the existing admin account is listed with no reset/revoke buttons.
3. Create a friend account (e.g. username `friendtest`, a throwaway password). Confirm the success message and that it now appears in the table with a "member" badge and both action buttons.
4. In a private/incognito window, log in as `friendtest`. Confirm the sidebar shows only Downloads, Queue, Requests, Jobs & activity (no Dashboard, Get, Raw search, Intake, Libraries, Services, Mounts, Settings, Users).
5. As `friendtest`, use **Requests** to search for and submit a real or test title. Confirm the request succeeds and appears in **Jobs & activity** with `(by friendtest)` in the message.
6. Navigate `friendtest`'s browser directly to `/services` (type the URL). Confirm it redirects to `/requests` rather than showing the page.
7. Back in the admin window, revoke `friendtest` from the **Users** page. Confirm `friendtest`'s browser tab is signed out on its next request/reload.

- [ ] **Step 5: Clean up the throwaway test account** (if not already revoked in Step 4.7)

Delete it from the **Users** page as the admin, so the live system doesn't carry a test account.

- [ ] **Step 6: Tell the user deployment is done**

Report the live URL(s), and that friend accounts are created from **Users** (admin-only) going forward. Remind them the Tailscale ACL scoping (friends' devices limited to the TorHQ LXC + Jellyfin, not the rest of the homelab) is a separate step in the Tailscale admin console, not covered by this deploy.
