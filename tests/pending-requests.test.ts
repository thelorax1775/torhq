import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Activity's Requests tab: member book/audiobook requests wait for the admin,
// who approves (TorHQ grabs the best-ranked release) or declines. Prowlarr and
// qBittorrent are mocked behind the adapter registry.
const { getAdapter } = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("../server/src/adapters/registry.js", () => ({
  getAdapter,
  checkAllHealth: vi.fn(async () => ({})),
  testConfig: vi.fn(async () => ({ healthy: true })),
}));

const { initDb, getDb } = await import("../server/src/db/index.js");
const { runMigrations } = await import("../server/src/db/migrate.js");
const { loadEnv } = await import("../server/src/config/env.js");
const { makeContext } = await import("../server/src/lib/context.js");
const { buildApp } = await import("../server/src/app.js");
const { wantedItems } = await import("../server/src/db/schema.js");
const { getWanted, tagFor } = await import("../server/src/lib/wanted.js");

const MAGNET = (c: string) => "magnet:?xt=urn:btih:" + c.repeat(40);
const rel = (over: Record<string, unknown>) => ({
  guid: "g", indexerId: 3, indexer: "idx", title: "Dune Frank Herbert epub", size: 1_000_000,
  seeders: 5, leechers: 0, protocol: "torrent", publishDate: null, categories: [{ id: 7020, name: "Books/EBook" }], ...over,
}) as any;

let app: FastifyInstance, root: string;
let adminCookie = "", adminCsrf = "", memberCookie = "", memberCsrf = "";
let releases: any[];
const added: any[] = [];
const h = (cookie: string, csrf?: string) => ({ cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) });
const post = (url: string, cookie: string, csrf: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url, headers: h(cookie, csrf), payload: payload as any });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "torhq-pending-"));
  mkdirSync(join(root, "data"), { recursive: true });
  const env = loadEnv({
    NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: join(root, "data"), TORHQ_APPROVED_ROOTS: root,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  app = await buildApp(makeContext(env));
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
  adminCsrf = reg.json().csrfToken;
  adminCookie = reg.cookies[0]!.name + "=" + reg.cookies[0]!.value;
  await app.inject({ method: "POST", url: "/api/users", headers: h(adminCookie, adminCsrf), payload: { username: "friend", password: "friendpass1" } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "friend", password: "friendpass1" } });
  memberCsrf = login.json().csrfToken;
  memberCookie = login.cookies[0]!.name + "=" + login.cookies[0]!.value;
});
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  added.length = 0;
  getDb().delete(wantedItems).run();
  releases = [
    rel({ guid: "pdf", title: "Dune Frank Herbert pdf", seeders: 500, magnetUrl: MAGNET("a") }),
    rel({ guid: "epub", title: "Dune Frank Herbert epub", seeders: 8, magnetUrl: MAGNET("b") }),
  ];
  const adapters: Record<string, unknown> = {
    prowlarr: { search: vi.fn(async () => releases), signDownloadUrl: vi.fn((u: string) => u) },
    qbittorrent: { addTorrent: vi.fn(async (a: any) => { added.push(a); }), torrents: vi.fn(async () => []) },
  };
  getAdapter.mockImplementation((k: string) => adapters[k] ?? null);
});

async function memberRequest(base = "/api/books", title = "Dune"): Promise<string> {
  const r = await post(`${base}/request`, memberCookie, memberCsrf, { title, author: "Frank Herbert" });
  expect(r.statusCode).toBe(200);
  return r.json().item.id;
}

describe("pending member requests", () => {
  it("lists what waits for the admin and counts it for the nav badge", async () => {
    const id = await memberRequest();
    await memberRequest("/api/audiobooks", "Anthem");
    const list = await app.inject({ method: "GET", url: "/api/requests/pending", headers: h(adminCookie) });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as any[];
    expect(items.map((i) => [i.kind, i.title, i.requestedBy]).sort()).toEqual([["audiobook", "Anthem", "friend"], ["book", "Dune", "friend"]]);
    expect(items.find((i) => i.id === id)).not.toHaveProperty("sourcePath");
    const counts = await app.inject({ method: "GET", url: "/api/attention", headers: h(adminCookie) });
    expect(counts.json()).toEqual({ requests: 2, imports: 0 });
  });

  it("approve grabs the best-ranked release into the flow's category and leaves the list", async () => {
    const id = await memberRequest();
    const r = await post(`/api/requests/pending/${id}/approve`, adminCookie, adminCsrf);
    expect(r.statusCode).toBe(200);
    expect(r.json().release).toBe("Dune Frank Herbert epub"); // epub outranks a better-seeded pdf
    expect(added).toEqual([{ url: MAGNET("b"), category: "torhq-books", tags: [tagFor(id)] }]);
    expect(getWanted(id)!.status).toBe("grabbed");
    const list = await app.inject({ method: "GET", url: "/api/requests/pending", headers: h(adminCookie) });
    expect(list.json().items).toEqual([]);
    // A second approve is refused rather than grabbing twice.
    expect((await post(`/api/requests/pending/${id}/approve`, adminCookie, adminCsrf)).statusCode).toBe(409);
    expect(added).toHaveLength(1);
  });

  it("approve says so when nothing matches, and grabs nothing", async () => {
    releases = [rel({ guid: "x", title: "Something Else entirely", seeders: 9, magnetUrl: MAGNET("c") })];
    const id = await memberRequest();
    const r = await post(`/api/requests/pending/${id}/approve`, adminCookie, adminCsrf);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/Choose one by hand/);
    expect(added).toEqual([]);
    expect(getWanted(id)!.status).toBe("requested");
  });

  it("decline marks the request declined", async () => {
    const id = await memberRequest();
    const r = await post(`/api/requests/pending/${id}/decline`, adminCookie, adminCsrf);
    expect(r.statusCode).toBe(200);
    expect(getWanted(id)!.status).toBe("declined");
    expect(added).toEqual([]);
  });

  it("a member can call none of it", async () => {
    const id = await memberRequest();
    for (const url of ["/api/requests/pending", "/api/attention"]) {
      expect((await app.inject({ method: "GET", url, headers: h(memberCookie) })).statusCode, url).toBe(403);
    }
    for (const action of ["approve", "decline"]) {
      const r = await post(`/api/requests/pending/${id}/${action}`, memberCookie, memberCsrf);
      expect(r.statusCode, action).toBe(403);
    }
    expect(getWanted(id)!.status).toBe("requested");
    expect(added).toEqual([]);
    // And not without a session at all.
    expect((await app.inject({ method: "POST", url: `/api/requests/pending/${id}/approve` })).statusCode).toBe(401);
  });

  it("the admin needs CSRF to approve", async () => {
    const id = await memberRequest();
    const r = await app.inject({ method: "POST", url: `/api/requests/pending/${id}/approve`, headers: h(adminCookie) });
    expect(r.statusCode).toBe(403);
    expect(added).toEqual([]);
  });
});
