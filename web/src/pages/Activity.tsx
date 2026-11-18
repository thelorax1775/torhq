/**
 * Activity — the one place to watch what was asked for arrive.
 *
 * Each item moves through requested -> searching -> downloading -> importing ->
 * available, and a stalled one says why in plain words with the fix. An admin's
 * rows link through to Transfers or History for the underlying detail, and the
 * admin also gets a Requests tab: member requests that wait for them (books and
 * audiobooks, which have no *arr to search by itself) with Approve / Decline.
 *
 * `?item=<id>` (from Transfers) highlights one row; `?view=requests` opens the tab.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { eta, ago } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, EmptyState, LinkButton, PageHeader, ProgressBar, RefreshButton, StaleNotice, cx, type Tone,
} from "../components/ui.js";
import { Icon } from "../components/Icon.js";

export const STAGES = ["requested", "searching", "downloading", "importing", "available"] as const;
export type Stage = (typeof STAGES)[number];

export interface ActivityItem {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  artwork: string | null;
  stage: Stage;
  status: "active" | "stalled" | "done";
  progress: number;
  etaSeconds: number | null;
  startedAt: number;
  requestedBy: string | null;
  source: string;
  stall?: { reason: string; fix: string; detail?: string };
  href?: string;
}
interface ActivityResponse { items: ActivityItem[]; unavailable: Array<{ source: string; detail: string }> }

const STAGE_LABEL: Record<Stage, string> = {
  requested: "Requested", searching: "Searching", downloading: "Downloading", importing: "Importing", available: "Available",
};
const KIND_LABEL: Record<string, string> = {
  movie: "Movie", tv: "TV", music: "Music", book: "Book", comic: "Comic", audiobook: "Audiobook", game: "Game", other: "Download",
};
type Filter = "all" | "active" | "stalled" | "done" | "requests";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" }, { id: "active", label: "In progress" },
  { id: "stalled", label: "Stalled" }, { id: "done", label: "Done" },
];

export function Stepper({ stage, status }: { stage: Stage; status: ActivityItem["status"] }) {
  const at = STAGES.indexOf(stage);
  return (
    <ol className="stepper" aria-label={`Stage: ${STAGE_LABEL[stage]}${status === "stalled" ? " (stalled)" : ""}`}>
      {STAGES.map((s, i) => {
        const state = i < at || (i === at && status === "done") ? "done" : i === at ? (status === "stalled" ? "stalled" : "current") : "todo";
        return (
          <li key={s} className={cx("step", state)} aria-current={i === at ? "step" : undefined} data-state={state}>
            <span className="step-dot">{state === "done" ? <Icon name="check" size={10} /> : state === "stalled" ? <Icon name="alert" size={10} /> : null}</span>
            <span className="step-label">{STAGE_LABEL[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface PendingRequest {
  id: string; kind: "book" | "audiobook"; title: string; author: string | null; requestedBy: string; createdAt: number;
}

function Row({ item, isAdmin, focused }: { item: ActivityItem; isAdmin: boolean; focused?: boolean }) {
  const tone: Tone = item.status === "stalled" ? "warn" : item.status === "done" ? "ok" : "accent";
  const barTone = item.status === "stalled" ? "warn" : item.status === "done" ? "ok" : undefined;
  const meta = [
    KIND_LABEL[item.kind] ?? item.kind,
    item.requestedBy ? `requested by ${item.requestedBy}` : null,
    ago(item.startedAt),
  ].filter(Boolean).join(" · ");
  return (
    <li
      className={cx("activity-row", item.status, focused && "focused")}
      data-stage={item.stage} data-status={item.status} data-id={item.id}
      aria-current={focused ? "true" : undefined}
      ref={focused ? (el) => el?.scrollIntoView?.({ block: "center" }) : undefined}
    >
      {item.artwork
        ? <img className="activity-art" src={item.artwork} alt="" loading="lazy" />
        : <div className="activity-art activity-art-empty" aria-hidden="true"><Icon name="download" size={18} /></div>}
      <div className="activity-main">
        <div className="activity-head">
          <h3 className="activity-title">{item.title}</h3>
          <Badge tone={tone}>{item.status === "stalled" ? `Stalled · ${STAGE_LABEL[item.stage]}` : STAGE_LABEL[item.stage]}</Badge>
        </div>
        <div className="activity-meta small muted">{meta}{item.subtitle ? ` · ${item.subtitle}` : ""}</div>
        <Stepper stage={item.stage} status={item.status} />
        {item.stage !== "requested" && item.stage !== "searching" && (
          <div className="activity-progress">
            <ProgressBar value={item.progress / 100} tone={barTone} />
            <span className="small muted num">
              {item.progress}%{item.etaSeconds ? ` · ${eta(item.etaSeconds)} left` : ""}
            </span>
          </div>
        )}
        {item.stall && (
          <div className="activity-stall" role="note">
            <p><strong>Why it stopped:</strong> {item.stall.reason}</p>
            <p><strong>What to do:</strong> {item.stall.fix}</p>
            {isAdmin && item.stall.detail && <p className="small muted mono">{item.stall.detail}</p>}
          </div>
        )}
        {isAdmin && item.href && (
          <Link className="activity-link small" to={item.href}>Details <Icon name="external" size={12} /></Link>
        )}
      </div>
    </li>
  );
}

export function Activity({ role }: { role: "admin" | "member" | null }) {
  const isAdmin = role === "admin";
  const [params, setParams] = useSearchParams();
  const q = usePolled<ActivityResponse>("/api/activity", 5000);
  const pending = usePolled<{ items: PendingRequest[] }>(isAdmin ? "/api/requests/pending" : null, 15000);
  const view = params.get("view");
  const filter: Filter = view === "requests" ? (isAdmin ? "requests" : "all")
    : FILTERS.find((f) => f.id === view)?.id ?? "all";
  const setFilter = (f: Filter) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (f === "all") next.delete("view"); else next.set("view", f);
    next.delete("item");
    return next;
  }, { replace: true });

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle={isAdmin
          ? "Everything that was asked for, from request to ready, and the requests waiting for your OK."
          : "Everything you asked for, from request to ready."}
        actions={<RefreshButton q={q} />}
      />
      <StaleNotice q={q} />
      <Async q={q} what="activity">
        {(data) => (
          <List
            data={data} filter={filter} setFilter={setFilter} isAdmin={isAdmin}
            pending={pending.data?.items ?? null} focus={params.get("item")}
          />
        )}
      </Async>
    </>
  );
}

function List({ data, filter, setFilter, isAdmin, pending, focus }: {
  data: ActivityResponse; filter: Filter; setFilter: (f: Filter) => void; isAdmin: boolean;
  pending: PendingRequest[] | null; focus: string | null;
}) {
  const counts = useMemo(() => ({
    all: data.items.length,
    active: data.items.filter((i) => i.status === "active").length,
    stalled: data.items.filter((i) => i.status === "stalled").length,
    done: data.items.filter((i) => i.status === "done").length,
    requests: pending?.length ?? 0,
  }), [data.items, pending]);
  const shown = filter === "all" || filter === "requests" ? data.items : data.items.filter((i) => i.status === filter);
  const filters = isAdmin ? [...FILTERS, { id: "requests" as const, label: "Requests" }] : FILTERS;
  const focusMissing = focus != null && !data.items.some((i) => i.id === focus);

  return (
    <>
      {isAdmin && data.unavailable.length > 0 && (
        <Alert tone="warn" title="Some sources did not answer">
          {data.unavailable.map((u) => `${u.source}: ${u.detail}`).join("; ")}
        </Alert>
      )}
      <div className="chips toolbar" role="group" aria-label="Filter activity">
        {filters.map((f) => (
          <button key={f.id} type="button" className={cx("chip", filter === f.id && "on")} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="num">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {filter === "requests" ? (
        <Requests items={pending} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="activity"
          title={data.items.length === 0 ? "Nothing yet" : "Nothing here"}
          message={data.items.length === 0
            ? "Search for something on the home page and ask for it. It will show up here and you can follow it until it is ready."
            : "No items match this filter."}
        />
      ) : (
        <ul className="activity-list" aria-label="Activity">
          {shown.map((i) => <Row key={i.id} item={i} isAdmin={isAdmin} focused={i.id === focus} />)}
        </ul>
      )}
      {focusMissing && filter !== "requests" && (
        <p className="small muted mt-3">That transfer isn't something anyone asked for through TorHQ, so it has no Activity entry; it is still on Transfers.</p>
      )}
    </>
  );
}

const PENDING_KIND: Record<PendingRequest["kind"], { label: string; page: string }> = {
  book: { label: "Book", page: "/books" }, audiobook: { label: "Audiobook", page: "/audiobooks" },
};

/**
 * Member requests that wait for the admin. Approve has TorHQ grab the best
 * matching release (the same ranking the Books page pre-selects); Decline closes
 * the request. Movie, TV and music requests never wait here: Radarr, Sonarr and
 * Lidarr start searching for those by themselves.
 */
function Requests({ items }: { items: PendingRequest[] | null }) {
  const [done, setDone] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const opts = { invalidates: ["/api/requests/pending", "/api/attention", "/api/activity"] };
  const approve = useMutation((id: string) => apiSend<{ ok: true; release: string }>(`/api/requests/pending/${id}/approve`, "POST"), opts);
  const decline = useMutation((id: string) => apiSend<{ ok: true }>(`/api/requests/pending/${id}/decline`, "POST"), opts);
  useEffect(() => { setErrors({}); }, [items?.length]);

  async function act(kind: "approve" | "decline", r: PendingRequest) {
    const res = kind === "approve" ? await approve.run(r.id) : await decline.run(r.id);
    if (res.ok) {
      setDone((d) => ({ ...d, [r.id]: kind === "approve" ? `Approved: downloading "${(res.data as { release?: string }).release ?? r.title}".` : "Declined." }));
    } else {
      setErrors((e) => ({ ...e, [r.id]: res.error }));
    }
  }

  if (items == null) return <EmptyState icon="star" title="Loading requests…" />;
  const notes = Object.entries(done);
  if (items.length === 0) {
    return (
      <>
        {notes.map(([id, msg]) => <Alert key={id} tone="ok">{msg}</Alert>)}
        <EmptyState
          icon="star" title="No requests waiting"
          message="When a friend asks for a book or an audiobook it waits here for your OK. Movies, TV and music go straight to Radarr, Sonarr and Lidarr, which start looking by themselves."
        />
      </>
    );
  }
  return (
    <>
      {notes.map(([id, msg]) => <Alert key={id} tone="ok">{msg}</Alert>)}
      <ul className="activity-list" aria-label="Requests waiting for you">
        {items.map((r) => (
          <li key={r.id} className="activity-row" data-id={r.id}>
            <div className="activity-art activity-art-empty" aria-hidden="true"><Icon name={r.kind === "audiobook" ? "play" : "book"} size={18} /></div>
            <div className="activity-main">
              <div className="activity-head">
                <h3 className="activity-title">{r.title}</h3>
                <Badge tone="info">Waiting for you</Badge>
              </div>
              <div className="activity-meta small muted">
                {[PENDING_KIND[r.kind].label, r.author, `requested by ${r.requestedBy}`, ago(r.createdAt)].filter(Boolean).join(" · ")}
              </div>
              {errors[r.id] && <Alert tone="err" title="Couldn't approve it">{errors[r.id]}</Alert>}
              <div className="row mt-2">
                <Button size="sm" variant="primary" icon="check" pending={approve.pending} onClick={() => void act("approve", r)}>Approve</Button>
                <Button size="sm" variant="danger" icon="close" pending={decline.pending} onClick={() => void act("decline", r)}>Decline</Button>
                <LinkButton size="sm" variant="ghost" to={PENDING_KIND[r.kind].page}>Choose the release yourself</LinkButton>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
