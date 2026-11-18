/**
 * Services — every external connection the *arr stack depends on: qBittorrent,
 * Radarr/Sonarr/Lidarr, Prowlarr (primary search), slskd, the intake targets
 * (Kavita/Navidrome), Jellyfin, and the two search fallbacks (torrentsearch,
 * websearch). This is the most security-sensitive page in the app.
 *
 * Secrets are write-only end to end (see server/src/config/store.ts and
 * config/extra.ts): the server never returns a stored secret, only a
 * `secretMask`/`<key>Set` presence flag. So every control here shows
 * "configured" / "not set", never a value that looks like the real thing —
 * no dot-masked placeholder implying a secret is present when it isn't, and
 * leaving a field blank always means "keep what's already stored", never
 * "clear it" (that distinction lives in `mergeExtra` server-side; the extra
 * fields below are pre-filled from the stored config so a blank field the
 * user never touched still round-trips unchanged).
 *
 * "Test connection" never persists anything — it calls the adapter directly
 * with the form's current values (falling back to the stored secret if the
 * field is blank) and is always a separate action from "Save".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiSend, toApiError } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Badge, Button, Card, Checkbox, Field, PageHeader,
  RefreshButton, SelectField, StaleNotice, StatusDot, TableWrap, TextField, type Tone,
} from "../components/ui.js";

interface SafeService {
  kind: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  lastHealthy: number | null;
  lastStatus: string | null;
  secretMask: string | null;
  extra: Record<string, unknown>;
}
interface ServicesResponse { services: SafeService[]; kinds: string[] }

interface HealthResult { healthy: boolean; version?: string; detail?: string; latencyMs?: number }
interface HealthResponse { health: Record<string, HealthResult>; services: SafeService[] }

interface ServiceInput {
  kind: string;
  label: string;
  baseUrl: string;
  secret?: string;
  extra?: Record<string, unknown>;
}

/** Static facts about each kind that the backend doesn't need to tell us. */
const KIND_META: Record<string, { label: string; role: string; secretHint: string; defaultUrl: string }> = {
  qbittorrent: { label: "qBittorrent", role: "Download client — every grab lands here first.", secretHint: "username:password", defaultUrl: "http://127.0.0.1:8080" },
  radarr: { label: "Radarr", role: "Movies.", secretHint: "API key", defaultUrl: "http://127.0.0.1:7878" },
  sonarr: { label: "Sonarr", role: "TV.", secretHint: "API key", defaultUrl: "http://127.0.0.1:8989" },
  lidarr: { label: "Lidarr", role: "Music.", secretHint: "API key", defaultUrl: "http://127.0.0.1:8686" },
  prowlarr: { label: "Prowlarr", role: "Primary search backend — aggregates every indexer you run.", secretHint: "API key", defaultUrl: "http://127.0.0.1:9696" },
  slskd: { label: "slskd", role: "Soulseek client.", secretHint: "API key", defaultUrl: "http://127.0.0.1:5030" },
  jellyfin: { label: "Jellyfin", role: "Media server — read-only visibility here.", secretHint: "API token", defaultUrl: "http://127.0.0.1:8096" },
  navidrome: { label: "Navidrome", role: "Music library — an intake target.", secretHint: "username:password", defaultUrl: "http://127.0.0.1:4533" },
  kavita: { label: "Kavita", role: "Books/manga/comics library — an intake target.", secretHint: "API key", defaultUrl: "http://127.0.0.1:5000" },
  audiobookshelf: { label: "Audiobookshelf", role: "Audiobook library — an intake target; shows which audiobooks you already hold.", secretHint: "API token (Settings → API Keys)", defaultUrl: "http://127.0.0.1:13378" },
  calibreweb: { label: "Calibre-Web", role: "Book library — read-only: used to show which books you already hold. Imports go to Kavita.", secretHint: "username:password (OPDS must be enabled)", defaultUrl: "http://127.0.0.1:8083" },
  torrentsearch: { label: "Torrent-index search", role: "Fallback scraper for one mirror — only needed where Prowlarr has no indexer.", secretHint: "not required", defaultUrl: "https://" },
  websearch: { label: "Web search", role: "General web-search widget alongside torrent search.", secretHint: "not required", defaultUrl: "http://127.0.0.1:8080" },
  tmdb: { label: "TMDB", role: "Catalogue source for movies and TV. Free key from themoviedb.org → Settings → API; either the API key or the read access token works.", secretHint: "API key or read access token", defaultUrl: "https://api.themoviedb.org" },
  rawg: { label: "RAWG", role: "Catalogue source for games. Free key from rawg.io/apidocs.", secretHint: "API key", defaultUrl: "https://api.rawg.io" },
  gemini: { label: "Gemini", role: "Identifies raw-search release names the *arr parsers cannot read. Optional — the parsers handle most names alone.", secretHint: "API key", defaultUrl: "https://generativelanguage.googleapis.com" },
};
const meta = (kind: string) => KIND_META[kind] ?? { label: kind, role: "", secretHint: "", defaultUrl: "" };

/**
 * A select populated by asking the service what it supports.
 *
 * Deliberately degrades rather than blocks: before the credential is saved, or
 * when the upstream is unreachable, the list cannot be fetched -- and a picker
 * that renders an empty dropdown in that state would make the field
 * unfillable. It falls back to a free-text input and says why. A value already
 * saved is always offered even if it is missing from the fetched list, so
 * opening this page can never silently change what is configured.
 */
function RemoteSelectField(
  { field, value, onChange }: {
    field: Extract<ExtraField, { kind: "select-remote" }>;
    value: string;
    onChange: (v: string) => void;
  },
) {
  const q = usePolled<Record<string, unknown>>(field.source);
  const list = Array.isArray(q.data?.[field.listKey]) ? (q.data![field.listKey] as string[]) : null;

  if (q.initial) {
    // Plain text, no escape: a JSX attribute string is not a JS string literal,
    // so a \u escape here would render as its own source text.
    return <Field label={field.label} hint="Loading models"><input className="input" disabled value={value} /></Field>;
  }

  if (!list || list.length === 0) {
    return (
      <TextField
        label={field.label}
        hint={q.error ? `${field.emptyHint} (${q.error.message})` : field.emptyHint}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // Keep a configured-but-unlisted value visible and selected, rather than
  // silently snapping the form to something the user never chose.
  const options = value && !list.includes(value) ? [value, ...list] : list;
  return (
    <SelectField
      label={field.label}
      hint={field.hint}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Default ({field.placeholder})</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}{value === m && !list.includes(m) ? " \u2014 not available to this key" : ""}
        </option>
      ))}
    </SelectField>
  );
}

/** How loudly a kind's row should read, driven entirely by the health check's
 *  own verdict — `detail` already carries the specific reason (timeout, 401,
 *  wrong port, …), so nothing here needs to guess at a message. */
function healthTone(h: HealthResult | undefined): Tone {
  if (!h) return "neutral";
  if (h.healthy) return "ok";
  return h.detail === "not configured" ? "neutral" : "err";
}
function healthLabel(h: HealthResult | undefined): string {
  if (!h) return "Unknown";
  if (h.healthy) return h.version ? `Healthy · v${h.version}` : "Healthy";
  return h.detail ?? "Unhealthy";
}

type ExtraField =
  | { key: string; kind: "text" | "number"; label: string; hint?: string; placeholder?: string; secret?: boolean }
  | { key: string; kind: "checkbox"; label: string }
  | { key: string; kind: "select"; label: string; options: Array<{ value: string; label: string }> }
  | { key: string; kind: "textarea"; label: string; hint?: string; placeholder?: string }
  /**
   * A select whose options come from the service itself, because the valid
   * values are a property of the configured credential rather than of this
   * release. `source` returns `{ <listKey>: string[] }`; while it is loading or
   * failing, the field degrades to a plain text input so a hardcoded list can
   * never be the thing that blocks a working configuration.
   */
  | { key: string; kind: "select-remote"; label: string; hint?: string; placeholder?: string;
      source: string; listKey: string; emptyHint: string };

// Per-kind "extra" config, matching EXTRA_SCHEMAS in server/src/config/extra.ts
// exactly — a kind with no entry here sends no extra at all.
const EXTRA_FIELDS: Partial<Record<string, ExtraField[]>> = {
  gemini: [
    {
      key: "model", kind: "select-remote", label: "Model",
      source: "/api/identify/models", listKey: "models",
      placeholder: "gemini-2.5-flash",
      hint: "Only the models this key can actually reach. Leave unset to use the default.",
      emptyHint: "Could not list models \u2014 save the API key first, then reopen this page. Until then you can type a model name.",
    },
  ],
  kavita: [
    { key: "libraryId", kind: "number", label: "Kavita library ID (optional)", placeholder: "3", hint: "When set, intake triggers an explicit scan of this library after import." },
  ],
  audiobookshelf: [
    { key: "libraryId", kind: "text", label: "Audiobookshelf library ID (optional)", placeholder: "b13523dc-…", hint: "The library to search and scan. Blank uses the first book library." },
  ],
  slskd: [
    { key: "webhookToken", kind: "text", secret: true, label: "Webhook token", hint: "Authenticates the completed-download webhook. Leave blank to keep the current token." },
  ],
  prowlarr: [
    { key: "defaultIndexerIds", kind: "text", label: "Default indexer IDs", placeholder: "1,4,7", hint: "Comma-separated Prowlarr indexer ids to search by default; blank searches every enabled indexer." },
    { key: "searchLimit", kind: "number", label: "Search result limit", placeholder: "50", hint: "10–500 results kept per search." },
  ],
  torrentsearch: [
    { key: "searchPath", kind: "text", label: "Search path template", placeholder: "/usearch/{query}/{page}/" },
    { key: "rowSelector", kind: "text", label: "Result row selector", placeholder: "table.data tr.odd, table.data tr.even" },
    { key: "titleSelector", kind: "text", label: "Title selector", placeholder: "a.cellMainLink" },
    { key: "magnetSelector", kind: "text", label: "Magnet link selector", placeholder: "a[href^='magnet:']" },
    { key: "seedersSelector", kind: "text", label: "Seeders selector", placeholder: "td.green.center" },
    { key: "leechersSelector", kind: "text", label: "Leechers selector", placeholder: "td.red.center" },
    { key: "sizeSelector", kind: "text", label: "Size selector", placeholder: "td.nobr.center" },
    { key: "detailLinkSelector", kind: "text", label: "Detail-link selector", placeholder: "a.cellMainLink" },
    {
      key: "flaresolverrUrl",
      kind: "text",
      label: "Cloudflare solver URL (optional)",
      placeholder: "http://127.0.0.1:8191",
      hint: "Byparr, or anything else speaking FlareSolverr's /v1 API. FlareSolverr itself no longer clears current Cloudflare challenges — it detects them and times out — so Byparr is the one to point this at.",
    },
    {
      key: "solverTimeoutMs",
      kind: "number",
      label: "Solver timeout (ms)",
      placeholder: "120000",
      hint: "How long to let the solver work. Blank uses 120000 — a solver that drives a real browser regularly needs more than a minute on a cold start.",
    },
    { key: "magnetOnDetailPage", kind: "checkbox", label: "Magnets are on each result's detail page (not the search results page)" },
  ],
  websearch: [
    { key: "provider", kind: "select", label: "Provider", options: [{ value: "link", label: "Link only (no setup)" }, { value: "widget", label: "Google widget (engine id only)" }, { value: "google", label: "Google JSON API (key + 100/day cap)" }, { value: "searxng", label: "SearXNG" }] },
    { key: "googleCx", kind: "text", label: "Google search-engine id (cx)", hint: "From programmablesearchengine.google.com. All the Google widget needs — no API key, no daily quota. The widget loads Google's script in your browser, so queries go to Google directly." },
    { key: "googleApiKey", kind: "text", secret: true, label: "Google API key", hint: "Only for the JSON API provider. Leave blank to keep the current key." },
    { key: "searxngUrl", kind: "text", label: "SearXNG URL" },
    { key: "linkTemplates", kind: "textarea", label: "Extra “search on…” shortcuts", hint: "One per line: Label|https://example.com/search?q={q}" },
  ],
};

const strVal = (v: unknown): string => (v == null ? "" : String(v));

/**
 * POST /api/services/test returns the health result even on failure (status
 * 502) — the failed connection attempt *is* the result, not an application
 * error. The shared `api()` wrapper only recovers a message from an `{error}`
 * body on a non-2xx response, so going through it here would collapse a
 * specific failure (wrong port, 401, timeout) into a bare "HTTP 502". This
 * bypasses that one wrapper while still attaching the CSRF header by hand.
 */
/**
 * A failed connection test is a successful *test* — the server answers 502 with
 * the same `HealthResult` body, and that body carries the only useful part
 * (wrong port, 401, timeout). So the error is unwrapped rather than surfaced.
 */
async function testService(body: ServiceInput): Promise<HealthResult> {
  try {
    return await apiSend<HealthResult>("/api/services/test", "POST", body);
  } catch (e) {
    const err = toApiError(e);
    if (err.body && typeof err.body === "object" && "healthy" in err.body) return err.body as HealthResult;
    throw err;
  }
}

export function Services() {
  const servicesQ = usePolled<ServicesResponse>("/api/services");
  const healthQ = usePolled<HealthResponse>("/api/status/health", 20000);

  const [sel, setSel] = useState("qbittorrent");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [extra, setExtra] = useState<Record<string, string | boolean>>({});
  const formRef = useRef<HTMLDivElement>(null);

  const test = useMutation(testService);
  const save = useMutation(
    (body: ServiceInput) => apiSend<{ ok: true }>("/api/services", "POST", body),
    { invalidates: ["/api/services", "/api/status/health"] },
  );

  const services = servicesQ.data?.services ?? [];
  const kinds = servicesQ.data?.kinds ?? [];
  const health = healthQ.data?.health ?? {};
  const current = services.find((s) => s.kind === sel);
  const fields = EXTRA_FIELDS[sel] ?? [];

  // Re-seed the form whenever the selected kind changes or fresh data arrives
  // (e.g. right after a save) — same load-then-reset flow as Save below.
  useEffect(() => {
    setBaseUrl(current?.baseUrl ?? meta(sel).defaultUrl);
    setSecret("");
    const draft: Record<string, string | boolean> = {};
    for (const f of fields) {
      draft[f.key] = f.kind === "checkbox" ? !!current?.extra[f.key] : strVal(current?.extra[f.key]);
    }
    setExtra(draft);
    test.reset();
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, services]);

  function buildExtra(): Record<string, unknown> | undefined {
    if (fields.length === 0) return undefined;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = extra[f.key];
      if (f.kind === "checkbox") { out[f.key] = !!v; continue; }
      if (f.kind === "select") { if (typeof v === "string" && v) out[f.key] = v; continue; }
      // Blank means "leave alone": for a secret that keeps the stored value,
      // for anything else it resets to the adapter's built-in default —
      // matches mergeExtra() in server/src/config/extra.ts.
      if (typeof v === "string" && v.trim()) out[f.key] = f.kind === "number" ? Number(v.trim()) : v.trim();
    }
    return out;
  }

  function body(): ServiceInput {
    return { kind: sel, label: meta(sel).label, baseUrl, secret: secret || undefined, extra: buildExtra() };
  }

  const counts = useMemo(() => {
    let healthy = 0, attention = 0, unset = 0;
    for (const k of kinds) {
      const h = health[k];
      if (!h || h.detail === "not configured") unset++;
      else if (h.healthy) healthy++;
      else attention++;
    }
    return { healthy, attention, unset };
  }, [kinds, health]);

  function edit(kind: string) {
    setSel(kind);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const secretConfigured = !!current?.secretMask;
  const showSecretField = meta(sel).secretHint !== "not required";

  return (
    <>
      <PageHeader
        title="Services"
        subtitle="The apps TorHQ talks to (Radarr, Sonarr, qBittorrent and the rest) and how to reach them; saved keys and passwords are never shown again."
        actions={<RefreshButton q={servicesQ} />}
      />

      <Async q={servicesQ} what="services">
        {() => (
          <div className="stack">
            <div className="stat-grid">
              <Badge tone="ok" title="Reachable on the last health check">{counts.healthy} healthy</Badge>
              <Badge tone={counts.attention ? "err" : "neutral"} title="Configured but the last check failed">{counts.attention} need attention</Badge>
              <Badge tone="neutral" title="No connection saved yet">{counts.unset} not set up</Badge>
            </div>

            <Card title="Connections" icon="plug" flush>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Base URL</th>
                      <th>Secret</th>
                      <th>Status</th>
                      <th className="shrink" />
                    </tr>
                  </thead>
                  <tbody>
                    {kinds.map((kind) => {
                      const svc = services.find((s) => s.kind === kind);
                      const h = health[kind];
                      const tone = healthTone(h);
                      return (
                        <tr key={kind} className={kind === sel ? "selected" : undefined}>
                          <td>
                            <div className="row-nowrap" style={{ gap: 8 }}>
                              <StatusDot tone={tone} />
                              <div>
                                <div>{meta(kind).label}</div>
                                <div className="dim xs">{meta(kind).role}</div>
                              </div>
                            </div>
                          </td>
                          <td className="mono small break">
                            {svc?.baseUrl ?? <span className="dim">not configured</span>}
                          </td>
                          <td>
                            {meta(kind).secretHint === "not required"
                              ? <span className="dim small">not required</span>
                              : <Badge tone={svc?.secretMask ? "ok" : "warn"}>{svc?.secretMask ? "configured" : "not set"}</Badge>}
                          </td>
                          <td className="nowrap"><Badge tone={tone} title={h?.detail}>{healthLabel(h)}</Badge></td>
                          <td className="shrink">
                            <Button size="sm" variant="ghost" onClick={() => edit(kind)}>Edit</Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </Card>

            <div ref={formRef}>
              <Card
                title="Configure a connection"
                subtitle={meta(sel).role}
                icon="settings"
              >
                <div className="grid-2">
                  <SelectField label="Service" value={sel} onChange={(e) => setSel(e.target.value)}>
                    {kinds.map((k) => <option key={k} value={k}>{meta(k).label}</option>)}
                  </SelectField>
                  <TextField
                    label="Base URL"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={meta(sel).defaultUrl}
                  />
                </div>

                {showSecretField && (
                  <Field
                    label={`Secret (${meta(sel).secretHint})`}
                    hint={
                      <span className="row-nowrap" style={{ gap: 6 }}>
                        {secretConfigured ? <Badge tone="ok">configured</Badge> : <Badge tone="warn">not set</Badge>}
                        <span>Leave blank to keep the current value.</span>
                      </span>
                    }
                  >
                    <input
                      type="password"
                      className="input"
                      autoComplete="new-password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={secretConfigured ? "Unchanged if left blank" : "Required to connect"}
                    />
                  </Field>
                )}

                {sel === "torrentsearch" && (
                  <p className="muted small">
                    Point Base URL at a torrent-index mirror. Leave the selector fields below blank to use the
                    built-in KAT-style defaults shown as placeholders — these mirrors rot and change often.
                  </p>
                )}

                {fields.map((f) => {
                  if (f.kind === "checkbox") {
                    return (
                      <div key={f.key} className="mt-2">
                        <Checkbox
                          label={f.label}
                          checked={!!extra[f.key]}
                          onChange={(v) => setExtra((s) => ({ ...s, [f.key]: v }))}
                        />
                      </div>
                    );
                  }
                  if (f.kind === "select") {
                    return (
                      <SelectField
                        key={f.key}
                        label={f.label}
                        value={strVal(extra[f.key]) || f.options[0]?.value}
                        onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
                      >
                        {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </SelectField>
                    );
                  }
                  if (f.kind === "select-remote") {
                    return (
                      <RemoteSelectField
                        key={f.key}
                        field={f}
                        value={strVal(extra[f.key])}
                        onChange={(v) => setExtra((s) => ({ ...s, [f.key]: v }))}
                      />
                    );
                  }
                  if (f.kind === "textarea") {
                    return (
                      <Field key={f.key} label={f.label} hint={f.hint}>
                        <textarea
                          className="textarea"
                          value={strVal(extra[f.key])}
                          placeholder={f.placeholder}
                          onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
                        />
                      </Field>
                    );
                  }
                  return (
                    <TextField
                      key={f.key}
                      label={f.label}
                      hint={f.secret ? (current?.extra[`${f.key}Set`] ? "Set — leave blank to keep it." : f.hint) : f.hint}
                      type={f.secret ? "password" : f.kind === "number" ? "number" : "text"}
                      value={strVal(extra[f.key])}
                      placeholder={f.placeholder}
                      onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  );
                })}

                <div className="row" style={{ marginTop: 4 }}>
                  <Button pending={test.pending} onClick={() => void test.run(body())}>Test connection</Button>
                  <Button variant="primary" pending={save.pending} onClick={() => void save.run(body())}>Save</Button>
                </div>

                {test.error && <Alert tone="err" title={`Test failed — ${meta(sel).label}`}>{test.error}</Alert>}
                {test.data && (
                  <Alert tone={test.data.healthy ? "ok" : "err"} title={`Tested ${meta(sel).label}`}>
                    {test.data.healthy
                      ? (test.data.version ? `Reachable — version ${test.data.version}` : "Reachable")
                      : (test.data.detail ?? "Unhealthy")}
                  </Alert>
                )}
                {save.error && <Alert tone="err" title="Save failed">{save.error}</Alert>}
                {save.data && <Alert tone="ok" title="Saved">{meta(sel).label} connection saved.</Alert>}
              </Card>
            </div>

            <StaleNotice q={servicesQ} />
          </div>
        )}
      </Async>
    </>
  );
}
