/**
 * Home — the search hub (docs/vision.md).
 *
 * One box over every kind of media, a grid of what was found with its status,
 * and a detail sheet with exactly one primary action: Add (admin) or Request
 * (member). Advanced choices sit behind "Options".
 *
 * Adding reuses the existing server flows and never picks a release itself:
 *   admin  -> /api/acquire/prepare (adds to the *arr) -> /api/acquire/auto-search
 *             (the *arr's own automatic search grabs by itself)
 *   member -> /api/requests/<route> (adds monitored and lets the *arr search)
 * "Choose release" hands an admin to the Get page's release picker.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { Alert, Badge, Button, EmptyState, Modal, SelectField, Skeleton, cx, type Tone } from "../components/ui.js";
import { Icon, type IconName } from "../components/Icon.js";

type Kind = "movie" | "tv" | "music" | "game" | "book" | "audiobook";
type Status = "available" | "requested" | "downloading" | "missing" | "none" | "unknown";
type Owner = "radarr" | "sonarr" | "lidarr" | "intake" | "prowlarr";

interface HubResult {
  kind: Kind; id: string; title: string; year?: number; subtitle?: string;
  poster?: string; overview?: string; status: Status; owner: Owner; actionable: boolean;
}
interface HubSource { kind: Kind; available: boolean; detail?: string }
interface SearchResponse { results: HubResult[]; sources: HubSource[] }
interface AddOptions {
  service: Owner; qualityProfileId?: number; metadataProfileId?: number; rootFolderPath?: string;
  basis?: "saved" | "arr-first" | "none";
}
interface HubItem extends HubResult { backdrop?: string; genres: string[]; addOptions?: AddOptions }

interface Profile { id: number; name: string }
interface RootFolder { id: number; path: string }
interface DefaultsEntry {
  service: string; configured: boolean;
  profiles?: Profile[]; roots?: RootFolder[]; metadataProfiles?: Profile[];
}
interface MemberOptions { profiles: Profile[] }

const KINDS: Array<{ kind: Kind; label: string; icon: IconName }> = [
  { kind: "movie", label: "Movies", icon: "star" },
  { kind: "tv", label: "TV", icon: "queue" },
  { kind: "music", label: "Music", icon: "activity" },
  { kind: "game", label: "Games", icon: "grid" },
  { kind: "book", label: "Books", icon: "book" },
  { kind: "audiobook", label: "Audiobooks", icon: "play" },
];
const KIND_LABEL: Record<Kind, string> = {
  movie: "Movie", tv: "TV", music: "Music", game: "Game", book: "Book", audiobook: "Audiobook",
};
const KIND_ICON = Object.fromEntries(KINDS.map((k) => [k.kind, k.icon])) as Record<Kind, IconName>;
const KIND_PLURAL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<Kind, string>;
const ARR_ROUTE: Partial<Record<Kind, "movie" | "tv" | "music">> = { movie: "movie", tv: "tv", music: "music" };
const ARR_NAME: Partial<Record<Owner, string>> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };

const STATUS_BADGE: Partial<Record<Status, { tone: Tone; label: string }>> = {
  available: { tone: "ok", label: "Available" },
  requested: { tone: "info", label: "Requested" },
  downloading: { tone: "accent", label: "Downloading" },
  missing: { tone: "warn", label: "Missing" },
};

/** The lookup term that finds exactly this title in its *arr (same shape the server resolves hub ids with). */
function lookupTerm(r: Pick<HubResult, "kind" | "id">): string {
  return r.kind === "music" ? `lidarr:${r.id.replace(/^mbid:/, "")}` : r.id;
}

/** Why a result has no add action, in words. Null when it can be added. */
function blockedReason(r: HubResult): string | null {
  if (r.status === "available") return "Already available";
  if (r.status === "downloading") return "Already downloading";
  if (r.status === "requested") return "Already requested";
  if (r.kind === "audiobook" && !r.actionable) {
    return "Adding audiobooks isn't set up yet: it needs Prowlarr and qBittorrent under Services.";
  }
  if (r.kind === "book" && !r.actionable) {
    return "Adding books isn't set up yet: it needs Prowlarr and qBittorrent under Services.";
  }
  if (r.kind === "game") {
    return "Adding games from here isn't set up yet. An admin can still grab one from Raw search.";
  }
  if (!r.actionable) {
    if (r.kind === "tv") return "This show has no TVDB id, so Sonarr can't add it.";
    return `${ARR_NAME[r.owner] ?? "The owning app"} isn't configured, so this can't be added yet.`;
  }
  return null;
}

function Artwork({ r }: { r: Pick<HubResult, "kind" | "poster" | "title"> }) {
  const [broken, setBroken] = useState(false);
  if (r.poster && !broken) {
    return <img className="poster" src={r.poster} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  return <div className="poster poster-empty" aria-hidden="true"><Icon name={KIND_ICON[r.kind]} size={28} /></div>;
}

function StatusBadge({ status }: { status: Status }) {
  const b = STATUS_BADGE[status];
  return b ? <Badge tone={b.tone}>{b.label}</Badge> : null;
}

interface Toast { id: number; message: string }

export function Home({ role }: { role: "admin" | "member" | null }) {
  const isAdmin = role === "admin";
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const urlKinds = useMemo(
    () => (params.get("kinds") ?? "").split(",").filter((k): k is Kind => KINDS.some((x) => x.kind === k)),
    [params],
  );

  // The box is local state so typing never fights the URL; the URL follows after a pause.
  const [text, setText] = useState(urlQ);
  useEffect(() => { setText(urlQ); }, [urlQ]);
  useEffect(() => {
    const t = text.trim();
    if (t === urlQ.trim()) return;
    const h = setTimeout(() => {
      setParams((p) => {
        const next = new URLSearchParams(p);
        if (t) next.set("q", t); else next.delete("q");
        return next;
      }, { replace: true });
    }, 350);
    return () => clearTimeout(h);
  }, [text, urlQ, setParams]);

  function toggleKind(k: Kind | null) {
    setParams((p) => {
      const next = new URLSearchParams(p);
      const set = k === null ? [] : urlKinds.includes(k) ? urlKinds.filter((x) => x !== k) : [...urlKinds, k];
      if (set.length) next.set("kinds", set.join(",")); else next.delete("kinds");
      return next;
    }, { replace: true });
  }

  const query = urlQ.trim();
  const path = query
    ? `/api/hub/search?q=${encodeURIComponent(query)}${urlKinds.length ? `&kinds=${urlKinds.join(",")}` : ""}`
    : null;
  const search = usePolled<SearchResponse>(path);

  // Status changes made here show immediately, before any refetch.
  const [overrides, setOverrides] = useState<Record<string, Status>>({});
  const keyOf = (r: Pick<HubResult, "kind" | "id">) => `${r.kind}:${r.id}`;
  const withOverride = (r: HubResult): HubResult => {
    const s = overrides[keyOf(r)];
    return s ? { ...r, status: s, actionable: false } : r;
  };

  const [open, setOpen] = useState<HubResult | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(h);
  }, [toast]);

  const results = (search.data?.results ?? []).map(withOverride);
  const degraded = (search.data?.sources ?? []).filter((s) => !s.available);

  return (
    <>
      <div className="hero-search">
        <div className="searchbar searchbar-lg">
          <Icon name="search" size={18} />
          <input
            className="input"
            type="search"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search movies, TV, music, games, books…"
            aria-label="Search everything"
          />
        </div>
        <div className="row chips" role="group" aria-label="Filter by kind">
          <button type="button" className={cx("chip", urlKinds.length === 0 && "on")} aria-pressed={urlKinds.length === 0} onClick={() => toggleKind(null)}>
            All
          </button>
          {KINDS.map((k) => (
            <button
              key={k.kind} type="button"
              className={cx("chip", urlKinds.includes(k.kind) && "on")}
              aria-pressed={urlKinds.includes(k.kind)}
              onClick={() => toggleKind(k.kind)}
            >
              <Icon name={k.icon} size={12} />{k.label}
            </button>
          ))}
        </div>
      </div>

      {!query && (
        <EmptyState icon="search" title="Search once, find everything" message="Type a title, an artist or an author. Results from every kind of media show up together, with whether you already have them." />
      )}

      {query && search.initial && <Skeleton rows={5} />}

      {query && search.error && !search.data && (
        <Alert tone="err" title="Search failed">{search.error.message}</Alert>
      )}

      {degraded.length > 0 && (
        <div className="stack-sm mb-2" data-testid="degraded">
          {degraded.map((s) => (
            <Alert key={s.kind} tone="warn" title={`${KIND_PLURAL[s.kind]} couldn't be searched`}>
              {s.detail ?? "This source is unavailable."}
            </Alert>
          ))}
        </div>
      )}

      {query && search.data && results.length === 0 && (
        <EmptyState icon="search" title="No matches" message={`Nothing matched "${query}".`} />
      )}

      {results.length > 0 && (
        <ul className="result-grid" aria-label="Results">
          {results.map((r) => (
            <li key={keyOf(r)}>
              <button type="button" className="result-card" onClick={() => setOpen(r)} aria-label={`${r.title}${r.year ? ` (${r.year})` : ""}, ${KIND_LABEL[r.kind]}`}>
                <div className="poster-wrap">
                  <Artwork r={r} />
                  <span className="poster-status"><StatusBadge status={r.status} /></span>
                </div>
                <div className="result-meta">
                  <div className="result-title clamp-2">{r.title}</div>
                  <div className="small muted">{r.year ? `${r.year} · ` : ""}{KIND_LABEL[r.kind]}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <DetailSheet
          result={withOverride(open)}
          isAdmin={isAdmin}
          onClose={() => setOpen(null)}
          onAdded={(r, status, message) => {
            setOverrides((o) => ({ ...o, [keyOf(r)]: status }));
            setToast({ id: Date.now(), message });
            setOpen(null);
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status" key={toast.id}>
          <Icon name="check" size={15} />
          <span>{toast.message}</span>
          <Link to="/activity">Watch it in Activity</Link>
          <Button variant="ghost" size="sm" icon="close" aria-label="Dismiss" onClick={() => setToast(null)} />
        </div>
      )}
    </>
  );
}

function DetailSheet({ result, isAdmin, onClose, onAdded }: {
  result: HubResult;
  isAdmin: boolean;
  onClose: () => void;
  onAdded: (r: HubResult, status: Status, message: string) => void;
}) {
  const [showOptions, setShowOptions] = useState(false);
  const [quality, setQuality] = useState<number | "">("");
  const [root, setRoot] = useState("");
  const [metaProfile, setMetaProfile] = useState<number | "">("");

  const itemQ = usePolled<{ item: HubItem }>(`/api/hub/item?kind=${result.kind}&id=${encodeURIComponent(result.id)}`);
  const item = itemQ.data?.item;
  const route = ARR_ROUTE[result.kind];
  const arrOwned = route !== undefined;

  // Admins pick from the *arr's real lists; members only get the quality profile.
  const adminOpts = usePolled<{ services: DefaultsEntry[] }>(isAdmin && showOptions && arrOwned ? "/api/acquire/defaults" : null);
  const memberOpts = usePolled<MemberOptions>(!isAdmin && showOptions && route ? `/api/requests/${route}/options` : null);
  const entry = adminOpts.data?.services.find((s) => s.service === result.owner);
  const profiles = isAdmin ? entry?.profiles : memberOpts.data?.profiles;

  const defaults = item?.addOptions;
  const shownQuality = quality === "" ? defaults?.qualityProfileId ?? "" : quality;
  const shownRoot = root || defaults?.rootFolderPath || "";
  const shownMeta = metaProfile === "" ? defaults?.metadataProfileId ?? "" : metaProfile;


  const navigate = useNavigate();
  const isBook = result.kind === "book" || result.kind === "audiobook";
  const booksBase = result.kind === "audiobook" ? "/api/audiobooks" : "/api/books";
  const booksPage = result.kind === "audiobook" ? "/audiobooks" : "/books";
  // A downloaded book waits for one click; the hub shows that click for admins.
  const wantedQ = usePolled<{ items: Array<{ id: string; externalId: string | null; status: string }> }>(
    isAdmin && isBook && (result.status === "downloading" || result.status === "requested") ? `${booksBase}/wanted` : null,
  );
  const readyId = wantedQ.data?.items.find((w) => w.externalId === result.id && w.status === "ready")?.id;
  const approve = useMutation(
    (id: string) => apiSend(`${booksBase}/wanted/${id}/approve`, "POST"),
    { invalidates: [`${booksBase}/wanted`, "/api/hub/search"] },
  );

  const blocked = readyId ? null : blockedReason(result);

  const itemFailed = itemQ.error && !item;
  const disabledReason = blocked ?? (itemFailed ? itemQ.error!.message : null);

  const add = useMutation(async () => {
    if (isBook) {
      await apiSend(`${booksBase}/request`, "POST", {
        title: result.title,
        author: result.subtitle?.split(",")[0]?.trim() || undefined,
        externalId: /^OL\d+W$/.test(result.id) ? result.id : undefined,
      });
      return;
    }
    const term = lookupTerm(result);
    if (isAdmin) {
      const prepared = await apiSend<{ id: number; service: "radarr" | "sonarr" | "lidarr" }>("/api/acquire/prepare", "POST", {
        service: result.owner, term, selectionId: result.id,
        rootFolderPath: root || undefined,
        qualityProfileId: quality === "" ? undefined : quality,
        metadataProfileId: result.kind === "music" && metaProfile !== "" ? metaProfile : undefined,
      });
      // The title is now in its *arr; from here the *arr searches and grabs by itself.
      await apiSend("/api/acquire/auto-search", "POST", { service: prepared.service, id: prepared.id });
      return;
    }
    await apiSend(`/api/requests/${route}`, "POST", {
      term, selectionId: result.id,
      qualityProfileId: quality === "" ? undefined : quality,
      searchNow: true,
    });
  });

  async function onPrimary() {
    if (readyId) {
      const a = await approve.run(readyId);
      if (a.ok) onAdded(result, "downloading", `Approved the import of "${result.title}".`);
      return;
    }
    const r = await add.run();
    if (r.ok && isBook) {
      onAdded(result, "requested", isAdmin ? `Requested "${result.title}".` : `Requested "${result.title}". An admin will pick a release.`);
      if (isAdmin) navigate(booksPage); // the release picker lives there
      return;
    }
    if (r.ok) {
      onAdded(result, "requested", isAdmin
        ? `Added "${result.title}". ${ARR_NAME[result.owner]} is searching for it.`
        : `Requested "${result.title}".`);
    }
  }

  const title = (
    <>{result.title}{result.year ? <span className="muted"> ({result.year})</span> : null}</>
  );
  const overview = item?.overview ?? result.overview;
  const label = isAdmin ? "Add" : "Request";

  return (
    <Modal
      title={title}
      labelledBy="sheet-title"
      onClose={onClose}
      className="sheet"
      footer={
        <>
          {arrOwned && !blocked && (
            <Button variant="ghost" icon="sliders" aria-expanded={showOptions} onClick={() => setShowOptions((v) => !v)}>
              Options
            </Button>
          )}
          <Button
            variant="primary"
            icon={disabledReason ? undefined : readyId ? "check" : "plus"}
            pending={add.pending || approve.pending}
            disabled={disabledReason !== null}
            onClick={() => void onPrimary()}
          >
            {readyId ? "Approve import" : blocked && (result.status === "available" || result.status === "requested" || result.status === "downloading")
              ? blocked
              : disabledReason ? `${label} unavailable` : label}
          </Button>
        </>
      }
    >
      <div className="sheet-body">
        <Artwork r={result} />
        <div className="stack-sm grow">
          <div className="row">
            <Badge tone="accent">{KIND_LABEL[result.kind]}</Badge>
            <StatusBadge status={result.status} />
            {result.subtitle && <span className="small muted">{result.subtitle}</span>}
          </div>
          {item?.genres?.length ? <div className="small muted">{item.genres.join(" · ")}</div> : null}
          {overview && <p className="sheet-overview">{overview}</p>}
        </div>
      </div>

      {disabledReason && !["available", "requested", "downloading"].includes(result.status) && (
        <Alert tone="info" title="Can't be added yet">{disabledReason}</Alert>
      )}
      {(add.error || approve.error) && <Alert tone="err" title="Couldn't add it">{add.error ?? approve.error}</Alert>}

      {showOptions && arrOwned && !blocked && (
        <div className="stack options-panel" aria-label="Options">
          <div className="grid-2">
            <SelectField
              label="Quality profile"
              value={shownQuality}
              onChange={(e) => setQuality(Number(e.target.value))}
            >
              {(profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              {!profiles && shownQuality !== "" && <option value={shownQuality}>Saved default</option>}
            </SelectField>
            {isAdmin && (
              <SelectField label="Root folder" value={shownRoot} onChange={(e) => setRoot(e.target.value)}>
                {(entry?.roots ?? []).map((r) => <option key={r.id} value={r.path}>{r.path}</option>)}
                {!entry?.roots && shownRoot && <option value={shownRoot}>{shownRoot}</option>}
              </SelectField>
            )}
            {isAdmin && result.kind === "music" && (
              <SelectField label="Metadata profile" value={shownMeta} onChange={(e) => setMetaProfile(Number(e.target.value))}>
                {(entry?.metadataProfiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </SelectField>
            )}
          </div>
          <div className="small muted">
            Prefilled from your saved defaults{defaults?.basis === "arr-first" ? " (none saved, so the first the app offers)" : ""}.
          </div>
          {isAdmin && (
            <div>
              <Link
                className="btn"
                style={{ textDecoration: "none" }}
                to={`/get?q=${encodeURIComponent(result.title)}&service=${result.owner}&pick=${encodeURIComponent(result.id)}`}
              >
                <Icon name="download" size={15} />Choose release
              </Link>
              <div className="small muted mt-2">Skips the automatic search and lets you pick a specific release.</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
