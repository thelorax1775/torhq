/**
 * Search — the flagship page. One release search across three sources, with
 * grabbing as the whole point: every result row ends in a "send this to X"
 * action, never a dead end.
 *
 *  - `prowlarr` aggregates every indexer you run — the source to reach for.
 *  - `site` is the configuration-driven scraper (see torrentsearch.ts), kept
 *    as a fallback for when Prowlarr itself is down or unconfigured.
 *  - `web` is a link-out widget: it returns links, and — depending on the
 *    provider — either inline snippets or Google's own embedded Programmable
 *    Search widget. Never grabbable releases: TorHQ does not pretend the open
 *    web can be sent to qBittorrent.
 *
 * The whole query state (source, term, indexer/category filters, page) lives
 * in the URL via `useSearchParams`, so a search is a link you can bookmark,
 * share, or reload without losing your place.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { GoogleSearchWidget } from "../components/GoogleSearchWidget.js";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled, type Polled } from "../lib/usePolled.js";
import { ago, bytes, plural, titleCase } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, Checkbox, EmptyState, InlineStatus, PageHeader,
  RefreshButton, StaleNotice, TableWrap, cx,
} from "../components/ui.js";
import { Icon, type IconName } from "../components/Icon.js";
import {
  IdentityBadge, RouteDialog, useIdentities,
  type ArrService, type Identification, type RouteRequest,
} from "../components/IdentifyRouting.js";

type SourceId = "prowlarr" | "site" | "web";

interface SourceInfo { id: SourceId; label: string; available: boolean; detail: string }
interface SourcesResponse { sources: SourceInfo[] }

interface ProwlarrCategory { id: number; name: string }
interface ProwlarrIndexer { id: number; name: string; enable: boolean; protocol: string; categories: ProwlarrCategory[] }
interface IndexersResponse { indexers: ProwlarrIndexer[] }

interface ProwlarrRelease {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  protocol: "torrent" | "usenet";
  publishDate: string | null;
  categories: ProwlarrCategory[];
  infoUrl?: string;
  magnetUrl?: string;
  downloadUrl?: string;
}

interface SiteResult {
  title: string;
  magnet: string;
  seeders: number | null;
  leechers: number | null;
  sizeBytes: number | null;
  detailUrl: string | null;
}

interface WebResult { title: string; url: string; displayUrl?: string; snippet?: string }
interface WebLink { label: string; url: string }

type SearchResponse =
  | { source: "prowlarr"; results: ProwlarrRelease[] }
  | { source: "site"; results: SiteResult[] }
  | {
      source: "web";
      provider: "link" | "widget" | "google" | "searxng";
      results: WebResult[];
      links: WebLink[];
      /** Google engine id, sent only for the `widget` provider. */
      cx?: string;
      degraded?: string;
    };

type GrabTarget = "qbittorrent" | "games" | "radarr" | "sonarr" | "lidarr";
interface GrabRequestBody {
  source: "prowlarr" | "site";
  target: GrabTarget;
  title: string;
  guid?: string;
  indexerId?: number;
  magnet?: string;
  downloadUrl?: string;
}
interface GrabResponse { ok: true; via: "prowlarr" | "qbittorrent"; category: string; importTriggered: boolean }

const SOURCE_DEFS: Array<{ id: SourceId; label: string; icon: IconName }> = [
  { id: "prowlarr", label: "Prowlarr", icon: "server" },
  { id: "site", label: "Torrent site", icon: "globe" },
  { id: "web", label: "Web", icon: "link" },
];

// What sending a grab to each target actually does, shown before the user
// commits — grabbing to an *arr hands off the import; qBittorrent alone does not.
const TARGETS: Array<{ id: GrabTarget; label: string; hint: string }> = [
  { id: "radarr", label: "Radarr", hint: "Radarr will pick this up and import it once the download finishes." },
  { id: "sonarr", label: "Sonarr", hint: "Sonarr will pick this up and import it once the download finishes." },
  { id: "lidarr", label: "Lidarr", hint: "Lidarr will pick this up and import it once the download finishes." },
  { id: "qbittorrent", label: "qBittorrent (manual)", hint: "Goes straight to qBittorrent under torhq-manual — nothing imports it automatically." },
  { id: "games", label: "qBittorrent (games)", hint: "Goes straight to qBittorrent under torhq-games — no *arr manages games, so nothing imports it." },
];

const PROVIDER_LABEL: Record<WebSearchResponse["provider"], string> = {
  link: "No search provider configured",
  widget: "Google Programmable Search — Google's own widget",
  google: "Google Programmable Search",
  searxng: "SearXNG",
};
type WebSearchResponse = Extract<SearchResponse, { source: "web" }>;

export function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const source = (searchParams.get("source") as SourceId | null) ?? "prowlarr";
  const q = searchParams.get("q") ?? "";
  const indexerIdsParam = searchParams.get("indexerIds") ?? "";
  const categoriesParam = searchParams.get("categories") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const [term, setTerm] = useState(q);
  // `?target=` lets another page choose where grabs go — the Catalogue sends
  // games here with `target=games`.
  const [target, setTarget] = useState<GrabTarget>(() => {
    const t = searchParams.get("target");
    return TARGETS.some((d) => d.id === t) ? (t as GrabTarget) : "radarr";
  });
  const [rowStatus, setRowStatus] = useState<Record<string, { tone: "ok" | "err"; text: string }>>({});
  const [pendingRows, setPendingRows] = useState<Set<string>>(new Set());
  // Identification is on by default: the *arr parsers answer most names for
  // free, and Gemini is only reached for what they cannot read. The toggle
  // exists for anyone who would rather it never reached a paid API at all.
  const [identify, setIdentify] = useState(true);
  const [routing, setRouting] = useState<RouteRequest | null>(null);

  const sourcesQ = usePolled<SourcesResponse>("/api/search/sources", 60000);
  // Static per source for the session; only re-subscribed (not re-fetched) when
  // switching back to Prowlarr, since the cache entry survives the unmount.
  const indexersQ = usePolled<IndexersResponse>(source === "prowlarr" ? "/api/search/indexers" : null);

  const resultsPath = useMemo(() => {
    if (!q.trim()) return null;
    const params = new URLSearchParams({ source, q });
    if (source === "prowlarr") {
      if (indexerIdsParam) params.set("indexerIds", indexerIdsParam);
      if (categoriesParam) params.set("categories", categoriesParam);
    }
    if (source === "site" && page > 1) params.set("page", String(page));
    return `/api/search?${params.toString()}`;
  }, [source, q, indexerIdsParam, categoriesParam, page]);
  const resultsQ = usePolled<SearchResponse>(resultsPath, 0);

  const grab = useMutation(
    (body: GrabRequestBody) => apiSend<GrabResponse>("/api/search/grab", "POST", body),
    { invalidates: ["/api/downloads", "/api/queue"] },
  );

  // Every visible release name, identified in one batched request. Only the
  // grabbable sources: a web result is a link to a page, not a release, and
  // asking a model to identify one would spend money on a meaningless answer.
  const visibleTitles = useMemo(() => {
    const d = resultsQ.data;
    if (!d || d.source === "web") return [];
    return d.results.map((r) => r.title).filter(Boolean);
  }, [resultsQ.data]);
  const ids = useIdentities(visibleTitles, identify && source !== "web");

  const sourceInfo = (id: SourceId) => sourcesQ.data?.sources.find((s) => s.id === id);
  const selectedIndexerIds = useMemo(
    () => new Set(indexerIdsParam ? indexerIdsParam.split(",").map(Number) : []),
    [indexerIdsParam],
  );
  const selectedCategoryIds = useMemo(
    () => new Set(categoriesParam ? categoriesParam.split(",").map(Number) : []),
    [categoriesParam],
  );
  const topCategories = useMemo(() => {
    const byId = new Map<number, ProwlarrCategory>();
    for (const idx of indexersQ.data?.indexers ?? []) {
      for (const c of idx.categories) if (c.id % 1000 === 0 && !byId.has(c.id)) byId.set(c.id, c);
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [indexersQ.data]);

  function selectSource(id: SourceId) {
    const next = new URLSearchParams(searchParams);
    next.set("source", id);
    next.delete("indexerIds");
    next.delete("categories");
    next.delete("page");
    setSearchParams(next, { replace: true });
  }

  function submitSearch() {
    const trimmed = term.trim();
    if (!trimmed) return;
    const next = new URLSearchParams(searchParams);
    next.set("source", source);
    next.set("q", trimmed);
    next.delete("page");
    setSearchParams(next);
  }

  function toggleIdParam(name: "indexerIds" | "categories", id: number, current: Set<number>) {
    const next = new URLSearchParams(searchParams);
    const updated = new Set(current);
    if (updated.has(id)) updated.delete(id); else updated.add(id);
    if (updated.size) next.set(name, [...updated].join(",")); else next.delete(name);
    setSearchParams(next, { replace: true });
  }

  function clearIdParam(name: "indexerIds" | "categories") {
    const next = new URLSearchParams(searchParams);
    next.delete(name);
    setSearchParams(next, { replace: true });
  }

  function setPage(p: number) {
    const next = new URLSearchParams(searchParams);
    if (p > 1) next.set("page", String(p)); else next.delete("page");
    setSearchParams(next, { replace: true });
  }

  async function doGrab(key: string, body: GrabRequestBody) {
    setPendingRows((s) => new Set(s).add(key));
    const r = await grab.run(body);
    setPendingRows((s) => { const n = new Set(s); n.delete(key); return n; });
    setRowStatus((s) => ({
      ...s,
      [key]: r.ok ? { tone: "ok", text: grabSuccessText(r.data) } : { tone: "err", text: r.error },
    }));
  }

  const activeSourceInfo = sourceInfo(source);

  return (
    <>
      <PageHeader
        title="Search indexers"
        subtitle={<>Raw releases straight from your indexers, for when the main <Link to="/">Search</Link> can't find it (a specific edition, a game, a file no app tracks); a release sent to Radarr, Sonarr or Lidarr is filed by that app.</>}
      />

      {activeSourceInfo && !activeSourceInfo.available && (
        <Alert tone="warn" title={`${activeSourceInfo.label} is unavailable`}>
          {activeSourceInfo.detail}
          {source !== "web" && <> — configure it on the <Link to="/services">Services</Link> page.</>}
        </Alert>
      )}

      <Card flush>
        <div className="tabs" role="group" aria-label="Search source">
          {SOURCE_DEFS.map((def) => {
            const info = sourceInfo(def.id);
            const unavailable = info != null && !info.available;
            return (
              <button
                key={def.id}
                type="button"
                className={cx("tab", source === def.id && "active")}
                aria-pressed={source === def.id}
                disabled={unavailable}
                title={info?.detail}
                onClick={() => selectSource(def.id)}
              >
                <Icon name={def.icon} size={14} />
                {def.label}
                {unavailable && <Badge tone="warn">unavailable</Badge>}
              </button>
            );
          })}
        </div>

        <div className="toolbar">
          <div className="searchbar">
            <Icon name="search" size={14} />
            <input
              className="input"
              value={term}
              placeholder="e.g. Blade Runner 2049 2160p"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitSearch(); }}
              aria-label={`Search ${SOURCE_DEFS.find((d) => d.id === source)!.label}`}
            />
          </div>
          <Button variant="primary" icon="search" disabled={!term.trim()} onClick={submitSearch}>Search</Button>
        </div>

        {source === "prowlarr" && indexersQ.data && indexersQ.data.indexers.length > 0 && (
          <>
            <div className="toolbar">
              <span className="small muted">Indexers:</span>
              <button type="button" className={cx("chip", selectedIndexerIds.size === 0 && "on")}
                aria-pressed={selectedIndexerIds.size === 0} onClick={() => clearIdParam("indexerIds")}>
                All
              </button>
              {indexersQ.data.indexers.map((idx) => (
                <button
                  key={idx.id}
                  type="button"
                  className={cx("chip", selectedIndexerIds.has(idx.id) && "on")}
                  aria-pressed={selectedIndexerIds.has(idx.id)}
                  disabled={!idx.enable}
                  title={idx.enable ? undefined : `${idx.name} is disabled in Prowlarr`}
                  onClick={() => toggleIdParam("indexerIds", idx.id, selectedIndexerIds)}
                >
                  {idx.name}
                </button>
              ))}
            </div>
            {topCategories.length > 0 && (
              <div className="toolbar">
                <span className="small muted">Categories:</span>
                <button type="button" className={cx("chip", selectedCategoryIds.size === 0 && "on")}
                  aria-pressed={selectedCategoryIds.size === 0} onClick={() => clearIdParam("categories")}>
                  All
                </button>
                {topCategories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cx("chip", selectedCategoryIds.has(c.id) && "on")}
                    aria-pressed={selectedCategoryIds.has(c.id)}
                    onClick={() => toggleIdParam("categories", c.id, selectedCategoryIds)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {!q ? (
        <EmptyState
          icon="search"
          title="Type a search term to begin"
          message="Switch sources above first if you want the torrent site or the open web instead of Prowlarr."
        />
      ) : (
        <Async q={resultsQ} what="search results">
          {(data) => {
            if (data.source === "web") return <WebResultsCard data={data} q={resultsQ} term={q} />;

            const results = data.results;
            return (
              <Card
                title={results.length === 0 ? "No releases found" : plural(results.length, "result")}
                subtitle={data.source === "prowlarr" ? "Strongest-seeded first." : `Strongest-seeded first — page ${page}.`}
                actions={<RefreshButton q={resultsQ} />}
                flush={results.length > 0}
                footer={data.source === "site" && results.length > 0 ? (
                  <div className="row-nowrap">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev page</Button>
                    <span className="small muted">Page {page}</span>
                    <Button size="sm" onClick={() => setPage(page + 1)}>Next page ›</Button>
                  </div>
                ) : undefined}
              >
                {results.length === 0 ? (
                  <EmptyState
                    icon="search"
                    title="Nothing matched"
                    message="Try different terms, fewer indexer/category filters, or another source."
                  />
                ) : (
                  <>
                    <div className="toolbar">
                      <label className="small muted" htmlFor="grab-target">Send grabs to</label>
                      <select
                        id="grab-target"
                        className="select input-sm"
                        style={{ width: "auto" }}
                        value={target}
                        onChange={(e) => setTarget(e.target.value as GrabTarget)}
                      >
                        {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                      <span className="small muted grow">{TARGETS.find((t) => t.id === target)!.hint}</span>
                      <Checkbox
                        label="Identify releases"
                        checked={identify}
                        onChange={setIdentify}
                      />
                    </div>
                    {identify && (
                      <div className="small muted mb-2">
                        <Icon name="info" size={12} />{" "}
                        Each release is put through Radarr, Sonarr and Lidarr&rsquo;s own parsers first.
                        Gemini is only asked about names none of them can read, and only when it is configured.
                        <strong> Send to&hellip;</strong> adds the title to that *arr and grabs it there, so it
                        imports and files itself &mdash; a plain <em>Grab</em> does not.
                        {ids.error && <span className="err"> Identification failed: {ids.error}</span>}
                      </div>
                    )}
                    {data.source === "prowlarr"
                      ? <ProwlarrTable results={data.results} target={target} pendingRows={pendingRows} rowStatus={rowStatus} onGrab={doGrab} identities={identify ? ids.map : null} onRoute={setRouting} />
                      : <SiteTable results={data.results} target={target} pendingRows={pendingRows} rowStatus={rowStatus} onGrab={doGrab} identities={identify ? ids.map : null} onRoute={setRouting} />}
                  </>
                )}
              </Card>
            );
          }}
        </Async>
      )}

      {routing && (
        <RouteDialog req={routing} onClose={() => setRouting(null)} />
      )}

      {resultsPath && <StaleNotice q={resultsQ} />}
    </>
  );
}

/** Human-readable line for the per-row inline status once a grab resolves. */
function grabSuccessText(data: GrabResponse): string {
  const dest = data.category === "torhq-manual" ? "qBittorrent"
    : data.category === "torhq-games" ? "qBittorrent (games)"
    : titleCase(data.category);
  return data.importTriggered ? `Sent to ${dest} — import triggered` : `Sent to ${dest}`;
}

function prowlarrGrabBody(r: ProwlarrRelease, target: GrabTarget): GrabRequestBody {
  const body: GrabRequestBody = { source: "prowlarr", guid: r.guid, indexerId: r.indexerId, title: r.title, target };
  if (r.magnetUrl) body.magnet = r.magnetUrl;
  else if (r.downloadUrl) body.downloadUrl = r.downloadUrl;
  return body;
}

function siteGrabBody(r: SiteResult, target: GrabTarget): GrabRequestBody {
  return { source: "site", magnet: r.magnet, title: r.title, target };
}

interface GrabTableProps<T> {
  results: T[];
  target: GrabTarget;
  pendingRows: Set<string>;
  rowStatus: Record<string, { tone: "ok" | "err"; text: string }>;
  onGrab: (key: string, body: GrabRequestBody) => void;
  /** null when identification is switched off. */
  identities: Record<string, Identification> | null;
  onRoute: (req: RouteRequest) => void;
}

/**
 * The badge under a release name, plus the routing action. Grabbing through an
 * *arr uses the same /api/search/grab call as a plain grab, only with the
 * target set to the *arr the release was identified as -- which now imports
 * correctly, because RouteDialog guarantees the library entry first.
 */
function identityCell(
  title: string,
  identities: Record<string, Identification> | null,
  onRoute: (req: RouteRequest) => void,
  grabAs: (service: ArrService) => Promise<void>,
) {
  if (!identities) return null;
  const id = identities[title];
  if (id && id.source === "none") return null; // don't clutter rows nothing could read
  return (
    <div className="mt-2">
      <IdentityBadge id={id} onRoute={() => id && onRoute({ id, grab: grabAs })} />
    </div>
  );
}

function ProwlarrTable({ results, target, pendingRows, rowStatus, onGrab, identities, onRoute }: GrabTableProps<ProwlarrRelease>) {
  return (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <th>Release</th>
            <th className="num">Size</th>
            <th className="num">S / L</th>
            <th className="num">Published</th>
            <th className="shrink" />
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const key = `${r.indexerId}:${r.guid}`;
            return (
              <tr key={key}>
                <td style={{ maxWidth: 440 }}>
                  <div className="break" title={r.title}>
                    {r.infoUrl ? <a href={r.infoUrl} target="_blank" rel="noreferrer noopener">{r.title}</a> : r.title}
                  </div>
                  <div className="row-nowrap xs dim mt-2">
                    <span>{r.indexer}</span>
                    {r.protocol === "usenet" && <Badge tone="info">usenet</Badge>}
                    {r.categories.slice(0, 3).map((c) => <Badge key={c.id}>{c.name}</Badge>)}
                    {r.categories.length > 3 && <span>+{r.categories.length - 3}</span>}
                  </div>
                  {identityCell(r.title, identities, onRoute, async (service) => {
                    await onGrab(key, { ...prowlarrGrabBody(r, target), target: service });
                  })}
                </td>
                <td className="num">{bytes(r.size)}</td>
                <td className="num">
                  <span className={r.seeders ? "ok-text" : "dim"}>{r.seeders ?? "—"}</span>
                  {" / "}
                  <span className="dim">{r.leechers ?? "—"}</span>
                </td>
                <td className="num dim">{ago(r.publishDate)}</td>
                <td className="shrink">
                  <GrabCell
                    pending={pendingRows.has(key)}
                    status={rowStatus[key]}
                    onGrab={() => onGrab(key, prowlarrGrabBody(r, target))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function SiteTable({ results, target, pendingRows, rowStatus, onGrab, identities, onRoute }: GrabTableProps<SiteResult>) {
  return (
    <TableWrap>
      <table className="table">
        <thead>
          <tr>
            <th>Release</th>
            <th className="num">Size</th>
            <th className="num">S / L</th>
            <th className="shrink" />
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const key = r.magnet || `${i}`;
            return (
              <tr key={key}>
                <td style={{ maxWidth: 440 }}>
                  <div className="break" title={r.title}>
                    {r.detailUrl ? <a href={r.detailUrl} target="_blank" rel="noreferrer noopener">{r.title}</a> : r.title}
                  </div>
                  {identityCell(r.title, identities, onRoute, async (service) => {
                    await onGrab(key, { ...siteGrabBody(r, target), target: service });
                  })}
                </td>
                <td className="num">{bytes(r.sizeBytes)}</td>
                <td className="num">
                  <span className={r.seeders ? "ok-text" : "dim"}>{r.seeders ?? "—"}</span>
                  {" / "}
                  <span className="dim">{r.leechers ?? "—"}</span>
                </td>
                <td className="shrink">
                  <GrabCell
                    pending={pendingRows.has(key)}
                    status={rowStatus[key]}
                    onGrab={() => onGrab(key, siteGrabBody(r, target))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function GrabCell({ pending, status, onGrab }: {
  pending: boolean;
  status?: { tone: "ok" | "err"; text: string };
  onGrab: () => void;
}) {
  return (
    <div className="stack-sm">
      <Button size="sm" icon="download" pending={pending} onClick={onGrab}>Grab</Button>
      {status && <InlineStatus tone={status.tone}>{status.text}</InlineStatus>}
    </div>
  );
}

/**
 * The web widget is a link-out: `results` (when a provider is configured) are
 * rendered inline, but `links` — the always-present "open this on Google"
 * style shortcuts — are the fallback that keeps the widget useful with zero
 * configuration. Nothing here is grabbable; TorHQ never treats an open-web hit
 * as a release.
 */
function WebResultsCard({ data, q, term }: { data: WebSearchResponse; q: Polled<SearchResponse>; term: string }) {
  return (
    <Card title="Web results" subtitle={PROVIDER_LABEL[data.provider]} actions={<RefreshButton q={q} />}>
      <div className="stack">
        {data.degraded && <Alert tone="warn" title="Falling back to links only">{data.degraded}</Alert>}
        <Alert tone="info" title="Link-out only">
          These are links to open in a new tab — TorHQ does not grab from the open web. Switch to Prowlarr or the
          torrent site to send a release to qBittorrent or an *arr.
        </Alert>

        {data.provider === "widget" && data.cx && <GoogleSearchWidget cx={data.cx} query={term} />}

        {data.results.length > 0 && (
          <div className="list">
            {data.results.map((r, i) => (
              <div key={i} className="list-row" style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  <a href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a>
                  <div className="xs dim truncate">{r.displayUrl ?? r.url}</div>
                  {r.snippet && <div className="small muted mt-2 clamp-2">{r.snippet}</div>}
                </div>
                <Icon name="external" size={14} />
              </div>
            ))}
          </div>
        )}

        <div className="row">
          <span className="small muted">Search elsewhere:</span>
          {data.links.map((l) => (
            <a key={l.url} className="btn btn-sm" href={l.url} target="_blank" rel="noreferrer noopener">
              <Icon name="external" size={13} />{l.label}
            </a>
          ))}
        </div>
      </div>
    </Card>
  );
}
