/**
 * Choose release — the hub sheet's way to pick a specific release instead of
 * letting the *arr's automatic search decide (it replaces the old Get page).
 *
 * The order is the one that ends with the file in the right folder: the title
 * is added to its *arr first (monitored, no automatic search), then for TV a
 * season and for music an album (or the whole artist) is chosen, then the
 * *arr's own interactive search runs and the release picked here is grabbed
 * *by the *arr*, which downloads, imports, renames and files it.
 */
import { useEffect, useState } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { bytes, plural } from "../lib/format.js";
import { Alert, Button, Checkbox, EmptyState, SelectField, Skeleton, cx } from "./ui.js";
import { Icon } from "./Icon.js";

type ArrService = "radarr" | "sonarr" | "lidarr";
const ARR_NAME: Record<ArrService, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };

interface Prepared { ok: true; id: number; title: string; service: ArrService }
interface Season { seasonNumber: number; monitored: boolean; episodeFileCount?: number; totalEpisodeCount?: number }
interface Album { id: number; title: string; year?: number }
type Targets = { kind: "none" } | { kind: "season"; seasons: Season[] } | { kind: "album"; albums: Album[] };
interface Release {
  guid: string; indexerId: number; indexer: string; title: string; size: number;
  seeders: number | null; quality?: string; rejected: boolean; rejections: string[];
}
interface SearchJob { id: string; status: "running" | "done" | "error"; elapsedMs: number; releases: Release[] | null; error: string | null }

export function ChooseRelease({ service, term, selectionId, placement, onGrabbed, onCancel }: {
  service: ArrService;
  /** Lookup term and id the hub resolved this title with (the same ones Add uses). */
  term: string;
  selectionId: string;
  placement: { rootFolderPath?: string; qualityProfileId?: number; metadataProfileId?: number };
  onGrabbed: (message: string) => void;
  onCancel: () => void;
}) {
  const name = ARR_NAME[service];
  const prepare = useMutation((body: unknown) => apiSend<Prepared>("/api/acquire/prepare", "POST", body));
  const start = useMutation((body: unknown) => apiSend<SearchJob>("/api/acquire/search", "POST", body));
  const grab = useMutation(
    (body: unknown) => apiSend<{ ok: true }>("/api/acquire/grab", "POST", body),
    { invalidates: ["/api/queue", "/api/downloads", "/api/activity", "/api/hub/search"] },
  );
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [season, setSeason] = useState<number | "">("");
  const [album, setAlbum] = useState<number | "">("");
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  const targets = usePolled<Targets>(prepared && service !== "radarr" ? `/api/acquire/targets?service=${service}&id=${prepared.id}` : null);
  const job = usePolled<SearchJob>(token ? `/api/acquire/search/${token}` : null, done ? 0 : 3000);
  useEffect(() => { if (job.data && job.data.status !== "running") setDone(true); }, [job.data]);

  async function search(p: Prepared, opts: { seasonNumber?: number; albumId?: number }) {
    setToken(null); setDone(false); grab.reset();
    const r = await start.run({ service: p.service, id: p.id, label: p.title, ...opts });
    if (r.ok) setToken(r.data.id);
  }

  // Step 1 runs as soon as the panel opens: make sure the title is in its *arr.
  useEffect(() => {
    let live = true;
    void prepare.run({ service, term, selectionId, ...placement }).then((r) => {
      if (!live || !r.ok) return;
      setPrepared(r.data);
      if (service === "radarr") void search(r.data, {});
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doGrab(rel: Release) {
    if (!prepared) return;
    const r = await grab.run({ service, guid: rel.guid, indexerId: rel.indexerId, title: rel.title, override: rel.rejected });
    if (r.ok) onGrabbed(`${name} is downloading "${rel.title}". It will file it when it finishes.`);
  }

  const all = job.data?.releases ?? [];
  const accepted = all.filter((r) => !r.rejected);
  const rejected = all.filter((r) => r.rejected);
  const visible = showRejected ? all : accepted;

  return (
    <div className="stack options-panel" aria-label="Choose release">
      <div className="row">
        <strong>Choose a release</strong>
        <span className="small muted">{name} searches its indexers and you pick one; {name} then downloads and files it.</span>
        <div className="spacer" />
        <Button size="sm" variant="ghost" onClick={onCancel}>Back</Button>
      </div>

      {prepare.pending && <div className="small muted">Adding it to {name}…</div>}
      {prepare.error && <Alert tone="err" title={`Couldn't add it to ${name}`}>{prepare.error}</Alert>}

      {prepared && service !== "radarr" && (
        targets.data == null ? (targets.error ? <Alert tone="err" title="Couldn't load the choices">{targets.error.message}</Alert> : <Skeleton rows={1} />) : (
          <div className="row">
            {targets.data.kind === "season" && (
              <SelectField label="Season" value={season} onChange={(e) => setSeason(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">Choose a season…</option>
                {targets.data.seasons.map((s) => (
                  <option key={s.seasonNumber} value={s.seasonNumber}>
                    {s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`}
                    {s.totalEpisodeCount != null ? ` · ${s.episodeFileCount ?? 0} of ${s.totalEpisodeCount} episodes here` : ""}
                  </option>
                ))}
              </SelectField>
            )}
            {targets.data.kind === "album" && (
              <SelectField label="Album" value={album} onChange={(e) => setAlbum(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">Everything by this artist</option>
                {targets.data.albums.map((a) => <option key={a.id} value={a.id}>{a.title}{a.year ? ` (${a.year})` : ""}</option>)}
              </SelectField>
            )}
            <Button
              variant="primary" icon="search" pending={start.pending}
              disabled={service === "sonarr" && season === ""}
              onClick={() => void search(prepared, { seasonNumber: season === "" ? undefined : season, albumId: album === "" ? undefined : album })}
            >
              Find releases
            </Button>
          </div>
        )
      )}

      {start.error && <Alert tone="err" title="Couldn't start the search">{start.error}</Alert>}

      {token && (!job.data || job.data.status === "running") && (
        <div className="stack-sm">
          <div className="small muted">
            <Icon name="refresh" size={12} /> {name} is asking every indexer; this usually takes one to three minutes
            {job.data ? ` (${Math.round(job.data.elapsedMs / 1000)}s)` : ""}.
          </div>
          <Skeleton rows={3} />
        </div>
      )}
      {job.data?.status === "error" && <Alert tone="err" title="The search failed">{job.data.error}</Alert>}
      {job.data?.status === "done" && (
        all.length === 0 ? (
          <EmptyState icon="search" title="No releases found" message={`No indexer had anything for this${service === "sonarr" ? " season" : ""}.`} />
        ) : (
          <div className="stack-sm">
            <div className="row">
              <span className="small muted">
                {plural(accepted.length, "release")} {name} would accept{rejected.length ? `, ${rejected.length} it would refuse` : ""}.
              </span>
              <div className="spacer" />
              {rejected.length > 0 && <Checkbox label="Show refused" checked={showRejected} onChange={setShowRejected} />}
            </div>
            {grab.error && <Alert tone="err" title="Grab failed">{grab.error}</Alert>}
            {visible.length === 0 ? (
              <EmptyState
                icon="filter" title={`Nothing ${name} would accept`}
                message="Usually because the copy you already have is as good or better. Show the refused ones to see why; any can still be grabbed on purpose."
                actions={<Button size="sm" onClick={() => setShowRejected(true)}>Show refused</Button>}
              />
            ) : (
              <ul className="list release-list" aria-label="Releases">
                {visible.map((r) => (
                  <li key={r.guid} className={cx("list-row", r.rejected && "muted-row")}>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="mono small break">{r.title}</div>
                      <div className="small muted">
                        {[r.quality, bytes(r.size), r.seeders != null ? plural(r.seeders, "seeder") : null, r.indexer].filter(Boolean).join(" · ")}
                      </div>
                      {r.rejected && <div className="small err-text">{r.rejections[0] ?? `${name} would refuse it`}</div>}
                    </div>
                    <Button size="sm" variant={r.rejected ? "default" : "primary"} icon="download" pending={grab.pending}
                      aria-label={`Grab ${r.title}`} onClick={() => void doGrab(r)}>
                      {r.rejected ? "Grab anyway" : "Grab"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      )}
    </div>
  );
}
