/**
 * Get — the one-stop acquisition loop.
 *
 * Four steps, in the only order that actually ends with the file in the right
 * folder:
 *
 *   1. find the *thing* (one box over Radarr, Sonarr and Lidarr lookups)
 *   2. confirm where it goes, and add it to that *arr
 *   3. pick a release from the *arr's own interactive search
 *   4. grab it — the *arr downloads, imports, renames and files it
 *
 * The order is the point. Grabbing a torrent for something an *arr has never
 * heard of leaves it unimported forever, which is what the Search page does on
 * its own. Here the library entry always exists before the release is chosen,
 * so the *arr owns the download from the first byte.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { bytes, plural } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, Checkbox, EmptyState, PageHeader,
  SelectField, Skeleton, TableWrap, cx,
} from "../components/ui.js";
import { Icon, type IconName } from "../components/Icon.js";
import { RootDriveSelect, type DriveRef, type DriveRoot } from "../components/DrivePicker.js";

type ArrService = "radarr" | "sonarr" | "lidarr";

const SERVICE_META: Record<ArrService, { label: string; kind: string; icon: IconName }> = {
  radarr: { label: "Radarr", kind: "Movie", icon: "star" },
  sonarr: { label: "Sonarr", kind: "TV", icon: "queue" },
  lidarr: { label: "Lidarr", kind: "Music", icon: "activity" },
};

const CONTENT_NAME: Record<ArrService, string> = { radarr: "movies", sonarr: "TV", lidarr: "music" };

interface Candidate {
  service: ArrService;
  selectionId: string;
  title: string;
  subtitle?: string;
  year?: number;
  poster?: string;
  overview?: string;
  alreadyAdded: boolean;
}
interface LookupResponse {
  candidates: Candidate[];
  unavailable: Array<{ service: ArrService; detail: string }>;
}

interface Profile { id: number; name: string }
type DefaultsEntry =
  | { service: ArrService; configured: false; detail: string }
  | {
      service: ArrService; configured: true;
      defaults: { rootFolderPath?: string; qualityProfileId?: number; metadataProfileId?: number };
      profiles: Profile[]; roots: DriveRoot[]; metadataProfiles: Profile[]; drives: DriveRef[];
    };
interface DefaultsResponse { services: DefaultsEntry[] }

interface Prepared {
  ok: true; id: number; title: string; service: ArrService;
  rootFolderPath: string; qualityProfileId: number; metadataProfileId?: number;
}

interface Season { seasonNumber: number; monitored: boolean; episodeFileCount?: number; totalEpisodeCount?: number }
interface Album { id: number; title: string; year?: number; monitored: boolean }
type TargetsResponse =
  | { kind: "none" }
  | { kind: "season"; seasons: Season[] }
  | { kind: "album"; albums: Album[] };

interface Release {
  guid: string; indexerId: number; indexer: string; title: string;
  size: number; seeders: number | null; leechers: number | null;
  protocol: string; quality?: string; ageHours?: number;
  rejected: boolean; rejections: string[]; infoUrl?: string;
}
interface SearchJobView {
  id: string; service: ArrService; label: string;
  status: "running" | "done" | "error";
  elapsedMs: number; releases: Release[] | null; error: string | null;
}

export function Acquire() {
  // The Catalogue links here as `?q=<title>&service=<arr>&pick=<selectionId>`:
  // the lookup runs straight away and the exact title is chosen once it answers.
  const [searchParams] = useSearchParams();
  const [term, setTerm] = useState(() => searchParams.get("q") ?? "");
  const [committed, setCommitted] = useState<string | null>(() => searchParams.get("q")?.trim() || null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [pick, setPick] = useState(() => {
    const id = searchParams.get("pick");
    return id ? { selectionId: id, service: searchParams.get("service") } : null;
  });

  // Placement, seeded from the saved defaults once a candidate is chosen.
  const [root, setRoot] = useState("");
  const [profile, setProfile] = useState<number | "">("");
  const [metaProfile, setMetaProfile] = useState<number | "">("");
  const [remember, setRemember] = useState(false);

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [season, setSeason] = useState<number | "">("");
  const [album, setAlbum] = useState<number | "">("");
  const [token, setToken] = useState<string | null>(null);
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const lookupQ = usePolled<LookupResponse>(
    committed ? `/api/acquire/lookup?q=${encodeURIComponent(committed)}` : null,
  );
  const defaultsQ = usePolled<DefaultsResponse>("/api/acquire/defaults");

  const service = selected?.service ?? null;
  const entry = defaultsQ.data?.services.find((s) => s.service === service);
  const options = entry?.configured ? entry : null;
  const rootDrive = options?.roots.find((r) => r.path === root)?.drive;

  const targetsQ = usePolled<TargetsResponse>(
    prepared && prepared.service !== "radarr"
      ? `/api/acquire/targets?service=${prepared.service}&id=${prepared.id}`
      : null,
  );

  // Poll the release search only while it is running; a finished job is fetched
  // once and then left alone.
  const [searchDone, setSearchDone] = useState(false);
  const searchQ = usePolled<SearchJobView>(
    token ? `/api/acquire/search/${token}` : null,
    searchDone ? 0 : 3000,
  );
  useEffect(() => {
    if (searchQ.data && searchQ.data.status !== "running") setSearchDone(true);
  }, [searchQ.data]);

  // Apply the Catalogue's pick once, when the lookup first answers. If the *arr
  // didn't return that exact title the list is simply left for the user.
  useEffect(() => {
    if (!pick || !lookupQ.data) return;
    const match = lookupQ.data.candidates.find(
      (c) => c.selectionId === pick.selectionId && (!pick.service || c.service === pick.service),
    );
    if (match) setSelected(match);
    setPick(null);
  }, [pick, lookupQ.data]);

  const prepare = useMutation((body: unknown) => apiSend<Prepared>("/api/acquire/prepare", "POST", body));
  const startSearch = useMutation((body: unknown) => apiSend<SearchJobView>("/api/acquire/search", "POST", body));
  const grab = useMutation(
    (body: unknown) => apiSend<{ ok: true }>("/api/acquire/grab", "POST", body),
    { invalidates: ["/api/queue", "/api/downloads", "/api/jobs"] },
  );

  // Seed placement from this *arr's saved defaults (falling back to its first
  // root/profile) whenever the chosen candidate's service changes.
  useEffect(() => {
    if (!options) return;
    const d = options.defaults;
    setRoot(d.rootFolderPath ?? options.roots[0]?.path ?? "");
    setProfile(d.qualityProfileId ?? options.profiles[0]?.id ?? "");
    setMetaProfile(d.metadataProfileId ?? options.metadataProfiles[0]?.id ?? "");
  }, [options, service]);

  /** Everything downstream of a choice is invalid once that choice changes. */
  function resetFrom(stage: "candidate" | "release") {
    setToken(null); setSearchDone(false); setGrabbed(null);
    startSearch.reset(); grab.reset();
    if (stage === "candidate") {
      setPrepared(null); setSeason(""); setAlbum(""); prepare.reset();
    }
  }

  function runLookup() {
    const t = term.trim();
    if (!t) return;
    setPick(null);
    setSelected(null);
    resetFrom("candidate");
    setCommitted(t);
  }

  function chooseCandidate(c: Candidate) {
    setSelected(c);
    resetFrom("candidate");
  }

  async function doPrepare() {
    if (!selected || !committed || profile === "" || !root) return;
    const r = await prepare.run({
      service: selected.service,
      term: committed,
      selectionId: selected.selectionId,
      rootFolderPath: root,
      qualityProfileId: profile,
      metadataProfileId: selected.service === "lidarr" && metaProfile !== "" ? metaProfile : undefined,
      remember,
    });
    if (r.ok) {
      setPrepared(r.data);
      // Radarr has nothing further to choose, so go straight to the releases.
      if (r.data.service === "radarr") void beginSearch(r.data, {});
    }
  }

  async function beginSearch(p: Prepared, opts: { seasonNumber?: number; albumId?: number }) {
    resetFrom("release");
    const r = await startSearch.run({
      service: p.service,
      id: p.id,
      label: p.title,
      seasonNumber: opts.seasonNumber,
      albumId: opts.albumId,
    });
    if (r.ok) setToken(r.data.id);
  }

  async function doGrab(rel: Release) {
    if (!prepared) return;
    const r = await grab.run({
      service: prepared.service,
      guid: rel.guid,
      indexerId: rel.indexerId,
      title: rel.title,
      override: rel.rejected,
    });
    if (r.ok) setGrabbed(rel.guid);
  }

  const job = searchQ.data;
  const allReleases = job?.releases ?? [];
  const accepted = allReleases.filter((r) => !r.rejected);
  const rejected = allReleases.filter((r) => r.rejected);
  const visible = showRejected ? allReleases : accepted;

  return (
    <>
      <PageHeader
        title="Get"
        subtitle="Find it, add it to the right *arr, pick a release, and let the *arr download, import and file it. The library entry always exists before the grab — which is what makes it land in the right folder."
      />

      {/* ---- 1. find the thing ---------------------------------------- */}
      <Card title="1. What do you want?" icon="search">
        <div className="row-nowrap">
          <div className="searchbar">
            <Icon name="search" size={14} />
            <input
              className="input"
              value={term}
              placeholder="e.g. Dune Part Two, Severance, Radiohead"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runLookup(); }}
              aria-label="Search Radarr, Sonarr and Lidarr"
            />
          </div>
          <Button variant="primary" icon="search" disabled={!term.trim()} onClick={runLookup}>Search</Button>
        </div>

        {lookupQ.data?.unavailable.length ? (
          <Alert tone="warn" title="Not everything could be searched">
            {lookupQ.data.unavailable.map((u) => (
              <div key={u.service} className="small">{SERVICE_META[u.service].label}: {u.detail}</div>
            ))}
          </Alert>
        ) : null}

        {committed && (
          <Async q={lookupQ} what="matches">
            {(data) => (
              data.candidates.length === 0 ? (
                <EmptyState icon="search" title="No matches" message={`Nothing in Radarr, Sonarr or Lidarr matched "${committed}".`} />
              ) : (
                <div className="list mt-2">
                  {data.candidates.map((c) => {
                    const m = SERVICE_META[c.service];
                    const isSel = selected?.selectionId === c.selectionId && selected.service === c.service;
                    return (
                      <label
                        key={`${c.service}:${c.selectionId}`}
                        className={cx("list-row", isSel && "active")}
                        style={{ alignItems: "flex-start", cursor: "pointer" }}
                      >
                        <input
                          type="radio"
                          name="acquire-candidate"
                          style={{ marginTop: 4 }}
                          checked={isSel}
                          onChange={() => chooseCandidate(c)}
                          aria-label={`Select ${c.title}`}
                        />
                        {c.poster && (
                          <img
                            src={c.poster} alt="" width={40}
                            style={{ borderRadius: 4, flex: "none" }}
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        )}
                        <div className="grow">
                          <div>
                            <strong>{c.title}</strong>{c.year ? ` (${c.year})` : ""}{" "}
                            <Badge tone="accent" title={`Handled by ${m.label}`}>{m.kind}</Badge>
                            {c.alreadyAdded && <> <Badge tone="info">in library</Badge></>}
                          </div>
                          {c.subtitle && <div className="small muted">{c.subtitle}</div>}
                          {c.overview && <div className="small muted mt-2 clamp-2">{c.overview}</div>}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )
            )}
          </Async>
        )}
      </Card>

      {/* ---- 2. where it goes ------------------------------------------ */}
      {selected && (
        <Card
          title={`2. Where does "${selected.title}" go?`}
          icon="folder"
          subtitle={
            selected.alreadyAdded
              ? `Already in ${SERVICE_META[selected.service].label} — its existing folder and profile are kept.`
              : `It will be added to ${SERVICE_META[selected.service].label}, monitored, without starting an automatic search.`
          }
        >
          {entry && !entry.configured ? (
            <Alert tone="err" title={`${SERVICE_META[selected.service].label} is unavailable`}>{entry.detail}</Alert>
          ) : !options ? (
            <Skeleton rows={2} />
          ) : (
            <div className="stack">
              <div className="grid-2">
                <RootDriveSelect
                  roots={options.roots}
                  drives={options.drives}
                  value={root}
                  onChange={setRoot}
                  service={SERVICE_META[selected.service].label}
                />
                <SelectField label="Quality profile" value={profile} onChange={(e) => setProfile(Number(e.target.value))}>
                  {options.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </SelectField>
                {selected.service === "lidarr" && (
                  <SelectField
                    label="Metadata profile"
                    hint="Lidarr requires one to add an artist."
                    value={metaProfile}
                    onChange={(e) => setMetaProfile(Number(e.target.value))}
                  >
                    {options.metadataProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </SelectField>
                )}
              </div>
              <Checkbox
                label={
                  rootDrive
                    ? `Remember these as the defaults for ${SERVICE_META[selected.service].label}, `
                      + `and make ${rootDrive.label} the default drive for ${CONTENT_NAME[selected.service]}`
                    : `Remember these as the defaults for ${SERVICE_META[selected.service].label}`
                }
                checked={remember}
                onChange={setRemember}
              />
              <div className="row">
                <Button
                  variant="primary"
                  icon="check"
                  pending={prepare.pending}
                  disabled={!root || profile === ""}
                  onClick={() => void doPrepare()}
                >
                  {selected.alreadyAdded ? "Continue" : "Add and continue"}
                </Button>
                {prepare.error && <span className="small err">{prepare.error}</span>}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ---- 2b. season / album (Sonarr and Lidarr only) ---------------- */}
      {prepared && prepared.service !== "radarr" && (
        <Card
          title={prepared.service === "sonarr" ? "Which season?" : "Which album?"}
          icon="filter"
          subtitle={
            prepared.service === "sonarr"
              ? "Sonarr searches one season at a time."
              : "Leave blank to search everything by this artist."
          }
        >
          <Async q={targetsQ} what="options">
            {(t) => (
              <div className="row-nowrap">
                {t.kind === "season" && (
                  <SelectField label="Season" value={season} onChange={(e) => setSeason(Number(e.target.value))}>
                    <option value="">Choose a season…</option>
                    {t.seasons.map((s) => (
                      <option key={s.seasonNumber} value={s.seasonNumber}>
                        {s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`}
                        {s.totalEpisodeCount != null ? ` · ${s.episodeFileCount ?? 0}/${s.totalEpisodeCount}` : ""}
                      </option>
                    ))}
                  </SelectField>
                )}
                {t.kind === "album" && (
                  <SelectField label="Album" value={album} onChange={(e) => setAlbum(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">Everything by this artist</option>
                    {t.albums.map((a) => (
                      <option key={a.id} value={a.id}>{a.title}{a.year ? ` (${a.year})` : ""}</option>
                    ))}
                  </SelectField>
                )}
                <Button
                  variant="primary"
                  icon="search"
                  pending={startSearch.pending}
                  disabled={prepared.service === "sonarr" && season === ""}
                  onClick={() => void beginSearch(prepared, {
                    seasonNumber: season === "" ? undefined : season,
                    albumId: album === "" ? undefined : album,
                  })}
                >
                  Find releases
                </Button>
              </div>
            )}
          </Async>
        </Card>
      )}

      {startSearch.error && <Alert tone="err" title="Could not start the search">{startSearch.error}</Alert>}

      {/* ---- 3. pick a release ----------------------------------------- */}
      {token && (
        <Card
          title="3. Pick a release"
          icon="download"
          subtitle={prepared ? `${SERVICE_META[prepared.service].label} searched its indexers for "${prepared.title}".` : undefined}
          actions={
            rejected.length > 0 && job?.status === "done" ? (
              <Checkbox
                label={`Show ${rejected.length} rejected by the profile`}
                checked={showRejected}
                onChange={setShowRejected}
              />
            ) : undefined
          }
        >
          {!job || job.status === "running" ? (
            <div className="stack">
              <div className="small muted">
                <Icon name="refresh" size={12} /> Searching every indexer — this usually takes one to three minutes
                {job ? ` (${Math.round(job.elapsedMs / 1000)}s)` : ""}.
              </div>
              <Skeleton rows={4} />
            </div>
          ) : job.status === "error" ? (
            <Alert tone="err" title="The search failed">{job.error}</Alert>
          ) : allReleases.length === 0 ? (
            <EmptyState
              icon="search"
              title="No releases found"
              message="No indexer returned anything for this. Check Prowlarr's indexers, or try a different season."
            />
          ) : (
            <>
              {grab.error && <Alert tone="err" title="Grab failed">{grab.error}</Alert>}
              {grabbed && (
                <Alert tone="ok" title="Sent to the *arr">
                  {SERVICE_META[prepared!.service].label} is downloading it now. It will import and file it
                  under <code>{prepared!.rootFolderPath}</code> when it finishes — watch it on the Queue page.
                </Alert>
              )}
              <div className="small muted mb-2">
                {plural(accepted.length, "release")} your profile accepts
                {rejected.length > 0 ? `, ${rejected.length} rejected` : ""}.
              </div>
              {visible.length === 0 ? (
                // Everything found was rejected and the toggle is off. An empty
                // table under "111 rejected" reads as a failure; say what is
                // actually true and where the releases went.
                <EmptyState
                  icon="filter"
                  title="Nothing your quality profile accepts"
                  message={
                    `All ${rejected.length} releases were refused by ${SERVICE_META[prepared!.service].label}'s `
                    + "quality profile — most often because the file you already have is as good or better. "
                    + "Turn on “Show rejected” to see them and the reason for each; any of them can still "
                    + "be grabbed as a deliberate override."
                  }
                  actions={<Button icon="filter" onClick={() => setShowRejected(true)}>Show rejected</Button>}
                />
              ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Release</th>
                      <th>Quality</th>
                      <th className="num">Size</th>
                      <th className="num">Seed</th>
                      <th>Indexer</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.guid} className={cx(r.rejected && "muted-row")}>
                        <td>
                          <div className="mono small">{r.title}</div>
                          {r.rejected && (
                            <div className="small err" title={r.rejections.join("; ")}>
                              {r.rejections[0] ?? "rejected by the quality profile"}
                              {r.rejections.length > 1 ? ` (+${r.rejections.length - 1} more)` : ""}
                            </div>
                          )}
                        </td>
                        <td>{r.quality ?? "—"}</td>
                        <td className="num">{bytes(r.size)}</td>
                        <td className="num">{r.seeders ?? "—"}</td>
                        <td className="small">{r.indexer}</td>
                        <td className="num">
                          <Button
                            size="sm"
                            variant={r.rejected ? "default" : "primary"}
                            icon="download"
                            pending={grab.pending}
                            disabled={grabbed === r.guid}
                            onClick={() => void doGrab(r)}
                          >
                            {grabbed === r.guid ? "Sent" : r.rejected ? "Grab anyway" : "Grab"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
}
