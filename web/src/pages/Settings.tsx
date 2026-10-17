/**
 * Settings — the things that belong to this browser and this deployment, as
 * opposed to the media stack itself.
 *
 * Connections live on Services, storage on Mounts; this page deliberately holds
 * only what neither of those owns: display preferences (local, no server round
 * trip), which drive new content goes to, and read-only facts about the running
 * instance, including the approved roots that bound every path TorHQ will accept.
 */
import { useEffect, useState } from "react";
import { usePolled, setPollRate } from "../lib/usePolled.js";
import { applyPrefs, loadPrefs, savePrefs, type Prefs, type Theme } from "../lib/prefs.js";
import {
  Alert, Async, Badge, Card, Field, LinkButton, PageHeader, Stat,
} from "../components/ui.js";
import { UpdateCard } from "../components/UpdateCard.js";
import { DrivesCard } from "../components/DrivesCard.js";

interface RootsResponse { approvedRoots: string[] }
interface HealthResponse { status: string; uptime: number }

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const RATE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Live (as designed)" },
  { value: 2, label: "Relaxed (half as often)" },
  { value: 4, label: "Slow (quarter as often)" },
  { value: 10, label: "Minimal (wall display)" },
];

/** Uptime as the largest two units that are non-zero. */
function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function Settings() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const roots = usePolled<RootsResponse>("/api/config/roots");
  const health = usePolled<HealthResponse>("/health", 60000);

  // One effect owns persistence and application, so the two can never disagree.
  useEffect(() => {
    savePrefs(prefs);
    applyPrefs(prefs, setPollRate);
  }, [prefs]);

  const update = <K extends keyof Prefs>(key: K, value: Prefs[K]) =>
    setPrefs((p) => ({ ...p, [key]: value }));

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Display preferences for this browser, and what this TorHQ instance is allowed to touch."
      />

      <Card
        title="Appearance"
        subtitle="Stored in this browser only — other devices and other sessions are unaffected."
        icon="sliders"
      >
        <div className="grid-2">
          <Field label="Theme" hint="“Match system” follows your OS light/dark setting.">
            <div className="btn-group" role="group" aria-label="Theme">
              {THEME_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`btn btn-sm${prefs.theme === o.value ? " active" : ""}`}
                  aria-pressed={prefs.theme === o.value}
                  onClick={() => update("theme", o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Refresh rate"
            hint="Stretches every background poll. Manual refreshes are always immediate."
          >
            <select
              className="select"
              value={prefs.pollRate}
              onChange={(e) => update("pollRate", Number(e.target.value))}
            >
              {RATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      <DrivesCard />

      <Card
        title="Approved roots"
        subtitle="TorHQ refuses any path outside these, whatever the request says."
        icon="folder"
        footer={
          <span className="muted small">
            Set with <code className="mono">TORHQ_APPROVED_ROOTS</code> in <code className="mono">/etc/torhq/torhq.env</code>.
            Changing it needs a service restart — it cannot be edited from the UI by design.
          </span>
        }
      >
        <Async q={roots} what="approved roots">
          {(data) => (
            data.approvedRoots.length === 0 ? (
              <Alert tone="warn" title="No approved roots configured">
                Every path-taking feature — intake, manual imports, library scans — will refuse to run until at
                least one root is set.
              </Alert>
            ) : (
              <div className="list">
                {data.approvedRoots.map((r) => (
                  <div key={r} className="list-row">
                    <Badge tone="info">root</Badge>
                    <span className="mono small break grow">{r}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </Async>
      </Card>

      <Card title="This instance" icon="server">
        <div className="stat-grid">
          <Stat
            label="Server"
            value={health.data?.status === "ok" ? "Healthy" : health.error ? "Unreachable" : "…"}
            tone={health.data?.status === "ok" ? "ok" : health.error ? "err" : "neutral"}
          />
          <Stat label="Uptime" value={health.data ? uptime(health.data.uptime) : "—"} />
          <Stat label="Approved roots" value={roots.data?.approvedRoots.length ?? "—"} />
        </div>
      </Card>

      <UpdateCard />

      <Card
        title="Configured elsewhere"
        subtitle="The settings that change what TorHQ does, rather than how it looks."
        icon="plug"
      >
        <div className="row">
          <LinkButton to="/services" icon="plug">Services &amp; credentials</LinkButton>
          <LinkButton to="/mounts" icon="server">Mounts &amp; storage</LinkButton>
          <LinkButton to="/libraries" icon="book">Libraries</LinkButton>
          <LinkButton to="/queue" icon="shield">Pipeline health</LinkButton>
        </div>
      </Card>
    </>
  );
}
