/**
 * Transfers — what qBittorrent, Soulseek and the Radarr/Sonarr/Lidarr queues
 * are doing right now, in one table (it replaces the old Downloads and Queue
 * pages). An *arr queue item and the torrent behind it are one row. Each row
 * links to its item in Activity.
 *
 * Problems that stop an import (pipeline checks that fail, downloads an *arr
 * refused) sit above the table, and only when there are any. Every action is
 * a request to qBittorrent or to the owning *arr: TorHQ moves and renames
 * nothing here.
 */
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { bytes, eta as fmtEta, percent, plural } from "../lib/format.js";
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, PageHeader,
  ProgressBar, RefreshButton, Skeleton, TableWrap, cx, type Tone,
} from "../components/ui.js";
import { Icon } from "../components/Icon.js";

type ArrFlavor = "radarr" | "sonarr" | "lidarr";

export interface Torrent {
  hash: string; name: string; category: string; state: string; progress: number;
  dlspeed: number; size: number; eta: number; addedOn: number;
}
interface DownloadsResponse { torrents: Torrent[] }
export interface QueueItem {
  service: ArrFlavor; id: number; title: string; status: string;
  trackedDownloadStatus?: string; trackedDownloadState?: string; errorMessage?: string;
  statusMessages: string[]; size: number; sizeleft: number; downloadId?: string;
  libraryId?: number; mediaTitle?: string;
}
interface Unavailable { service: string; detail: string }
interface QueueResponse { items: QueueItem[]; unavailable: Unavailable[] }
export interface SlskdUser { username: string; files: Array<{ filename: string; state: string; percentComplete: number }> }
interface SlskdResponse { downloads: SlskdUser[] }
interface PipelineCheck { id: string; label: string; ok: boolean; severity: "error" | "warn" | "info"; detail: string; fix?: string }
interface FailedImport { service: ArrFlavor; id: number; title: string; reason: string; downloadId?: string }

const ARR_LABEL: Record<ArrFlavor, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };
const NO_ETA = 8640000; // qBittorrent's "infinity"

/** qBittorrent's state names, in words. */
export const TORRENT_STATE: Record<string, { tone: Tone; label: string }> = {
  downloading: { tone: "accent", label: "Downloading" }, forcedDL: { tone: "accent", label: "Downloading" },
  metaDL: { tone: "accent", label: "Starting" }, stalledDL: { tone: "warn", label: "Waiting for peers" },
  queuedDL: { tone: "neutral", label: "Queued" }, allocating: { tone: "neutral", label: "Preparing" },
  checkingDL: { tone: "info", label: "Checking" }, checkingUP: { tone: "info", label: "Checking" },
  checkingResumeData: { tone: "info", label: "Checking" },
  uploading: { tone: "ok", label: "Done, sharing" }, forcedUP: { tone: "ok", label: "Done, sharing" },
  stalledUP: { tone: "ok", label: "Done" }, queuedUP: { tone: "ok", label: "Done" },
  pausedDL: { tone: "neutral", label: "Paused" }, stoppedDL: { tone: "neutral", label: "Paused" },
  pausedUP: { tone: "ok", label: "Done" }, stoppedUP: { tone: "ok", label: "Done" },
  moving: { tone: "info", label: "Moving" }, error: { tone: "err", label: "Error" },
  missingFiles: { tone: "err", label: "Files missing" },
};
const isPaused = (s: string) => s.startsWith("paused") || s.startsWith("stopped");

/** The *arr's queue state, in words. */
function arrStatus(q: QueueItem): { tone: Tone; label: string } {
  const state = (q.trackedDownloadState ?? "").toLowerCase();
  const bad = q.trackedDownloadStatus === "error" || !!q.errorMessage;
  const warn = q.trackedDownloadStatus === "warning";
  if (state === "importblocked") return { tone: "err", label: "Can't import" };
  if (state === "failed" || state === "failedpending") return { tone: "err", label: "Failed" };
  if (state === "importpending") return { tone: warn || bad ? "warn" : "info", label: "Waiting to import" };
  if (state === "importing") return { tone: "info", label: "Importing" };
  if (state === "imported") return { tone: "ok", label: "Imported" };
  if (bad) return { tone: "err", label: "Problem" };
  if (warn) return { tone: "warn", label: "Downloading, with a warning" };
  return { tone: "accent", label: "Downloading" };
}

export interface TransferRow {
  key: string;
  name: string;
  detail?: string;
  from: string;
  status: { tone: Tone; label: string };
  progress: number;
  size: number | null;
  etaSeconds: number | null;
  notes: string[];
  torrent?: Torrent;
  queue?: QueueItem;
  /** The matching item id on the Activity page. */
  activityId: string;
}

/** Merge the three sources into one list: an *arr queue item absorbs its own torrent. */
export function buildRows(torrents: Torrent[], queue: QueueItem[], slskd: SlskdUser[]): TransferRow[] {
  const byHash = new Map(torrents.map((t) => [t.hash.toLowerCase(), t]));
  const claimed = new Set<string>();
  const rows: TransferRow[] = [];
  for (const q of queue) {
    const t = q.downloadId ? byHash.get(q.downloadId.toLowerCase()) : undefined;
    if (t) claimed.add(t.hash.toLowerCase());
    rows.push({
      key: `queue:${q.service}:${q.id}`,
      name: q.mediaTitle ?? q.title,
      detail: q.mediaTitle && q.mediaTitle !== q.title ? q.title : undefined,
      from: t ? `${ARR_LABEL[q.service]} via qBittorrent` : ARR_LABEL[q.service],
      status: arrStatus(q),
      progress: q.size > 0 ? 1 - q.sizeleft / q.size : t?.progress ?? 0,
      size: q.size || t?.size || null,
      etaSeconds: t && t.progress < 1 && t.eta > 0 && t.eta < NO_ETA ? t.eta : null,
      notes: [q.errorMessage, ...q.statusMessages].filter((m): m is string => !!m),
      torrent: t, queue: q,
      activityId: q.libraryId != null ? `${q.service}:${q.libraryId}` : `queue:${q.service}:${q.id}`,
    });
  }
  for (const t of torrents) {
    if (claimed.has(t.hash.toLowerCase())) continue;
    rows.push({
      key: `torrent:${t.hash}`,
      name: t.name,
      from: "qBittorrent",
      status: TORRENT_STATE[t.state] ?? { tone: "neutral", label: t.state },
      progress: t.progress,
      size: t.size,
      etaSeconds: t.progress < 1 && t.eta > 0 && t.eta < NO_ETA ? t.eta : null,
      notes: [], torrent: t,
      activityId: `torrent:${t.hash.toLowerCase()}`,
    });
  }
  for (const u of slskd) {
    if (u.files.length === 0) continue;
    const failed = u.files.filter((f) => /errored|cancelled|rejected|timedout/i.test(f.state));
    const done = u.files.filter((f) => /^completed, ?succeeded/i.test(f.state) || f.state === "Completed");
    const name = u.files[0]!.filename.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? u.files[0]!.filename;
    rows.push({
      key: `slskd:${u.username}`,
      name,
      detail: `${plural(u.files.length, "file")} from ${u.username}`,
      from: "Soulseek",
      status: failed.length === u.files.length ? { tone: "err", label: "Failed" }
        : done.length === u.files.length ? { tone: "ok", label: "Done" }
        : failed.length ? { tone: "warn", label: `Downloading, ${failed.length} failed` } : { tone: "accent", label: "Downloading" },
      progress: u.files.reduce((n, f) => n + (f.percentComplete || 0), 0) / u.files.length / 100,
      size: null, etaSeconds: null,
      notes: failed.map((f) => `${f.filename}: ${f.state}`),
      activityId: `slskd:${u.username}`,
    });
  }
  return rows;
}

export function Transfers() {
  const downloads = usePolled<DownloadsResponse>("/api/downloads", 5000);
  const queue = usePolled<QueueResponse>("/api/queue", 10000);
  const slskd = usePolled<SlskdResponse>("/api/status/slskd", 15000);
  const checks = usePolled<{ checks: PipelineCheck[] }>("/api/pipeline/check", 60000);
  const failed = usePolled<{ items: FailedImport[] }>("/api/pipeline/failed-imports", 30000);

  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TransferRow | null>(null);
  const [alsoClient, setAlsoClient] = useState(true);
  const [blocklist, setBlocklist] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);

  const act = useMutation(
    (action: "pause" | "resume" | "delete" | "deleteWithFiles", hashes: string[]) =>
      apiSend<{ ok: true }>("/api/downloads/action", "POST", { action, hashes }),
    { invalidates: ["/api/downloads", "/api/queue"] },
  );
  const removeQueue = useMutation(
    (q: QueueItem, opts: { removeFromClient: boolean; blocklist: boolean }) =>
      apiSend<{ ok: true }>(`/api/queue/${q.service}/${q.id}/remove`, "POST", opts),
    { invalidates: ["/api/queue", "/api/downloads", "/api/pipeline"] },
  );
  const poll = useMutation(
    () => apiSend<{ refreshed: string[]; unavailable: Unavailable[] }>("/api/queue/refresh", "POST"),
    { invalidates: ["/api/queue", "/api/pipeline"] },
  );
  const reimport = useMutation(
    (f: { service: ArrFlavor; downloadId: string }) => apiSend("/api/pipeline/manual-import", "POST", f),
    { invalidates: ["/api/queue", "/api/pipeline"] },
  );

  const rows = useMemo(
    () => buildRows(downloads.data?.torrents ?? [], queue.data?.items ?? [], slskd.data?.downloads ?? []),
    [downloads.data, queue.data, slskd.data],
  );
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => `${r.name} ${r.detail ?? ""}`.toLowerCase().includes(needle)) : rows;
  const loading = downloads.initial && queue.initial && slskd.initial;

  // A source that is not set up is normal (409) and only worth a quiet line; one that failed is a warning.
  const sourceNotes: Array<{ name: string; detail: string; configured: boolean }> = [];
  if (downloads.error) sourceNotes.push({ name: "qBittorrent", detail: downloads.error.message, configured: downloads.error.status !== 409 });
  if (slskd.error) sourceNotes.push({ name: "Soulseek (slskd)", detail: slskd.error.message, configured: slskd.error.status !== 409 });
  for (const u of queue.data?.unavailable ?? []) {
    sourceNotes.push({ name: ARR_LABEL[u.service as ArrFlavor] ?? u.service, detail: u.detail, configured: u.detail !== "not configured" });
  }
  const broken = sourceNotes.filter((s) => s.configured);
  const unset = sourceNotes.filter((s) => !s.configured);

  // An app that simply isn't set up is already in the quiet note under the table, not a problem.
  const problems = (checks.data?.checks ?? []).filter((c) => !c.ok && c.severity !== "info" && !/is not configured in TorHQ/.test(c.detail));
  const failedItems = failed.data?.items ?? [];

  async function confirmRemove() {
    if (!removing) return;
    if (removing.queue) {
      const r = await removeQueue.run(removing.queue, { removeFromClient: alsoClient, blocklist });
      if (r.ok) setRemoving(null);
      return;
    }
    if (removing.torrent) {
      const r = await act.run(deleteFiles ? "deleteWithFiles" : "delete", [removing.torrent.hash]);
      if (r.ok) setRemoving(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Transfers"
        subtitle="What qBittorrent, Soulseek, Radarr, Sonarr and Lidarr are downloading or importing right now; each row links to its item in Activity."
        actions={
          <>
            <Button icon="refresh" pending={poll.pending} onClick={() => void poll.run()}
              title="Ask Radarr, Sonarr and Lidarr to check for finished downloads now, instead of waiting for their own timer">
              Check for finished downloads
            </Button>
            <RefreshButton q={downloads} />
          </>
        }
      />

      {poll.error && <Alert tone="err" title="Couldn't ask the apps to check">{poll.error}</Alert>}
      {act.error && <Alert tone="err" title="That didn't work">{act.error}</Alert>}

      {(problems.length > 0 || failedItems.length > 0) && (
        <Card title="Needs attention" icon="alert" subtitle="Things that will stop a finished download from reaching the library.">
          {reimport.error && <Alert tone="err" title="Retry failed">{reimport.error}</Alert>}
          <div className="list">
            {problems.map((c) => (
              <div key={c.id} className="list-row">
                <Badge tone={c.severity === "error" ? "err" : c.severity === "warn" ? "warn" : "info"}>{c.severity === "error" ? "Broken" : "Check"}</Badge>
                <div className="grow">
                  <div>{c.label}</div>
                  <div className="small muted">{c.detail}</div>
                  {c.fix && <div className="small mt-2"><span className="dim">What to do: </span>{c.fix}</div>}
                </div>
              </div>
            ))}
            {failedItems.map((f) => (
              <div key={`${f.service}-${f.id}`} className="list-row">
                <Badge tone="err">Not imported</Badge>
                <div className="grow">
                  <div className="break">{f.title}</div>
                  <div className="small muted">{ARR_LABEL[f.service]} refused it: {f.reason}</div>
                </div>
                <Button size="sm" icon="refresh" disabled={!f.downloadId} pending={reimport.pending}
                  title={`Ask ${ARR_LABEL[f.service]} to try importing this download again`}
                  onClick={() => void reimport.run({ service: f.service, downloadId: f.downloadId! })}>
                  Retry import
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {broken.length > 0 && (
        <Alert tone="warn" title="Some apps did not answer">
          {broken.map((s) => `${s.name}: ${s.detail}`).join(" · ")}. The rows below are from the apps that did.
        </Alert>
      )}

      <Card flush>
        <div className="toolbar">
          <div className="searchbar">
            <Icon name="search" size={14} />
            <input className="input" placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter transfers by name" />
          </div>
          <span className="muted small">{plural(shown.length, "transfer")}</span>
        </div>
        {loading ? (
          <div className="card-body"><Skeleton rows={4} /></div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon="download"
            title={rows.length ? "Nothing matches that filter" : "Nothing is transferring"}
            message={rows.length ? "Clear the filter to see everything." : "When something is downloading or waiting to be imported it shows up here."}
          />
        ) : (
          <TableWrap>
            <table className="table" aria-label="Transfers">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>From</th>
                  <th>Status</th>
                  <th style={{ minWidth: 130 }}>Progress</th>
                  <th className="num">Size</th>
                  <th className="num">Time left</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const open = expanded === r.key;
                  const t = r.torrent;
                  return (
                    <Fragment key={r.key}>
                      <tr data-source={r.queue ? "arr" : t ? "torrent" : "slskd"}>
                        <td style={{ maxWidth: 380 }}>
                          <Link className="truncate" style={{ display: "block" }} title={`${r.name} — open in Activity`} to={`/activity?item=${encodeURIComponent(r.activityId)}`}>{r.name}</Link>
                          {r.detail && <div className="truncate dim xs" title={r.detail}>{r.detail}</div>}
                        </td>
                        <td className="nowrap small">{r.from}</td>
                        <td className="nowrap"><Badge tone={r.status.tone}>{r.status.label}</Badge></td>
                        <td>
                          <div className="progress-label">
                            <ProgressBar value={r.progress} tone={r.status.tone === "err" ? "err" : r.progress >= 1 ? "ok" : undefined} />
                            <span className="small dim">{percent(r.progress)}</span>
                          </div>
                        </td>
                        <td className="num">{r.size ? bytes(r.size) : "—"}</td>
                        <td className="num dim">{r.etaSeconds ? fmtEta(r.etaSeconds) : "—"}</td>
                        <td className="shrink row-nowrap">
                          {r.notes.length > 0 && (
                            <Button size="sm" variant="ghost" icon={open ? "up" : "down"} aria-expanded={open}
                              aria-label={open ? "Hide messages" : "Show messages"} onClick={() => setExpanded(open ? null : r.key)} />
                          )}
                          {t && t.progress < 1 && (
                            isPaused(t.state)
                              ? <Button size="sm" icon="play" aria-label={`Resume ${r.name}`} title="Resume" pending={act.pending} onClick={() => void act.run("resume", [t.hash])} />
                              : <Button size="sm" icon="pause" aria-label={`Pause ${r.name}`} title="Pause" pending={act.pending} onClick={() => void act.run("pause", [t.hash])} />
                          )}
                          {(r.queue || t) && (
                            <Button size="sm" variant="danger" icon="trash" aria-label={`Remove ${r.name}`} title="Remove"
                              onClick={() => { setAlsoClient(true); setBlocklist(false); setDeleteFiles(false); removeQueue.reset(); act.reset(); setRemoving(r); }} />
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="selected">
                          <td colSpan={7}>
                            <ul className="muted small" style={{ margin: 0, paddingLeft: "1.2em" }}>
                              {r.notes.map((m, i) => <li key={i} className="break">{m}</li>)}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {unset.length > 0 && (
        <p className={cx("small", "muted", "mt-3")}>
          Not set up, so not shown: {unset.map((s) => s.name).join(", ")}. Add them on <Link to="/services">Services</Link>.
        </p>
      )}

      {removing && (
        <ConfirmDialog
          title={removing.queue ? `Remove from ${ARR_LABEL[removing.queue.service]}?` : "Remove from qBittorrent?"}
          confirmLabel={deleteFiles ? "Remove and delete files" : "Remove"}
          requireText={!removing.queue && deleteFiles ? "DELETE" : undefined}
          pending={removeQueue.pending || act.pending}
          error={removeQueue.error ?? act.error}
          onClose={() => setRemoving(null)}
          onConfirm={() => void confirmRemove()}
          body={
            <>
              <p className="break"><strong>{removing.name}</strong></p>
              {removing.queue ? (
                <>
                  {removing.torrent && <Checkbox label="Also remove the download from qBittorrent" checked={alsoClient} onChange={setAlsoClient} />}
                  <Checkbox label="Don't grab this release again (blocklist it)" checked={blocklist} onChange={setBlocklist} />
                  <p className="muted small">Downloaded files stay on disk either way.</p>
                </>
              ) : (
                <>
                  <Checkbox label="Also delete the downloaded files" checked={deleteFiles} onChange={setDeleteFiles} />
                  <p className="muted small">{deleteFiles ? "The files are deleted from disk. This can't be undone." : "The files stay on disk."}</p>
                </>
              )}
            </>
          }
        />
      )}
    </>
  );
}
