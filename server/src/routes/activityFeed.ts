import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { QbittorrentAdapter } from "../adapters/qbittorrent.js";
import type { SlskdAdapter } from "../adapters/slskd.js";
import type { ArrAdapter, ArrFlavor, ArrLibraryEntry, ArrQueueItem } from "../adapters/arr.js";
import { activityOfKind, recentActivity } from "../lib/activity.js";
import {
  buildFeed, libraryKey, type FeedInput, type FeedJob, type FeedRequest,
} from "../lib/activityFeed.js";
import { buildPipelineChecks, type ArrSnapshot, type QbSnapshot } from "../lib/pipeline.js";
import { getDb } from "../db/index.js";
import { libraries } from "../db/schema.js";
import { listJobs } from "../queue/queue.js";
import { listWanted } from "../lib/wanted.js";
import type { AppContext } from "../lib/context.js";
import { ARR_SERVICES } from "./downloads.js";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const LimitQuery = z.object({
  // Coerced and clamped rather than trusted: SQLite reads a negative LIMIT as
  // "no limit", and a non-numeric value would reach the driver as NaN.
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Test hook: replace the real adapters with mocks. */
export interface FeedSources {
  arr(service: ArrFlavor): Pick<ArrAdapter, "queue" | "libraryEntry"> | null;
  qb(): Pick<QbittorrentAdapter, "torrents"> | null;
  slskd(): Pick<SlskdAdapter, "downloads"> | null;
}
let override: FeedSources | null = null;
export function setFeedSourcesForTest(s: FeedSources | null): void { override = s; }

function parse(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try { const v = JSON.parse(json); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** Requests the audit log recorded, with whether an automatic search followed. */
function recentRequests(now: number): FeedRequest[] {
  const since = now - WINDOW_MS;
  const searches = activityOfKind("queued", since, 500).map((r) => ({
    service: r.service, id: parse(r.dataJson).id, at: r.createdAt,
  }));
  const out: FeedRequest[] = [];
  for (const row of activityOfKind("requested", since, 500)) {
    const data = parse(row.dataJson);
    const service = row.service as ArrFlavor | null;
    if (!service || !(ARR_SERVICES as readonly string[]).includes(service) || typeof data.id !== "number") continue;
    const m = /^(?:Requested|Prepared) "?(.+?)"?(?: \(by (.+)\)| in \w+ \(.*\))?$/.exec(row.message);
    const by = typeof data.by === "string" ? data.by : m?.[2] ?? null;
    const searchedLater = searches.some((s) => s.service === service && s.id === data.id && s.at >= row.createdAt);
    out.push({
      service, id: data.id,
      title: typeof data.title === "string" ? data.title : m?.[1] ?? row.message,
      by, at: row.createdAt,
      searched: data.searched !== false || searchedLater,
    });
  }
  return out;
}

export function activityFeedRoutes(app: FastifyInstance, ctx: AppContext): void {
  const src: () => FeedSources = () => override ?? {
    arr: (s) => getAdapter(s, ctx.masterKey) as ArrAdapter | null,
    qb: () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null,
    slskd: () => getAdapter("slskd", ctx.masterKey) as SlskdAdapter | null,
  };

  /**
   * One list for Activity: every requested item, where it is in
   * requested -> searching -> downloading -> importing -> available, and why it
   * is stuck when it is. Members get their own requests plus other people's
   * in-flight items as generic progress (no requester, no paths, no fixes that
   * need admin pages); the admin gets everything. A source that is down degrades
   * into `unavailable` and never fails the response.
   */
  app.get("/api/activity", { preHandler: app.requireAuth }, async (req) => {
    const { limit } = LimitQuery.parse(req.query ?? {});
    const viewer = { username: req.session!.username, isAdmin: req.session!.role === "admin" };
    const now = Date.now();
    const s = src();
    const unavailable: Array<{ source: string; detail: string }> = [];
    const note = (source: string, e: unknown) => unavailable.push({ source, detail: e instanceof Error ? e.message : String(e) });

    const queue: ArrQueueItem[] = [];
    const arrs = new Map<ArrFlavor, Pick<ArrAdapter, "queue" | "libraryEntry">>();
    await Promise.all(ARR_SERVICES.map(async (service) => {
      const a = s.arr(service);
      if (!a) return;
      arrs.set(service, a);
      try { queue.push(...await a.queue()); } catch (e) { note(service, e); }
    }));

    const requests = recentRequests(now);
    const queued = new Set(queue.filter((q) => q.libraryId != null).map((q) => libraryKey(q.service, q.libraryId!)));
    const library = new Map<string, ArrLibraryEntry>();
    await Promise.all(requests.filter((r) => !queued.has(libraryKey(r.service, r.id))).map(async (r) => {
      const a = arrs.get(r.service);
      if (!a) return;
      try { library.set(libraryKey(r.service, r.id), await a.libraryEntry(r.id)); } catch { /* unknown, treated as not yet here */ }
    }));

    // Admin-only sources are not even fetched for a member.
    let torrents: FeedInput["torrents"] = [];
    let slskd: FeedInput["slskd"] = [];
    let jobs: FeedJob[] = [];
    let checks: FeedInput["checks"] = [];
    const libraryKinds = new Map<string, string>();
    const qb = s.qb();
    if (qb) {
      try { torrents = await qb.torrents(); } catch (e) { note("qbittorrent", e); }
    }
    if (viewer.isAdmin) {
      const sk = s.slskd();
      if (sk) { try { slskd = await sk.downloads(); } catch (e) { note("slskd", e); } }
      jobs = listJobs(undefined, 50).filter((j) => j.createdAt >= now - WINDOW_MS);
      for (const l of getDb().select().from(libraries).all()) libraryKinds.set(l.key, l.kind);
    }
    // Pipeline health explains a stall to an admin; it never reaches a member.
    if (viewer.isAdmin && queue.length > 0) {
      const qbSnap: QbSnapshot = qb ? { configured: true, torrents } : { configured: false };
      const arrSnaps: ArrSnapshot[] = ARR_SERVICES.map((service) =>
        arrs.has(service) ? { service, configured: true, queue: queue.filter((q) => q.service === service) } : { service, configured: false });
      checks = buildPipelineChecks({ qb: qbSnap, arrs: arrSnaps, now });
    }

    // Book and audiobook requests live outside every *arr; the feed filters them per viewer.
    const wanted = listWanted().filter((w) => w.createdAt >= now - WINDOW_MS);

    const items = buildFeed({
      now, requests, queue, library, torrents, slskd,
      jobs: jobs.map((j) => ({ id: j.id, status: j.status, sourcePath: j.sourcePath, libraryKey: j.libraryKey, lastError: j.lastError, createdAt: j.createdAt })),
      wanted, libraryKinds, checks,
    }, viewer).slice(0, limit);
    return { items, unavailable: viewer.isAdmin ? unavailable : [] };
  });

  // The raw append-only audit log (what /api/activity used to return). Admin
  // only: it names users, paths and every action TorHQ took.
  app.get("/api/activity/log", { preHandler: [app.requireAuth, app.requireAdmin] }, async (req) => {
    const { limit } = LimitQuery.parse(req.query ?? {});
    return { activity: recentActivity(limit) };
  });
}
