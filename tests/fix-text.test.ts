/**
 * The "what to do" text on Activity stalls and on Transfers' Needs attention
 * must only name pages, sections and buttons that exist. The Advanced pages
 * (Get, Raw search, Downloads, Queue, Jobs & log, Requests, Intake) and their
 * controls (Pipeline health, Failed imports, Manual import, recheck, slskd
 * retry) are gone, so an admin following a fix that names them gets lost.
 */
import { describe, it, expect } from "vitest";
import { buildFeed, type FeedInput } from "../server/src/lib/activityFeed.js";
import { buildPipelineChecks, STUCK_IMPORT_MS, type ArrSnapshot, type QbSnapshot } from "../server/src/lib/pipeline.js";
import type { ArrDownloadClient, ArrQueueItem } from "../server/src/adapters/arr.js";
import type { QbTorrent } from "../server/src/adapters/qbittorrent.js";

const RETIRED: RegExp[] = [
  /pipeline health/i, /failed imports/i, /manual import/i, /\brecheck\b/i,
  /another user/i, /raw search/i, /jobs (&|and) log/i,
  /\b(queue|downloads|intake|get|requests) page\b/i,
  /\bopen (the )?(queue|downloads|intake)\b/i,
];

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3600_000;
const admin = { username: "admin", isAdmin: true };

const q = (over: Partial<ArrQueueItem>): ArrQueueItem => ({
  service: "radarr", id: 1, title: "Dune.2021.2160p", status: "completed", statusMessages: [],
  size: 1000, sizeleft: 0, libraryId: 7, mediaTitle: "Dune", trackedDownloadState: "importBlocked",
  trackedDownloadStatus: "warning", downloadId: "AAAA", added: new Date(NOW - 3 * HOUR).toISOString(), ...over,
});
const torrent = (over: Partial<QbTorrent>): QbTorrent => ({
  hash: "aaaa", name: "Dune.2021.2160p", category: "radarr", state: "downloading", progress: 0.6, dlspeed: 1, upspeed: 0,
  size: 1000, eta: 1200, savePath: "/d", ratio: 0, addedOn: (NOW - HOUR) / 1000, tags: [], ...over,
});
const input = (over: Partial<FeedInput> = {}): FeedInput => ({
  now: NOW, requests: [], queue: [], library: new Map(), torrents: [], slskd: [], jobs: [], libraryKinds: new Map(), checks: [], ...over,
});

/** Every stall the feed can raise for an admin, one scenario per branch. */
function feedFixes(): string[] {
  const msgs = [
    "No files found are eligible for import in /downloads/radarr/Dune",
    "Unable to parse the release",
    "Directory does not exist: /downloads",
    "Not an upgrade for existing movie file",
    "Something else entirely",
  ];
  const scenarios: FeedInput[] = [
    ...msgs.map((m) => input({ queue: [q({ statusMessages: [m] })] })),
    input({ queue: [q({ trackedDownloadState: "importPending", trackedDownloadStatus: "ok" })] }),
    input({ queue: [q({ trackedDownloadState: "failed", errorMessage: "boom" })] }),
    input({ queue: [q({ trackedDownloadState: "downloading", trackedDownloadStatus: "ok", sizeleft: 400, status: "downloading" })],
      torrents: [torrent({ state: "error" })] }),
    input({ queue: [q({ trackedDownloadState: "downloading", trackedDownloadStatus: "ok", sizeleft: 400, status: "downloading" })],
      torrents: [torrent({ state: "pausedDL" })] }),
    input({ torrents: [torrent({ hash: "bbbb", category: "other", state: "missingFiles" })] }),
    input({ slskd: [{ username: "peer", files: [{ filename: "a.flac", state: "Completed, Errored", percentComplete: 0 }] }] }),
  ];
  const fixes = scenarios.flatMap((s) => buildFeed(s, admin).map((i) => i.stall?.fix).filter((f): f is string => !!f));
  // Every scenario above is a stall, so a missing fix means the scenario rotted, not that the text is fine.
  expect(fixes.length).toBe(scenarios.length);
  return fixes;
}

function pipelineFixes(): string[] {
  const client = (fields: Record<string, unknown>): ArrDownloadClient =>
    ({ id: 1, name: "qBittorrent", implementation: "QBittorrent", enable: true, fields });
  const arr = (over: Partial<ArrSnapshot>): ArrSnapshot => ({
    service: "radarr", configured: true,
    downloadClients: [client({ host: "qbittorrent", port: 8090, movieCategory: "radarr" })],
    config: { enableCompletedDownloadHandling: true },
    rootFolders: [{ id: 1, path: "/mnt/storage/movies", accessible: true }],
    queue: [], visiblePaths: [{ path: "/mnt/torrents/radarr", visible: true, parentVisible: true }], ...over,
  });
  const qb: QbSnapshot = { configured: true, categories: { radarr: { name: "radarr", savePath: "/mnt/torrents/radarr" } }, defaultSavePath: "/mnt/torrents", torrents: [] };
  const stuck: ArrQueueItem = {
    service: "radarr", id: 1, title: "Some Movie", status: "completed", trackedDownloadState: "importPending",
    statusMessages: [], size: 100, sizeleft: 0, added: new Date(NOW - 3 * STUCK_IMPORT_MS).toISOString(),
  };
  const runs = [
    buildPipelineChecks({ qb, arrs: [arr({ downloadClients: [client({ movieCategory: "films" })] })], now: NOW }),
    buildPipelineChecks({ qb, arrs: [arr({ queue: [stuck] })], now: NOW }),
    buildPipelineChecks({ qb, arrs: [arr({ visiblePaths: [{ path: "/mnt/torrents/radarr", visible: false, parentVisible: false }] })], now: NOW }),
    buildPipelineChecks({ qb: { configured: false }, arrs: [{ service: "radarr", configured: true, error: "ECONNREFUSED" }], now: NOW }),
  ];
  const fixes = runs.flatMap((r) => r.filter((c) => !c.ok && c.fix).map((c) => c.fix!));
  expect(fixes.some((f) => /categor/i.test(f))).toBe(true);
  expect(fixes.some((f) => /Retry import/.test(f))).toBe(true);
  return fixes;
}

const offenders = (fixes: string[]) => fixes.filter((f) => RETIRED.some((r) => r.test(f)));

describe("fix text names only things that exist", () => {
  it("Activity stall fixes never point at a retired page or control", () => {
    expect(offenders(feedFixes())).toEqual([]);
  });
  it("pipeline check fixes (shown on Transfers) never point at a retired page or control", () => {
    expect(offenders(pipelineFixes())).toEqual([]);
  });
  it("import stalls point at the real Transfers controls", () => {
    const fixes = feedFixes();
    expect(fixes.some((f) => /Needs attention/.test(f))).toBe(true);
    expect(fixes.some((f) => /Retry import/.test(f))).toBe(true);
  });
});
