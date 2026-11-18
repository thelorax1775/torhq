/**
 * Dashboard — the landing page.
 *
 * Answers, in priority order: (1) can a grab actually reach the library —
 * pipeline checks are what silently break imports, so they lead; (2) what is
 * happening right now — transfers and queue depth; (3) is anything broken —
 * service health, storage, failed intake jobs; (4) where to go next.
 *
 * Six independent polled queries, six independent `Async`s: one dead service
 * (an unreachable Lidarr, an unmounted disk) degrades its own card only, it
 * never blanks the rest of the page.
 */
import { usePolled } from "../lib/usePolled.js";
import { bytes, speed, percent, plural } from "../lib/format.js";
import {
  Async, Badge, Button, Card, EmptyState, LinkButton, PageHeader,
  ProgressBar, Stat, StatusDot, type Tone,
} from "../components/ui.js";
import { Icon } from "../components/Icon.js";
import { STATE_META } from "./Downloads.js";

interface PipelineCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: "error" | "warn" | "info";
  detail: string;
}
interface CheckResponse { checks: PipelineCheck[] }
const SEVERITY_TONE: Record<PipelineCheck["severity"], Tone> = { error: "err", warn: "warn", info: "info" };

interface Torrent { hash: string; name: string; state: string; progress: number; dlspeed: number }
interface DownloadsResponse {
  torrents: Torrent[];
  transfer?: { dlspeed?: number; upspeed?: number };
}

type ArrFlavor = "radarr" | "sonarr" | "lidarr";
interface QueueItem {
  service: ArrFlavor;
  id: number;
  title: string;
  trackedDownloadStatus?: string;
  errorMessage?: string;
}
interface Unavailable { service: ArrFlavor; detail: string }
interface QueueResponse { items: QueueItem[]; unavailable: Unavailable[] }
const SERVICE_LABEL: Record<ArrFlavor, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };
const queueItemBroken = (i: QueueItem) => i.trackedDownloadStatus === "error" || i.trackedDownloadStatus === "warning" || !!i.errorMessage;

interface HealthResult { healthy: boolean; version?: string; detail?: string }
interface ServiceSafe { kind: string; label: string }
interface HealthResponse { health: Record<string, HealthResult>; services: ServiceSafe[] }
const KIND_LABEL: Record<string, string> = {
  qbittorrent: "qBittorrent", radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr", prowlarr: "Prowlarr",
  slskd: "slskd", jellyfin: "Jellyfin", navidrome: "Navidrome", kavita: "Kavita", audiobookshelf: "Audiobookshelf",
  torrentsearch: "Torrent search", websearch: "Web search",
};

interface Disk { path: string; totalBytes: number; freeBytes: number }
interface StorageResponse { disks: Disk[] }
/** Used-fraction thresholds for calling out a disk that's actually at risk. */
function diskTone(used: number): "ok" | "warn" | "err" | undefined {
  if (used >= 0.9) return "err";
  if (used >= 0.75) return "warn";
  return undefined;
}

interface FailedJob { id: string; libraryKey: string | null; sourcePath: string; lastError: string | null }
interface FailuresResponse { failed: FailedJob[]; retrying: FailedJob[] }

export function Dashboard() {
  const pipeline = usePolled<CheckResponse>("/api/pipeline/check", 60000);
  const downloads = usePolled<DownloadsResponse>("/api/downloads", 5000);
  const queue = usePolled<QueueResponse>("/api/queue", 10000);
  const health = usePolled<HealthResponse>("/api/status/health", 30000);
  const storage = usePolled<StorageResponse>("/api/status/storage", 60000);
  const failures = usePolled<FailuresResponse>("/api/status/failures", 30000);

  const queries = [pipeline, downloads, queue, health, storage, failures];

  const problems = pipeline.data?.checks.filter((c) => !c.ok) ?? null;
  const activeTorrents = downloads.data?.torrents.filter((t) => !t.state.startsWith("paused") && t.progress < 1) ?? null;
  const queueBroken = queue.data?.items.filter(queueItemBroken) ?? null;
  const failedCount = failures.data ? failures.data.failed.length : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="The *arr stack, qBittorrent and the pipeline between them, in one place."
        actions={
          <Button
            size="sm"
            icon="refresh"
            pending={queries.some((q) => q.loading)}
            onClick={() => queries.forEach((q) => void q.refresh())}
          >
            Refresh
          </Button>
        }
      />

      <div className="stat-grid">
        <Stat
          label="Pipeline"
          value={problems ? plural(problems.length, "issue") : "—"}
          tone={problems ? (problems.length ? "err" : "ok") : undefined}
        />
        <Stat
          label="Active transfers"
          value={activeTorrents ? activeTorrents.length : "—"}
          meta={downloads.data ? speed(downloads.data.transfer?.dlspeed ?? 0) : undefined}
        />
        <Stat
          label="Arr queue"
          value={queue.data ? queue.data.items.length : "—"}
          tone={queueBroken ? (queueBroken.length ? "warn" : "ok") : undefined}
          meta={queueBroken?.length ? `${plural(queueBroken.length, "item")} need attention` : undefined}
        />
        <Stat
          label="Failed jobs"
          value={failedCount ?? "—"}
          tone={failedCount != null ? (failedCount ? "err" : "ok") : undefined}
        />
      </div>

      {/* Priority 1: this is what actually breaks imports, silently. */}
      <Card
        title="Pipeline health"
        subtitle="Can a completed grab actually reach the right *arr, in a directory it can see?"
        icon="shield"
        actions={<LinkButton to="/queue" icon="external" size="sm">Full details</LinkButton>}
      >
        <Async q={pipeline} what="pipeline checks">
          {(data) => {
            const broken = data.checks.filter((c) => !c.ok);
            if (data.checks.length === 0) {
              return (
                <EmptyState
                  icon="shield"
                  title="No checks ran"
                  message="Configure qBittorrent and at least one *arr on the Services page."
                  actions={<LinkButton to="/services" icon="plug" size="sm" variant="primary">Open Services</LinkButton>}
                />
              );
            }
            if (broken.length === 0) {
              return (
                <div className="row ok-text">
                  <Icon name="check" size={16} />
                  <span>All {plural(data.checks.length, "check")} pass — grabs should import cleanly.</span>
                </div>
              );
            }
            return (
              <div className="list">
                {broken.slice(0, 5).map((c) => (
                  <div key={c.id} className="list-row">
                    <Badge tone={SEVERITY_TONE[c.severity]}>{c.severity}</Badge>
                    <div className="grow">
                      <div>{c.label}</div>
                      <div className="small muted">{c.detail}</div>
                    </div>
                  </div>
                ))}
                {broken.length > 5 && (
                  <div className="small muted" style={{ padding: "8px 0 0" }}>
                    …and {broken.length - 5} more on the Queue page.
                  </div>
                )}
              </div>
            );
          }}
        </Async>
      </Card>

      {/* Priority 2: what's actually moving right now. */}
      <div className="grid-2">
        <Card title="Downloads" icon="download" actions={<LinkButton to="/downloads" icon="external" size="sm">Open</LinkButton>}>
          <Async q={downloads} what="qBittorrent data">
            {(data) => {
              const active = data.torrents.filter((t) => !t.state.startsWith("paused") && t.progress < 1);
              return (
                <div className="stack-sm">
                  <div className="row">
                    <span className="row-nowrap"><Icon name="down" size={13} /> {speed(data.transfer?.dlspeed ?? 0)}</span>
                    <span className="row-nowrap"><Icon name="up" size={13} /> {speed(data.transfer?.upspeed ?? 0)}</span>
                    <span className="muted small">{plural(data.torrents.length, "torrent")} total</span>
                  </div>
                  {active.length === 0 ? (
                    <div className="muted small">Nothing downloading right now.</div>
                  ) : (
                    <div className="list">
                      {active.slice(0, 3).map((t) => {
                        const meta = STATE_META[t.state] ?? { tone: "neutral" as Tone, label: t.state };
                        return (
                          <div key={t.hash} className="list-row">
                            <div className="grow">
                              <div className="truncate small" title={t.name}>{t.name}</div>
                              <ProgressBar value={t.progress} />
                            </div>
                            <span className="small dim">{percent(t.progress)}</span>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </div>
                        );
                      })}
                      {active.length > 3 && (
                        <div className="small muted" style={{ padding: "8px 0 0" }}>
                          …and {plural(active.length - 3, "more")}.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            }}
          </Async>
        </Card>

        <Card title="Arr queue" icon="queue" actions={<LinkButton to="/queue" icon="external" size="sm">Open</LinkButton>}>
          <Async q={queue} what="the *arr queue">
            {(data) => {
              const broken = data.items.filter(queueItemBroken);
              return (
                <div className="stack-sm">
                  <div className="row">
                    <span>{plural(data.items.length, "item")} waiting</span>
                    {data.unavailable.length > 0 && (
                      <span className="muted small">
                        Not reachable: {data.unavailable.map((u) => SERVICE_LABEL[u.service]).join(", ")}
                      </span>
                    )}
                  </div>
                  {data.items.length === 0 ? (
                    <div className="muted small">Nothing queued — the *arr have nothing to import.</div>
                  ) : broken.length === 0 ? (
                    <div className="row ok-text small"><Icon name="check" size={14} /><span>Nothing needs attention.</span></div>
                  ) : (
                    <div className="list">
                      {broken.slice(0, 3).map((i) => (
                        <div key={`${i.service}-${i.id}`} className="list-row">
                          <Badge tone="err">{SERVICE_LABEL[i.service]}</Badge>
                          <div className="grow truncate small" title={i.title}>{i.title}</div>
                        </div>
                      ))}
                      {broken.length > 3 && (
                        <div className="small muted" style={{ padding: "8px 0 0" }}>
                          …and {plural(broken.length - 3, "more")}.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            }}
          </Async>
        </Card>
      </div>

      {/* Priority 3: is anything broken. */}
      <div className="grid-3">
        <Card title="Service health" icon="plug" actions={<LinkButton to="/services" icon="external" size="sm">Manage</LinkButton>}>
          <Async q={health} what="service health">
            {(data) => (
              data.services.length === 0 ? (
                <EmptyState icon="plug" title="Nothing configured" message="Add qBittorrent, Prowlarr and the *arr on the Services page." />
              ) : (
                <div className="list">
                  {data.services.map((s) => {
                    const h = data.health[s.kind];
                    return (
                      <div key={s.kind} className="list-row">
                        <StatusDot tone={h?.healthy ? "ok" : "err"} />
                        <div className="grow">{KIND_LABEL[s.kind] ?? s.kind}</div>
                        <span className="small dim truncate" style={{ maxWidth: 160 }}>{h?.healthy ? (h.version ?? "ok") : (h?.detail ?? "unreachable")}</span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </Async>
        </Card>

        <Card title="Storage" icon="server" actions={<LinkButton to="/mounts" icon="external" size="sm">Mounts</LinkButton>}>
          <Async q={storage} what="storage">
            {(data) => (
              data.disks.length === 0 ? (
                <EmptyState icon="server" title="No approved roots readable" message="None of TorHQ's configured roots could be statted — check they're mounted." />
              ) : (
                <div className="stack-sm">
                  {data.disks.map((d) => {
                    const used = d.totalBytes - d.freeBytes;
                    const frac = d.totalBytes ? used / d.totalBytes : 0;
                    return (
                      <div key={d.path}>
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <span className="small truncate mono" title={d.path}>{d.path}</span>
                          <span className="small dim">{bytes(d.freeBytes)} free</span>
                        </div>
                        <ProgressBar value={frac} tone={diskTone(frac)} />
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </Async>
        </Card>

        <Card title="Failed jobs" icon="alert" actions={<LinkButton to="/jobs" icon="external" size="sm">Open</LinkButton>}>
          <Async q={failures} what="job failures">
            {(data) => (
              data.failed.length === 0 ? (
                <div className="row ok-text small"><Icon name="check" size={14} /><span>No failed intake jobs.</span></div>
              ) : (
                <div className="list">
                  {data.failed.slice(0, 4).map((j) => (
                    <div key={j.id} className="list-row">
                      <Badge tone="err">{j.libraryKey ?? "?"}</Badge>
                      <div className="grow truncate small" title={j.lastError ?? undefined}>{j.lastError ?? "unknown error"}</div>
                    </div>
                  ))}
                  {data.retrying.length > 0 && (
                    <div className="small muted" style={{ padding: "8px 0 0" }}>
                      {plural(data.retrying.length, "job")} retrying with backoff.
                    </div>
                  )}
                </div>
              )
            )}
          </Async>
        </Card>
      </div>

      {/* Priority 4: where to go next. */}
      <Card title="Get something new">
        <div className="row">
          <LinkButton to="/search" icon="search" variant="primary">Search for a release</LinkButton>
          <LinkButton to="/downloads" icon="download">Downloads</LinkButton>
          <LinkButton to="/queue" icon="queue">Queue</LinkButton>
        </div>
      </Card>
    </>
  );
}
