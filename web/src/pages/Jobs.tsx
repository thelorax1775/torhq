/**
 * Jobs & activity — TorHQ's own manual-intake worker, not the *arr.
 *
 * Consumes `GET /api/jobs` (the durable job queue), `POST /api/jobs/:id/retry`,
 * and `GET /api/activity` (the append-only audit log). A job's own history is
 * fetched on demand via `GET /api/jobs/:id` when its row is expanded, so the
 * list view stays a single cheap request.
 */
import { Fragment, useState } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { ago, plural } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, EmptyState, LinkButton, PageHeader,
  RefreshButton, StaleNotice, Stat, TableWrap, type Tone,
} from "../components/ui.js";

type JobStatus = "queued" | "running" | "completed" | "failed" | "dead";

interface Job {
  id: string;
  status: JobStatus;
  libraryKey: string | null;
  sourcePath: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
}
interface JobsResponse { jobs: Job[] }

interface ActivityEntry {
  id: number;
  jobId: string | null;
  kind: string;
  service: string | null;
  message: string;
  createdAt: number;
}
interface ActivityResponse { activity: ActivityEntry[] }
interface JobDetailResponse { job: Job; activity: ActivityEntry[] }

const STATUS_META: Record<JobStatus, { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "info", label: "Running" },
  completed: { tone: "ok", label: "Completed" },
  failed: { tone: "err", label: "Failed" },
  dead: { tone: "err", label: "Dead" },
};
const statusMeta = (s: JobStatus) => STATUS_META[s] ?? { tone: "neutral" as Tone, label: s };
const canRetry = (s: JobStatus) => s === "dead" || s === "failed";

/** Activity kinds → badge tone. Anything not listed renders as `neutral`. */
const KIND_TONE: Record<string, Tone> = {
  requested: "info", queued: "neutral", downloading: "accent", completed: "ok",
  importing: "info", imported: "ok", failed: "err",
};

export function Jobs() {
  const q = usePolled<JobsResponse>("/api/jobs", 8000);
  const activity = usePolled<ActivityResponse>("/api/activity?limit=100", 15000);

  const [status, setStatus] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = usePolled<JobDetailResponse>(openId ? `/api/jobs/${openId}` : null, 0);

  const retry = useMutation(
    (id: string) => apiSend<{ ok: true; job: Job }>(`/api/jobs/${id}/retry`, "POST"),
    { invalidates: ["/api/jobs", "/api/activity"] },
  );

  const jobs = q.data?.jobs ?? [];
  const visible = status === "all" ? jobs : jobs.filter((j) => j.status === status);
  const counts = {
    running: jobs.filter((j) => j.status === "running").length,
    queued: jobs.filter((j) => j.status === "queued").length,
    dead: jobs.filter((j) => j.status === "dead" || j.status === "failed").length,
  };

  return (
    <>
      <PageHeader
        title="Jobs & activity"
        subtitle="TorHQ's own manual-intake worker (books, manga, music) — not the *arr, which import themselves."
        actions={<RefreshButton q={q} />}
      />

      <Async q={q} what="jobs">
        {(data) => (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="Jobs" value={data.jobs.length} />
              <Stat label="Running" value={counts.running} />
              <Stat label="Queued" value={counts.queued} />
              <Stat label="Dead / failed" value={counts.dead} tone={counts.dead ? "err" : "ok"} />
            </div>

            {retry.error && <Alert tone="err" title="Retry failed">{retry.error}</Alert>}

            <Card flush>
              <div className="toolbar">
                <select className="select input-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" style={{ width: "auto" }}>
                  <option value="all">All statuses</option>
                  {(["queued", "running", "completed", "failed", "dead"] as const).map((s) => (
                    <option key={s} value={s}>{STATUS_META[s].label}</option>
                  ))}
                </select>
                <span className="muted small">{plural(visible.length, "job")}</span>
              </div>

              {visible.length === 0 ? (
                <EmptyState
                  icon="clock"
                  title={jobs.length ? "Nothing matches that filter" : "No jobs yet"}
                  message={jobs.length ? "Clear the filter to see the rest." : "Manual intake jobs queued from the Intake page will show up here."}
                />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Library</th>
                        <th>Source</th>
                        <th>Status</th>
                        <th className="num">Attempts</th>
                        <th className="num">Created</th>
                        <th className="shrink" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((j) => {
                        const meta = statusMeta(j.status);
                        const open = openId === j.id;
                        return (
                          <Fragment key={j.id}>
                            <tr>
                              <td className="nowrap">{j.libraryKey ?? <span className="dim">—</span>}</td>
                              <td style={{ maxWidth: 380 }}>
                                <div className="truncate mono small" title={j.sourcePath}>{j.sourcePath}</div>
                                {j.lastError && <div className="truncate dim xs" title={j.lastError}>{j.lastError}</div>}
                              </td>
                              <td className="nowrap"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                              <td className="num">{j.attempts}/{j.maxAttempts}</td>
                              <td className="num dim">{ago(j.createdAt)}</td>
                              <td className="shrink row-nowrap">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  icon={open ? "up" : "down"}
                                  title={open ? "Hide log" : "Show job log"}
                                  aria-label={open ? `Hide log for ${j.sourcePath}` : `Show log for ${j.sourcePath}`}
                                  aria-expanded={open}
                                  onClick={() => setOpenId(open ? null : j.id)}
                                />
                                {canRetry(j.status) && (
                                  <Button
                                    size="sm"
                                    icon="refresh"
                                    pending={retry.pending}
                                    title="Retry this job"
                                    aria-label={`Retry ${j.sourcePath}`}
                                    onClick={() => void retry.run(j.id)}
                                  >
                                    Retry
                                  </Button>
                                )}
                              </td>
                            </tr>
                            {open && (
                              <tr className="selected">
                                <td colSpan={6}>
                                  <Async q={detail} what="the job log" skeleton={<div className="small muted">Loading…</div>}>
                                    {(d) => (
                                      d.activity.length === 0 ? (
                                        <div className="small muted">No activity recorded for this job yet.</div>
                                      ) : (
                                        <div className="list">
                                          {d.activity.map((a) => (
                                            <div key={a.id} className="list-row">
                                              <Badge tone={KIND_TONE[a.kind] ?? "neutral"}>{a.kind}</Badge>
                                              <div className="grow small break">{a.message}</div>
                                              <span className="small dim nowrap">{ago(a.createdAt)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      )
                                    )}
                                  </Async>
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

            <StaleNotice q={q} />
          </div>
        )}
      </Async>

      <Card title="Recent activity" subtitle="Every job, request and import event TorHQ has logged." icon="activity">
        <Async q={activity} what="activity">
          {(data) => (
            data.activity.length === 0 ? (
              <EmptyState icon="activity" title="Nothing logged yet" />
            ) : (
              <div className="list">
                {data.activity.map((a) => (
                  <div key={a.id} className="list-row">
                    <Badge tone={KIND_TONE[a.kind] ?? "neutral"}>{a.kind}</Badge>
                    <div className="grow small break">{a.message}</div>
                    {a.service === "books" && /ready for approval/i.test(a.message) && (
                      <LinkButton to="/books" size="sm" variant="primary">Approve import</LinkButton>
                    )}
                    {a.service && <span className="small dim">{a.service}</span>}
                    <span className="small dim nowrap">{ago(a.createdAt)}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </Async>
      </Card>
    </>
  );
}
