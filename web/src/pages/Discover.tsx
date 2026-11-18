/**
 * Discover — browse what's out there, instead of searching for a name.
 *
 * Movies and TV come from TMDB, games from RAWG. Opening a title shows the same
 * detail sheet as the Search hub, with the same single action (Add for an
 * admin, Request for a member); there are no separate hand-offs here.
 *
 * Every filter lives in the URL, so a view is a link you can bookmark or send.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Badge, Button, Card, EmptyState, LinkButton, Modal, PageHeader, Skeleton, StaleNotice, cx,
} from "../components/ui.js";
import { AddedToast, DetailSheet, useAddedToast, type HubResult, type Status } from "./Home.js";
import { Icon, type IconName } from "../components/Icon.js";

type Kind = "movie" | "tv" | "game";
type Role = "admin" | "member" | null;

interface SourceInfo { available: boolean; source: string; detail?: string; lists: string[] }
interface SourcesResponse {
  kinds: Record<Kind, SourceInfo>;
  platforms: Array<{ id: number; name: string }>;
}
interface Genre { id: string; name: string }

interface Item {
  kind: Kind;
  id: string;
  title: string;
  year?: number;
  released?: string;
  overview?: string;
  poster?: string;
  backdrop?: string;
  rating?: number;
  votes?: number;
  genres: string[];
  platforms?: string[];
  selectionId?: string;
  inLibrary?: boolean;
}
interface Detail extends Item {
  runtime?: number;
  seasons?: number;
  status?: string;
  homepage?: string;
  developers?: string[];
  sourceUrl?: string;
}
interface BrowseResponse { kind: Kind; items: Item[]; page: number; totalPages: number; libraryChecked: boolean }

const KIND_DEFS: Array<{ id: Kind; label: string; icon: IconName }> = [
  { id: "movie", label: "Movies", icon: "star" },
  { id: "tv", label: "TV shows", icon: "queue" },
  { id: "game", label: "Games", icon: "grid" },
];

const LIST_LABEL: Record<string, string> = {
  trending: "Trending",
  popular: "Popular",
  top_rated: "Top rated",
  upcoming: "Upcoming",
  now_playing: "In cinemas",
  on_the_air: "On the air",
  new: "New releases",
};

/** Map a browsed title to the hub's result shape. Movies key on TMDB; a show needs its TVDB id first. */
function toHubResult(item: Item, id: string): HubResult {
  return {
    kind: item.kind, id, title: item.title, year: item.year, poster: item.poster, overview: item.overview,
    status: item.inLibrary ? "available" : "none",
    owner: item.kind === "movie" ? "radarr" : item.kind === "tv" ? "sonarr" : "prowlarr",
    actionable: item.kind !== "game",
  };
}

export function Discover({ role }: { role: Role }) {
  const [params, setParams] = useSearchParams();
  const kind = (["movie", "tv", "game"].includes(params.get("kind") ?? "") ? params.get("kind") : "movie") as Kind;
  const list = params.get("list") ?? "trending";
  const genre = params.get("genre") ?? "";
  const platform = params.get("platform") ?? "";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const [term, setTerm] = useState(q);
  useEffect(() => { setTerm(q); }, [q]);
  const [open, setOpen] = useState<Item | null>(null);
  const [toast, setToast] = useAddedToast();
  const [overrides, setOverrides] = useState<Record<string, Status>>({});

  const sourcesQ = usePolled<SourcesResponse>("/api/catalogue/sources", 0);
  const source = sourcesQ.data?.kinds[kind];
  const available = source?.available ?? false;

  const genresQ = usePolled<{ genres: Genre[] }>(available ? `/api/catalogue/genres?kind=${kind}` : null, 0);

  const browsePath = (() => {
    if (!available) return null;
    const p = new URLSearchParams({ kind, page: String(page) });
    if (q) p.set("q", q);
    else {
      p.set("list", list);
      if (genre) p.set("genre", genre);
    }
    if (kind === "game" && platform) p.set("platform", platform);
    return `/api/catalogue/browse?${p}`;
  })();
  const browseQ = usePolled<BrowseResponse>(browsePath, 0);

  /** Change some filters; any change but paging goes back to page one. */
  function update(next: Record<string, string | null>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    if (!("page" in next)) p.delete("page");
    setParams(p);
  }

  function chooseKind(k: Kind) {
    // Lists, genres and platforms mean different things per kind; start clean.
    setParams(new URLSearchParams({ kind: k }));
  }

  function runSearch() {
    update({ q: term.trim() || null });
  }

  const lists = source?.lists ?? [];

  return (
    <>
      <PageHeader
        title="Discover"
        subtitle="Browse what's trending, popular and coming soon. Open a title to add or request it, the same as from Search."
      />

      <Card flush>
        <div className="tabs" role="group" aria-label="What are you browsing?">
          {KIND_DEFS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={cx("tab", kind === k.id && "active")}
              aria-pressed={kind === k.id}
              onClick={() => chooseKind(k.id)}
            >
              <Icon name={k.icon} size={14} />
              {k.label}
            </button>
          ))}
        </div>

        {sourcesQ.data && !available ? (
          <div className="card-body">
            <Alert
              tone="info"
              title={`${KIND_DEFS.find((k) => k.id === kind)!.label} aren't set up yet`}
              actions={role === "admin" ? <LinkButton to="/services" icon="plug" size="sm">Open Services</LinkButton> : undefined}
            >
              {role === "admin"
                ? source?.detail
                : `Browsing ${KIND_DEFS.find((k) => k.id === kind)!.label.toLowerCase()} needs a ${source?.source} key, which only the admin can add.`}
            </Alert>
          </div>
        ) : (
          <>
            <div className="toolbar">
              <div className="searchbar grow" style={{ minWidth: 200 }}>
                <Icon name="search" size={14} />
                <input
                  className="input"
                  value={term}
                  placeholder={kind === "game" ? "Search games" : kind === "tv" ? "Search TV shows" : "Search movies"}
                  onChange={(e) => setTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                  aria-label="Search the catalogue"
                />
              </div>
              <Button variant="primary" icon="search" onClick={runSearch}>Search</Button>
              {q && <Button variant="ghost" icon="close" onClick={() => { setTerm(""); update({ q: null }); }}>Clear</Button>}
            </div>

            {!q && (
              <div className="toolbar">
                {lists.map((l) => (
                  <button
                    key={l}
                    type="button"
                    className={cx("chip", list === l && "on")}
                    aria-pressed={list === l}
                    onClick={() => update({ list: l })}
                  >
                    {LIST_LABEL[l] ?? l}
                  </button>
                ))}
                <span className="grow" />
                <label className="small muted" htmlFor="cat-genre">Genre</label>
                <select
                  id="cat-genre"
                  className="select input-sm"
                  style={{ width: "auto" }}
                  value={genre}
                  onChange={(e) => update({ genre: e.target.value || null })}
                  disabled={!genresQ.data}
                >
                  <option value="">Any</option>
                  {genresQ.data?.genres.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            )}

            {kind === "game" && sourcesQ.data && (
              <div className="toolbar">
                <span className="small muted">Platform</span>
                <button
                  type="button"
                  className={cx("chip", !platform && "on")}
                  aria-pressed={!platform}
                  onClick={() => update({ platform: null })}
                >
                  Any
                </button>
                {sourcesQ.data.platforms.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cx("chip", platform === String(p.id) && "on")}
                    aria-pressed={platform === String(p.id)}
                    onClick={() => update({ platform: String(p.id) })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            {!sourcesQ.data ? (
              <div className="card-body"><Skeleton rows={4} /></div>
            ) : (
              <Async q={browseQ} what="the catalogue" skeleton={<div className="card-body"><Skeleton rows={6} /></div>}>
                {(data) => (
                  data.items.length === 0 ? (
                    <div className="card-body">
                      <EmptyState
                        icon="search"
                        title="Nothing here"
                        message={q ? `${source?.source} has nothing matching "${q}".` : "Nothing matches these filters. Try another list or genre."}
                      />
                    </div>
                  ) : (
                    <>
                      <div className={cx("catalogue-grid", kind === "game" && "wide")}>
                        {data.items.map((item) => (
                          <PosterCard key={`${item.kind}:${item.id}`} item={item} onOpen={() => setOpen(item)} />
                        ))}
                      </div>
                      {data.totalPages > 1 && (
                        <div className="pager">
                          <Button size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}
                            aria-label="Previous page">Previous</Button>
                          <span className="small muted num">Page {data.page} of {data.totalPages}</span>
                          <Button size="sm" disabled={page >= data.totalPages} onClick={() => update({ page: String(page + 1) })}
                            aria-label="Next page">Next</Button>
                        </div>
                      )}
                    </>
                  )
                )}
              </Async>
            )}
          </>
        )}
      </Card>

      {browsePath && <StaleNotice q={browseQ} />}

      <p className="xs dim mt-3">
        Film and TV data from TMDB, game data from RAWG. Posters load directly from their image servers.
        This product uses the TMDB API but is not endorsed or certified by TMDB.
      </p>

      {open && (
        <DiscoverSheet
          item={open}
          isAdmin={role === "admin"}
          override={overrides[`${open.kind}:${open.id}`]}
          onClose={() => setOpen(null)}
          onAdded={(_r, status, message) => {
            setOverrides((o) => ({ ...o, [`${open.kind}:${open.id}`]: status }));
            setToast({ id: Date.now(), message });
            setOpen(null);
          }}
        />
      )}
      <AddedToast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}

function PosterCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" className="cat-card" onClick={onOpen} aria-label={`${item.title}${item.year ? ` (${item.year})` : ""}`}>
      <div className="cat-art">
        {item.poster && !broken
          ? <img src={item.poster} alt="" loading="lazy" onError={() => setBroken(true)} />
          : <Icon name={item.kind === "game" ? "grid" : "star"} size={28} />}
        {item.inLibrary && <Badge tone="ok">✓ In library</Badge>}
        {item.rating ? <span className="cat-rating">★ {item.rating.toFixed(1)}</span> : null}
      </div>
      <div className="cat-meta">
        <span className="cat-title clamp-2">{item.title}</span>
        <span className="xs muted truncate">
          {[item.year, item.kind === "game" ? item.platforms?.slice(0, 3).join(" · ") : item.genres.slice(0, 2).join(", ")]
            .filter(Boolean).join(" · ") || " "}
        </span>
      </div>
    </button>
  );
}

/**
 * Resolve the hub id and current status for a browsed title, then hand over to
 * the hub's own sheet. Movies need nothing extra; a show needs the TVDB id that
 * only the detail call carries; games use the RAWG id as is.
 */
function DiscoverSheet({ item, isAdmin, override, onClose, onAdded }: {
  item: Item; isAdmin: boolean; override?: Status; onClose: () => void;
  onAdded: (r: HubResult, status: Status, message: string) => void;
}) {
  const needsDetail = item.kind === "tv";
  const detailQ = usePolled<{ item: Detail }>(needsDetail ? `/api/catalogue/details?kind=tv&id=${item.id}` : null, 0);
  const hubId = item.kind === "movie" ? `tmdb:${item.id}` : item.kind === "tv" ? detailQ.data?.item.selectionId : item.id;
  // The hub's own item call knows the real status (requested, downloading...), not just "in library".
  const hubQ = usePolled<{ item: HubResult }>(hubId ? `/api/hub/item?kind=${item.kind}&id=${encodeURIComponent(hubId)}` : null);

  if (needsDetail && !hubId) {
    return (
      <Modal title={item.title} onClose={onClose} labelledBy="discover-title">
        {detailQ.error
          ? <Alert tone="warn" title="Couldn't load this show">{detailQ.error.message}</Alert>
          : detailQ.data
            ? <Alert tone="info" title="Can't be added yet">This show has no TVDB id, so Sonarr can't add it.</Alert>
            : <Skeleton rows={3} />}
      </Modal>
    );
  }
  if (!hubId) return null;
  const base = toHubResult(item, hubId);
  const known = hubQ.data?.item;
  const result: HubResult = known
    ? { ...base, status: known.status, actionable: known.actionable, subtitle: known.subtitle, owner: known.owner }
    : base;
  return (
    <DetailSheet
      result={override ? { ...result, status: override, actionable: false } : result}
      isAdmin={isAdmin}
      onClose={onClose}
      onAdded={onAdded}
    />
  );
}
