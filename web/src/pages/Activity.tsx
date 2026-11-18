/**
 * Activity — the one place to watch what was asked for arrive.
 *
 * Each item moves through requested -> searching -> downloading -> importing ->
 * available, and a stalled one says why in plain words with the fix. This merges
 * what used to be split across Downloads, Queue and Jobs; an admin's rows link
 * through to those pages (now under Advanced) for the underlying detail.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePolled } from "../lib/usePolled.js";
import { eta, ago } from "../lib/format.js";
import {
  Alert, Async, Badge, EmptyState, PageHeader, ProgressBar, RefreshButton, StaleNotice, cx, type Tone,
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
type Filter = "all" | "active" | "stalled" | "done";
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

function Row({ item, isAdmin }: { item: ActivityItem; isAdmin: boolean }) {
  const tone: Tone = item.status === "stalled" ? "warn" : item.status === "done" ? "ok" : "accent";
  const barTone = item.status === "stalled" ? "warn" : item.status === "done" ? "ok" : undefined;
  const meta = [
    KIND_LABEL[item.kind] ?? item.kind,
    item.requestedBy ? `requested by ${item.requestedBy}` : null,
    ago(item.startedAt),
  ].filter(Boolean).join(" · ");
  return (
    <li className={cx("activity-row", item.status)} data-stage={item.stage} data-status={item.status}>
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
  const q = usePolled<ActivityResponse>("/api/activity", 5000);
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Everything you asked for, from request to ready."
        actions={<RefreshButton q={q} />}
      />
      <StaleNotice q={q} />
      <Async q={q} what="activity">
        {(data) => <List data={data} filter={filter} setFilter={setFilter} isAdmin={isAdmin} />}
      </Async>
    </>
  );
}

function List({ data, filter, setFilter, isAdmin }: {
  data: ActivityResponse; filter: Filter; setFilter: (f: Filter) => void; isAdmin: boolean;
}) {
  const counts = useMemo(() => ({
    all: data.items.length,
    active: data.items.filter((i) => i.status === "active").length,
    stalled: data.items.filter((i) => i.status === "stalled").length,
    done: data.items.filter((i) => i.status === "done").length,
  }), [data.items]);
  const shown = filter === "all" ? data.items : data.items.filter((i) => i.status === filter);

  return (
    <>
      {isAdmin && data.unavailable.length > 0 && (
        <Alert tone="warn" title="Some sources did not answer">
          {data.unavailable.map((u) => `${u.source}: ${u.detail}`).join("; ")}
        </Alert>
      )}
      <div className="chips toolbar" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={cx("chip", filter === f.id && "on")} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="num">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon="activity"
          title={data.items.length === 0 ? "Nothing yet" : "Nothing here"}
          message={data.items.length === 0
            ? "Search for something on the home page and ask for it. It will show up here and you can follow it until it is ready."
            : "No items match this filter."}
        />
      ) : (
        <ul className="activity-list" aria-label="Activity">
          {shown.map((i) => <Row key={i.id} item={i} isAdmin={isAdmin} />)}
        </ul>
      )}
    </>
  );
}
