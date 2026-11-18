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
import { logActivity } from "../server/src/lib/activity.js";
import { setFeedSourcesForTest, type FeedSources } from "../server/src/routes/activityFeed.js";
import { buildFeed, type FeedInput } from "../server/src/lib/activityFeed.js";
import type { ArrQueueItem } from "../server/src/adapters/arr.js";
import type { QbTorrent } from "../server/src/adapters/qbittorrent.js";
import type { PipelineCheck } from "../server/src/lib/pipeline.js";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3600_000;
const admin = { username: "admin", isAdmin: true };
const sam = { username: "sam", isAdmin: false };

const q = (over: Partial<ArrQueueItem>): ArrQueueItem => ({
  service: "radarr", id: 1, title: "Dune.2021.2160p", status: "downloading", statusMessages: [],
  size: 1000, sizeleft: 400, libraryId: 7, mediaTitle: "Dune", trackedDownloadState: "downloading",
  trackedDownloadStatus: "ok", downloadId: "AAAA", added: new Date(NOW - HOUR).toISOString(), ...over,
});
const torrent = (over: Partial<QbTorrent>): QbTorrent => ({
  hash: "aaaa", name: "Dune.2021.2160p", category: "radarr", state: "downloading", progress: 0.6, dlspeed: 1, upspeed: 0,
  size: 1000, eta: 1200, savePath: "/d", ratio: 0, addedOn: (NOW - HOUR) / 1000, tags: [], ...over,
});
const input = (over: Partial<FeedInput> = {}): FeedInput => ({
  now: NOW, requests: [], queue: [], library: new Map(), torrents: [], slskd: [], jobs: [], libraryKinds: new Map(), checks: [], ...over,
});
const req = (over = {}) => ({ service: "radarr" as const, id: 7, title: "Dune", by: "sam", at: NOW - 2 * HOUR, searched: true, ...over });
const only = (i: FeedInput, v = admin) => { const f = buildFeed(i, v); expect(f).toHaveLength(1); return f[0]!; };

describe("stage mapping", () => {
  it("a request nothing has started on is `requested`", () => {
    const it = only(input({ requests: [req({ searched: false, at: NOW - 60_000 })] }));
    expect(it).toMatchObject({ stage: "requested", status: "active", kind: "movie", title: "Dune", requestedBy: "sam" });
  });
  it("a searched request with no queue entry is `searching`", () => {
    expect(only(input({ requests: [req()] }))).toMatchObject({ stage: "searching", status: "active", progress: 0 });
  });
  it("a queue record downloading is `downloading`, with progress and ETA from the torrent", () => {
    const it = only(input({ requests: [req()], queue: [q({})], torrents: [torrent({})] }));
    expect(it).toMatchObject({ stage: "downloading", status: "active", progress: 60, etaSeconds: 1200, requestedBy: "sam" });
  });
  it("a finished download awaiting import is `importing`", () => {
    const it = only(input({ requests: [req()], queue: [q({ sizeleft: 0, trackedDownloadState: "importPending", status: "completed" })] }));
    expect(it).toMatchObject({ stage: "importing", status: "active", progress: 100, etaSeconds: null });
  });
  it("a request whose library entry has a file is `available`", () => {
    const library = new Map([["radarr:7", { title: "Dune", poster: "http://p/x.jpg", fileCount: 1, monitored: true }]]);
    expect(only(input({ requests: [req()], library }))).toMatchObject({ stage: "available", status: "done", progress: 100, artwork: "http://p/x.jpg" });
  });
  it("a season pack's records merge into one item with summed progress", () => {
    const rows = [
      q({ service: "sonarr", id: 1, libraryId: 3, mediaTitle: "Severance", size: 500, sizeleft: 0, downloadId: "A" }),
      q({ service: "sonarr", id: 2, libraryId: 3, mediaTitle: "Severance", size: 500, sizeleft: 500, downloadId: "B" }),
    ];
    const it = only(input({ queue: rows }));
    expect(it).toMatchObject({ kind: "tv", title: "Severance", stage: "downloading", progress: 50 });
  });
  it("sorts newest first and maps music/tv kinds", () => {
    const feed = buildFeed(input({ requests: [
      req({ id: 1, title: "Old", at: NOW - 5 * HOUR, service: "lidarr" }),
      req({ id: 2, title: "New", at: NOW - HOUR, service: "sonarr" }),
    ] }), admin);
    expect(feed.map((i) => [i.title, i.kind])).toEqual([["New", "tv"], ["Old", "music"]]);
  });
});

describe("stalls explain themselves", () => {
  it("an import the *arr refused says why and what to do, from the *arr's own message", () => {
    const it = only(input({ requests: [req()], queue: [q({
      sizeleft: 0, status: "completed", trackedDownloadState: "importBlocked", trackedDownloadStatus: "warning",
      statusMessages: ["No files found are eligible for import in /downloads/radarr/Dune"],
    })] }));
    expect(it.stage).toBe("importing");
    expect(it.status).toBe("stalled");
    expect(it.stall!.reason).toMatch(/nothing in it that could be imported/);
    expect(it.stall!.fix).toMatch(/blocklist/);
    expect(it.stall!.detail).toMatch(/No files found/);
  });
  it("uses a failing pipeline check as the cause when one concerns that *arr", () => {
    const check: PipelineCheck = {
      id: "radarr-sees-save-path", label: "x", ok: false, severity: "error",
      detail: "Radarr cannot see /downloads, nor the directory above.", fix: "Mount /downloads into Radarr's container.",
    };
    const it = only(input({ requests: [req()], checks: [check], queue: [q({
      sizeleft: 0, trackedDownloadState: "importPending", trackedDownloadStatus: "warning", status: "completed",
    })] }));
    expect(it.stall).toMatchObject({ reason: check.detail, fix: check.fix });
  });
  it("an item waiting to import over an hour is stalled", () => {
    const it = only(input({ queue: [q({ sizeleft: 0, status: "completed", trackedDownloadState: "importPending", added: new Date(NOW - 3 * HOUR).toISOString() })] }));
    expect(it.status).toBe("stalled");
    expect(it.stall!.reason).toMatch(/over an hour/);
  });
  it("a download the client reports stalled for a while is a stall at downloading", () => {
    const it = only(input({ queue: [q({})], torrents: [torrent({ state: "stalledDL", eta: 8640000 })] }));
    expect(it).toMatchObject({ stage: "downloading", status: "stalled", etaSeconds: null });
    expect(it.stall!.reason).toMatch(/Nobody is sharing/);
  });
  it("a failed download names the fix", () => {
    const it = only(input({ queue: [q({ trackedDownloadState: "failed", errorMessage: "boom" })] }));
    expect(it.stall).toMatchObject({ detail: "boom" });
    expect(it.stall!.fix).toMatch(/blocklist/);
  });
  it("a search that found nothing for hours stalls; a fresh one does not", () => {
    expect(only(input({ requests: [req({ at: NOW - 8 * HOUR })] })).stall!.reason).toMatch(/searched for hours/);
    expect(only(input({ requests: [req({ at: NOW - HOUR })] })).stall).toBeUndefined();
  });
  it("an admin add that never started a search stalls once it is old enough", () => {
    const it = only(input({ requests: [req({ searched: false, at: NOW - HOUR, by: "admin" })] }));
    expect(it).toMatchObject({ stage: "requested", status: "stalled" });
  });
});

describe("member visibility", () => {
  const base = input({
    requests: [req({ by: "sam" }), req({ id: 8, title: "Secret Film", by: "alex", searched: false, at: NOW - HOUR })],
    queue: [q({ libraryId: 9, mediaTitle: "Other Show", service: "sonarr", downloadId: "ZZ", sizeleft: 0, status: "completed", trackedDownloadState: "importBlocked", trackedDownloadStatus: "warning", outputPath: "/srv/secret/path" })],
    torrents: [torrent({ hash: "unmatched", name: "Private.Game.ISO", category: "torhq-games" })],
    slskd: [{ username: "peer", files: [{ filename: "a.flac", state: "InProgress", percentComplete: 10 }] }],
    jobs: [{ id: "j1", status: "failed", sourcePath: "/staging/book.epub", libraryKey: "k", lastError: "x", createdAt: NOW - HOUR }],
    libraryKinds: new Map([["k", "books"]]),
    checks: [{ id: "sonarr-sees-save-path", label: "x", ok: false, severity: "error", detail: "Sonarr cannot see /srv/secret", fix: "pct set 101 -mp0 /srv" }],
  });
  it("admin sees everything: requests, queue, raw downloads, slskd and jobs", () => {
    const ids = buildFeed(base, admin).map((i) => i.source).sort();
    expect(ids).toEqual(["arr", "arr", "arr", "job", "slskd", "torrent"]);
  });
  it("a member sees their own request in full and others' in-flight items as generic progress", () => {
    const feed = buildFeed(base, sam);
    expect(feed.map((i) => i.title).sort()).toEqual(["Dune", "Other Show", "Secret Film"]);
    const mine = feed.find((i) => i.title === "Dune")!;
    expect(mine.requestedBy).toBe("sam");
    const other = feed.find((i) => i.title === "Other Show")!;
    expect(other.requestedBy).toBeNull();
  });
  it("a member never receives paths, hrefs, requester names, raw download names or admin fixes", () => {
    const json = JSON.stringify(buildFeed(base, sam));
    for (const leak of ["/srv", "secret/path", "alex", "pct set", "Private.Game", "peer", "book.epub", "/queue", "href", "detail"]) {
      expect(json, leak).not.toContain(leak);
    }
    const stalled = buildFeed(base, sam).find((i) => i.status === "stalled")!;
    expect(stalled.stall!.fix).toMatch(/Nothing for you to do/);
  });
  it("a member does not see other people's finished items", () => {
    const library = new Map([["radarr:8", { title: "Secret Film", fileCount: 1, monitored: true }]]);
    const feed = buildFeed(input({ requests: [req({ id: 8, title: "Secret Film", by: "alex" })], library }), sam);
    expect(feed).toEqual([]);
  });
});

/* ------------------------------------------------------------------ route */

let app: FastifyInstance;
let dataDir: string;
let adminCookie = "", memberCookie = "";
let queueCalls = 0;

const sources = (over: Partial<{ failRadarr: boolean }> = {}): FeedSources => ({
  arr: (s) => s === "radarr" ? {
    queue: async () => { queueCalls++; if (over.failRadarr) throw new Error("radarr down"); return [q({ libraryId: 7, mediaTitle: "Dune" })]; },
    libraryEntry: async () => ({ title: "Hail Mary", fileCount: 1, monitored: true, poster: "http://p/h.jpg" }),
  } : null,
  qb: () => ({ torrents: async () => [torrent({}), torrent({ hash: "loose", name: "Loose.Game", category: "torhq-games", progress: 0.2 })] }),
  slskd: () => null,
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-feed-"));
  const env = loadEnv({ NODE_ENV: "test", TORHQ_MASTER_KEY: "test-master-key-0123456789", TORHQ_DATA_DIR: dataDir, TORHQ_APPROVED_ROOTS: dataDir } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  app = await buildApp(makeContext(env));
  await app.ready();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "admin", password: "supersecret1" } });
  const csrf = reg.json().csrfToken;
  adminCookie = reg.cookies[0].name + "=" + reg.cookies[0].value;
  await app.inject({ method: "POST", url: "/api/users", headers: { cookie: adminCookie, "x-csrf-token": csrf }, payload: { username: "sam", password: "friendpass1" } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "sam", password: "friendpass1" } });
  memberCookie = login.cookies[0].name + "=" + login.cookies[0].value;

  logActivity({ kind: "requested", service: "radarr", message: "Requested Dune (by sam)", data: { id: 7, title: "Dune", by: "sam", searched: true } });
  logActivity({ kind: "requested", service: "radarr", message: "Requested Hail Mary (by alex)", data: { id: 8, title: "Hail Mary", by: "alex", searched: true } });
  setFeedSourcesForTest(sources());
});
afterAll(async () => {
  setFeedSourcesForTest(null);
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/activity", () => {
  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/activity" })).statusCode).toBe(401);
  });
  it("gives the admin one merged list: queue item, finished request, raw download", async () => {
    const r = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as any[];
    const by = (t: string) => items.find((i) => i.title === t);
    expect(by("Dune")).toMatchObject({ kind: "movie", stage: "downloading", progress: 60, requestedBy: "sam", href: "/queue" });
    expect(by("Hail Mary")).toMatchObject({ stage: "available", artwork: "http://p/h.jpg", requestedBy: "alex" });
    expect(by("Loose.Game")).toMatchObject({ kind: "game", source: "torrent", href: "/downloads" });
    for (const i of items) {
      for (const k of ["id", "kind", "title", "artwork", "stage", "progress", "etaSeconds", "requestedBy"]) expect(i, k).toHaveProperty(k);
    }
    const times = items.map((i) => i.startedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
  it("gives a member only their own requests plus generic in-flight progress", async () => {
    const r = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: memberCookie } });
    expect(r.statusCode).toBe(200);
    const titles = (r.json().items as any[]).map((i) => i.title);
    expect(titles).toEqual(["Dune"]); // alex's finished one and the raw game are not theirs
    expect(JSON.stringify(r.json())).not.toMatch(/alex|Loose|href/);
  });
  it("degrades a down *arr into `unavailable` for the admin instead of failing", async () => {
    setFeedSourcesForTest(sources({ failRadarr: true }));
    const r = await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().unavailable).toEqual([{ source: "radarr", detail: "radarr down" }]);
    setFeedSourcesForTest(sources());
  });
  it("the raw audit log moved to /api/activity/log and is admin-only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/activity/log", headers: { cookie: memberCookie } })).statusCode).toBe(403);
    const r = await app.inject({ method: "GET", url: "/api/activity/log", headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().activity.length).toBeGreaterThan(0);
  });
  it("does not fetch slskd, jobs or pipeline checks for a member", async () => {
    let slskdAsked = false;
    setFeedSourcesForTest({ ...sources(), slskd: () => { slskdAsked = true; return null; } });
    await app.inject({ method: "GET", url: "/api/activity", headers: { cookie: memberCookie } });
    expect(slskdAsked).toBe(false);
    setFeedSourcesForTest(sources());
  });
});
