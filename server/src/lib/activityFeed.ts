import type { ArrFlavor, ArrLibraryEntry, ArrQueueItem } from "../adapters/arr.js";
import type { QbTorrent } from "../adapters/qbittorrent.js";
import { STUCK_IMPORT_MS, needsManualImport, type PipelineCheck } from "./pipeline.js";

/**
 * The Activity view's model: every item a person asked for (or the stack is
 * working on), followed through requested -> searching -> downloading ->
 * importing -> available. Pure functions over snapshots the route fetches, so the
 * merge, the stage mapping and the stall wording are all testable with mocked
 * adapters. Read-only by construction: it explains a stall and names the fix, it
 * never applies one.
 */
export const STAGES = ["requested", "searching", "downloading", "importing", "available"] as const;
export type FeedStage = (typeof STAGES)[number];
export type FeedKind = "movie" | "tv" | "music" | "book" | "comic" | "audiobook" | "game" | "other";
/** active = moving; stalled = needs a human or more time; done = available. */
export type FeedStatus = "active" | "stalled" | "done";

export interface FeedItem {
  id: string;
  kind: FeedKind;
  title: string;
  subtitle?: string;
  artwork: string | null;
  stage: FeedStage;
  status: FeedStatus;
  /** 0-100, whole number. */
  progress: number;
  etaSeconds: number | null;
  /** Epoch ms the item entered the pipeline; the list is sorted newest first on this. */
  startedAt: number;
  /** Username of whoever requested it; null when unknown, and always null for other people's items seen by a member. */
  requestedBy: string | null;
  source: "arr" | "torrent" | "slskd" | "job";
  stall?: { reason: string; fix: string; detail?: string };
  /** Admin only: the page holding the underlying detail. */
  href?: string;
}

export interface FeedRequest {
  service: ArrFlavor;
  /** The *arr's library id for the requested title. */
  id: number;
  title: string;
  by: string | null;
  at: number;
  /** An automatic search has been started (or the add itself searched). */
  searched: boolean;
}

export interface FeedJob {
  id: string;
  status: string;
  sourcePath: string;
  libraryKey: string | null;
  lastError: string | null;
  createdAt: number;
}

export interface FeedInput {
  now: number;
  requests: FeedRequest[];
  queue: ArrQueueItem[];
  /** Keyed `service:id`. Absent = the *arr could not be asked. */
  library: Map<string, ArrLibraryEntry>;
  torrents: QbTorrent[];
  slskd: Array<{ username: string; files: Array<{ filename: string; state: string; percentComplete: number }> }>;
  jobs: FeedJob[];
  /** Intake library key -> its kind (books, manga, comics, music). */
  libraryKinds: Map<string, string>;
  /** Pipeline health; only used to give an admin the real cause of a stall. */
  checks: PipelineCheck[];
}

export interface Viewer { username: string; isAdmin: boolean }

const KIND_OF: Record<ArrFlavor, FeedKind> = { radarr: "movie", sonarr: "tv", lidarr: "music" };
const NAME: Record<ArrFlavor, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };
const ARR_CATEGORIES = new Set<string>(["radarr", "sonarr", "lidarr"]);

/** A search that has found nothing for this long is worth a human's attention. */
export const SEARCH_STALL_MS = 6 * 60 * 60 * 1000;
/** An admin add with no search started after this long was probably forgotten. */
export const UNSEARCHED_STALL_MS = 15 * 60 * 1000;
/** qBittorrent reports "no ETA" as 100 days of seconds. */
const NO_ETA = 8640000;
/** A torrent must be quiet this long before "stalled" is called a stall rather than a blip. */
const TORRENT_STALL_MS = 30 * 60 * 1000;
const RECENT_UNMATCHED_MS = 7 * 24 * 60 * 60 * 1000;

export const libraryKey = (service: ArrFlavor, id: number) => `${service}:${id}`;

const pct = (fraction: number) => Math.max(0, Math.min(100, Math.round(fraction * 100)));

/* ---------------------------------------------------------------- stalls */

interface Stall { reason: string; fix: string; detail?: string }

/** What the *arr said, turned into what it means. The raw text rides along as `detail`. */
function explainImportFailure(item: ArrQueueItem, name: string): Stall {
  const raw = item.errorMessage ?? item.statusMessages[0] ?? item.trackedDownloadState ?? "";
  const text = [item.errorMessage, ...item.statusMessages].filter(Boolean).join(" ");
  const detail = raw || undefined;
  const queue = `Open Transfers; it is listed under Needs attention with the reason.`;
  if (/no files found are eligible|no video files|sample/i.test(text)) {
    return {
      reason: "The download finished, but there was nothing in it that could be imported (often a sample, an archive, or the wrong release).",
      fix: `${queue} Remove its row in the Transfers list and tick "Don't grab this release again (blocklist it)" so ${name} grabs a different one.`, detail,
    };
  }
  if (/unable to parse|unknown (movie|series|artist)|couldn't be matched|not matched|unable to identify|matched to/i.test(text)) {
    return {
      reason: `${name} could not tell which title this download belongs to.`,
      fix: `${queue} Point it at the right title on ${name}'s own Activity page, or remove its row on Transfers and blocklist the release.`, detail,
    };
  }
  if (/does not exist|not accessible|permission|access (is )?denied|no such file|directory/i.test(text)) {
    return {
      reason: `${name} cannot reach the downloaded files; the download folder is probably not shared with it.`,
      fix: `Open Transfers and read Needs attention, which says which folder ${name} cannot see and how to mount it.`, detail,
    };
  }
  if (/not an upgrade|already (have|imported)|existing file|exists/i.test(text)) {
    return {
      reason: `${name} already has this, or something at least as good, so it declined the import.`,
      fix: `Nothing is lost. Remove its row on Transfers, or replace the existing file from ${name}'s own Activity page.`, detail,
    };
  }
  return {
    reason: `${name} downloaded it but refused to import it.`,
    fix: `${queue} Fix the cause, then press Retry import there, or remove its row and blocklist the release.`, detail,
  };
}

/** The first failing pipeline check that concerns this *arr (or the download client), most severe first. */
function pipelineCause(service: ArrFlavor, checks: PipelineCheck[]): PipelineCheck | undefined {
  const mine = checks.filter((c) => !c.ok && c.severity === "error" && !!c.fix
    && (c.id.startsWith(`${service}-`) || c.id === "qb-reachable" || c.id === `qb-category-${service}`)
    && c.id !== `${service}-stuck-imports`);
  return mine[0];
}

/** For members: the same fact with no paths, hostnames or tool names to act on. */
const MEMBER_FIX = "Nothing for you to do. The admin can see why and sort it out.";

function forViewer(stall: Stall, isAdmin: boolean, memberReason?: string): Stall {
  if (isAdmin) return stall;
  return { reason: memberReason ?? stall.reason, fix: MEMBER_FIX };
}

/* ------------------------------------------------------------ queue group */

interface Resolved {
  stage: FeedStage;
  status: FeedStatus;
  progress: number;
  etaSeconds: number | null;
  stall?: Stall;
  href?: string;
}

function resolveQueue(
  group: ArrQueueItem[], torrents: Map<string, QbTorrent>, input: FeedInput,
): Resolved {
  const service = group[0]!.service;
  const name = NAME[service];
  const classified = group.map((item) => classifyQueueItem(item, torrents.get(item.downloadId?.toLowerCase() ?? ""), input, name));

  const total = group.reduce((n, i) => n + i.size, 0);
  const left = group.reduce((n, i) => n + i.sizeleft, 0);
  const progress = total > 0 ? pct((total - left) / total) : 0;
  const etas = classified.map((c) => c.eta).filter((n): n is number => n != null);
  const etaSeconds = etas.length ? Math.max(...etas) : null;

  // A stalled member of a group (one bad episode in a season pack) stalls the item.
  const stalled = classified.find((c) => c.stall);
  const downloading = classified.some((c) => c.stage === "downloading");
  const stage: FeedStage = stalled ? stalled.stage : downloading ? "downloading" : "importing";
  const allDone = classified.every((c) => c.stage === "importing");
  return {
    stage,
    status: stalled ? "stalled" : "active",
    progress: allDone && !stalled ? Math.max(progress, 100) : progress,
    etaSeconds: stage === "importing" ? null : etaSeconds,
    stall: stalled?.stall,
    href: "/transfers",
  };
}

function classifyQueueItem(
  item: ArrQueueItem, torrent: QbTorrent | undefined, input: FeedInput, name: string,
): { stage: FeedStage; eta: number | null; stall?: Stall } {
  const state = (item.trackedDownloadState ?? "").toLowerCase();
  const status = (item.status ?? "").toLowerCase();
  const tstatus = (item.trackedDownloadStatus ?? "").toLowerCase();
  const startedAt = item.added ? Date.parse(item.added) : torrent?.addedOn ? torrent.addedOn * 1000 : NaN;
  const cause = pipelineCause(item.service, input.checks);
  const detail = item.errorMessage ?? item.statusMessages[0];
  const eta = torrent && torrent.progress < 1 && torrent.eta > 0 && torrent.eta < NO_ETA ? torrent.eta : null;

  // Radarr/Sonarr/Lidarr gave up on it.
  if (state === "failed" || state === "failedpending") {
    return { stage: "downloading", eta, stall: {
      reason: `The download failed${detail ? "" : " and was not completed"}.`,
      fix: `Open Transfers and remove it with "blocklist" ticked so ${name} searches for a different release.`, detail,
    } };
  }
  if (status === "downloadclientunavailable") {
    const stall = cause
      ? { reason: cause.detail, fix: cause.fix! }
      : { reason: `${name} cannot reach the download client.`, fix: "Check qBittorrent is running and its connection on the Services page." };
    return { stage: "downloading", eta, stall };
  }

  // Downloaded, waiting on or failing the import.
  if (needsManualImport(item)) {
    const base = explainImportFailure(item, name);
    return { stage: "importing", eta: null, stall: cause ? { ...base, reason: cause.detail, fix: cause.fix!, detail: base.detail } : base };
  }
  if (state === "importpending" || state === "importing" || state === "imported") {
    const stuck = state === "importpending" && Number.isFinite(startedAt) && input.now - startedAt > STUCK_IMPORT_MS;
    if (!stuck) return { stage: "importing", eta: null };
    return { stage: "importing", eta: null, stall: cause
      ? { reason: cause.detail, fix: cause.fix! }
      : { reason: `${name} has had this waiting to import for over an hour.`,
          fix: "Open Transfers: Needs attention says why, and Retry import asks the app to try again." } };
  }

  // Still downloading: let the download client say if it is going nowhere.
  if (torrent) {
    const tstate = torrent.state;
    if (tstate === "error" || tstate === "missingFiles") {
      return { stage: "downloading", eta, stall: {
        reason: "qBittorrent hit an error with this download (usually a full disk or missing files).",
        fix: "Open Transfers, check free space and the torrent's state, then resume it, or remove it and add the title again.",
      } };
    }
    if (tstate === "pausedDL" || tstate === "stoppedDL") {
      return { stage: "downloading", eta, stall: { reason: "This download is paused.", fix: "Open Transfers and resume it." } };
    }
    if (tstate === "stalledDL" && Number.isFinite(startedAt) && input.now - startedAt > TORRENT_STALL_MS) {
      return { stage: "downloading", eta, stall: {
        reason: "Nobody is sharing this one right now, so it is not moving.",
        fix: `Give it time, or open Transfers and remove it with "blocklist" ticked so ${name} picks another release.`,
      } };
    }
  }
  if (status === "paused") {
    return { stage: "downloading", eta, stall: { reason: "This download is paused.", fix: "Open Transfers and resume it." } };
  }
  if (tstatus === "warning" || tstatus === "error") {
    return { stage: "downloading", eta, stall: {
      reason: `${name} flagged a problem with this download.`,
      fix: "Open Transfers to read the message; remove and blocklist the release if it is not recovering.", detail,
    } };
  }
  return { stage: "downloading", eta };
}

/* ------------------------------------------------------------------ build */

export function buildFeed(input: FeedInput, viewer: Viewer): FeedItem[] {
  const { now } = input;
  const items = new Map<string, FeedItem>();
  const torrentByHash = new Map(input.torrents.map((t) => [t.hash.toLowerCase(), t]));

  // 1. Requests, newest per title.
  const requests = new Map<string, FeedRequest>();
  for (const r of [...input.requests].sort((a, b) => a.at - b.at)) requests.set(libraryKey(r.service, r.id), r);

  // 2. The *arr queue, grouped per library entry (a season pack is many records).
  const groups = new Map<string, ArrQueueItem[]>();
  for (const q of input.queue) {
    const key = q.libraryId != null ? libraryKey(q.service, q.libraryId) : `queue:${q.service}:${q.id}`;
    groups.set(key, [...(groups.get(key) ?? []), q]);
  }

  const claimedHashes = new Set<string>();
  for (const [key, group] of groups) {
    const req = requests.get(key);
    const first = group[0]!;
    for (const q of group) if (q.downloadId) claimedHashes.add(q.downloadId.toLowerCase());
    const r = resolveQueue(group, torrentByHash, input);
    const addedAt = Math.min(...group.map((q) => (q.added ? Date.parse(q.added) : NaN)).filter(Number.isFinite), Infinity);
    items.set(key, {
      id: key,
      kind: KIND_OF[first.service],
      title: req?.title ?? first.mediaTitle ?? first.title,
      subtitle: req ? undefined : first.mediaTitle && first.title !== first.mediaTitle ? first.title : undefined,
      artwork: first.poster ?? input.library.get(key)?.poster ?? null,
      stage: r.stage, status: r.status, progress: r.progress, etaSeconds: r.etaSeconds,
      startedAt: req?.at ?? (Number.isFinite(addedAt) ? addedAt : now),
      requestedBy: req?.by ?? null,
      source: "arr",
      stall: r.stall ? forViewer(r.stall, viewer.isAdmin, memberStallReason(r.stage)) : undefined,
      href: r.href,
    });
  }

  // 3. Requests that are not (or no longer) in a queue: searching, or already here.
  for (const [key, req] of requests) {
    if (items.has(key)) continue;
    const lib = input.library.get(key);
    const base = {
      id: key, kind: KIND_OF[req.service], title: req.title, artwork: lib?.poster ?? null,
      startedAt: req.at, requestedBy: req.by, source: "arr" as const, etaSeconds: null, href: "/transfers",
    };
    if (lib && lib.fileCount > 0) {
      items.set(key, { ...base, stage: "available", status: "done", progress: 100 });
      continue;
    }
    const age = now - req.at;
    const name = NAME[req.service];
    let stall: Stall | undefined;
    const cause = pipelineCause(req.service, input.checks);
    if (!req.searched) {
      if (age > UNSEARCHED_STALL_MS) {
        stall = { reason: `It was added to ${name} but nothing ever started looking for it.`,
          fix: "Find it in Search and use Add again, or Options > Choose release to pick a release yourself." };
      }
    } else if (age > SEARCH_STALL_MS) {
      stall = cause
        ? { reason: cause.detail, fix: cause.fix! }
        : { reason: `${name} has searched for hours and found no release it is willing to take.`,
            fix: "Find it in Search and use Options > Choose release to pick one by hand, or check your indexers in Prowlarr." };
    }
    items.set(key, {
      ...base, stage: req.searched ? "searching" : "requested", status: stall ? "stalled" : "active", progress: 0,
      stall: stall ? forViewer(stall, viewer.isAdmin, memberStallReason(req.searched ? "searching" : "requested")) : undefined,
    });
  }

  // 4. Admin-only extras: raw downloads and intake jobs the *arr know nothing about.
  if (viewer.isAdmin) {
    for (const t of input.torrents) {
      if (claimedHashes.has(t.hash.toLowerCase())) continue;
      const done = t.progress >= 1;
      const startedAt = t.addedOn * 1000;
      if (done && (ARR_CATEGORIES.has(t.category) || now - startedAt > RECENT_UNMATCHED_MS)) continue;
      const stalled = t.state === "error" || t.state === "missingFiles";
      items.set(`torrent:${t.hash.toLowerCase()}`, {
        id: `torrent:${t.hash.toLowerCase()}`,
        kind: t.category === "torhq-games" ? "game" : "other",
        title: t.name, artwork: null,
        stage: done ? "available" : "downloading",
        status: stalled ? "stalled" : done ? "done" : "active",
        progress: pct(t.progress),
        etaSeconds: !done && t.eta > 0 && t.eta < NO_ETA ? t.eta : null,
        startedAt, requestedBy: null, source: "torrent",
        stall: stalled ? { reason: "qBittorrent hit an error with this download (usually a full disk or missing files).",
          fix: "Open Transfers, check free space and the torrent's state, then resume it, or remove it and add the title again." } : undefined,
        href: "/transfers",
      });
    }
    for (const u of input.slskd) {
      const open = u.files.filter((f) => !/^completed/i.test(f.state));
      const failed = u.files.filter((f) => /errored|cancelled|rejected|timedout/i.test(f.state));
      if (open.length === 0 && failed.length === 0) continue;
      const progress = u.files.length ? pct(u.files.reduce((n, f) => n + (f.percentComplete || 0), 0) / u.files.length / 100) : 0;
      const stalled = failed.length > 0 && failed.length === u.files.length;
      items.set(`slskd:${u.username}`, {
        id: `slskd:${u.username}`, kind: "music", title: `Soulseek: ${u.username}`,
        subtitle: `${u.files.length} file${u.files.length === 1 ? "" : "s"}`, artwork: null,
        stage: "downloading", status: stalled ? "stalled" : "active", progress, etaSeconds: null,
        startedAt: now, requestedBy: null, source: "slskd",
        stall: stalled ? { reason: "Every file from this Soulseek user failed or was refused.",
          fix: "Nothing on TorHQ can retry it; remove the album and add it again from Search so a different source is tried." } : undefined,
        href: "/transfers",
      });
    }
    for (const j of input.jobs) {
      const k = input.libraryKinds.get(j.libraryKey ?? "") ?? "";
      const status = j.status === "completed" ? "done" : j.status === "failed" || j.status === "dead" ? "stalled" : "active";
      items.set(`job:${j.id}`, {
        id: `job:${j.id}`,
        kind: k === "music" ? "music" : k === "manga" || k === "comics" ? "comic" : k === "books" ? "book" : "other",
        title: j.sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? j.sourcePath,
        artwork: null, stage: status === "done" ? "available" : "importing", status,
        progress: status === "done" ? 100 : 0, etaSeconds: null, startedAt: j.createdAt, requestedBy: null, source: "job",
        stall: status === "stalled" ? {
          reason: j.status === "dead" ? "The import was tried several times and given up on." : "The import failed.",
          fix: "Open History, read the error, fix it, then retry the job.", detail: j.lastError ?? undefined,
        } : undefined,
        href: "/history",
      });
    }
  }

  return finish([...items.values()], viewer);
}

/** The member-facing wording for a stall that carries no operational detail. */
function memberStallReason(stage: FeedStage): string {
  switch (stage) {
    case "requested": return "This has not started yet.";
    case "searching": return "Still looking for a good copy; it is taking longer than usual.";
    case "downloading": return "The download is stuck or paused.";
    default: return "It downloaded but has not been filed yet.";
  }
}

/** Visibility, then ordering. The only place a member's view is decided. */
function finish(all: FeedItem[], viewer: Viewer): FeedItem[] {
  const out = viewer.isAdmin ? all : all
    // Their own requests in full; other people's only while they are in flight, as generic progress.
    .filter((i) => i.requestedBy === viewer.username || (i.source === "arr" && i.status !== "done"))
    .map((i): FeedItem => {
      const own = i.requestedBy === viewer.username;
      const { href: _href, ...rest } = i;
      return { ...rest, requestedBy: own ? i.requestedBy : null,
        stall: i.stall && own ? { reason: i.stall.reason, fix: i.stall.fix } : i.stall ? { reason: "Taking longer than usual.", fix: MEMBER_FIX } : undefined };
    });
  return out.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)).slice(0, 200);
}
