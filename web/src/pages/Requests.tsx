/**
 * Requests — ask Radarr, Sonarr or Lidarr to add something new.
 *
 * TorHQ only submits: pick a route, search that *arr's own lookup, choose the
 * exact candidate (never "the first hit"), fill in the profile/root it needs,
 * and confirm. The *arr owns search, grab, import, rename, and placement from
 * there — this page's job ends at the POST.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { bytes } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, EmptyState, PageHeader, SelectField, cx,
} from "../components/ui.js";
import { Icon, type IconName } from "../components/Icon.js";

type RequestRoute = "movie" | "tv" | "music";

interface Profile { id: number; name: string }
interface RootFolder { id: number; path: string; accessible?: boolean; freeSpace?: number }
interface OptionsResponse {
  profiles: Profile[]; roots: RootFolder[]; metadataProfiles: Profile[];
  defaultRootFolderPath?: string;
}

interface ArrCandidate {
  selectionId: string;
  title: string;
  subtitle?: string;
  year?: number;
  poster?: string;
  overview?: string;
  alreadyAdded: boolean;
}
interface CandidatesResponse { candidates: ArrCandidate[] }

interface RequestBody {
  term: string;
  selectionId: string;
  qualityProfileId: number;
  rootFolderPath: string;
  searchNow?: boolean;
  metadataProfileId?: number;
}
interface SubmitResponse { ok: true; id: number; title: string }

const ROUTE_DEFS: Array<{ id: RequestRoute; label: string; service: string; icon: IconName; placeholder: string }> = [
  { id: "movie", label: "Movie", service: "Radarr", icon: "star", placeholder: "e.g. Blade Runner 2049" },
  { id: "tv", label: "TV show", service: "Sonarr", icon: "queue", placeholder: "e.g. Severance" },
  { id: "music", label: "Artist", service: "Lidarr", icon: "activity", placeholder: "e.g. Radiohead" },
];

export function Requests() {
  // The Catalogue links here as `?route=<movie|tv>&q=<title>&pick=<selectionId>`
  // so a member lands on the right tab with the exact title already chosen.
  const [searchParams] = useSearchParams();
  const [route, setRoute] = useState<RequestRoute>(() => {
    const r = searchParams.get("route");
    return ROUTE_DEFS.some((d) => d.id === r) ? (r as RequestRoute) : "movie";
  });
  // Held until the user changes tab themselves. Not cleared by the effect that
  // reads it, so a re-run of that effect (StrictMode) seeds the same values.
  const seed = useRef<{ q: string; pick: string | null } | null>(
    searchParams.get("q")?.trim() ? { q: searchParams.get("q")!.trim(), pick: searchParams.get("pick") } : null,
  );
  const [pick, setPick] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [committedTerm, setCommittedTerm] = useState<string | null>(null);
  const [profile, setProfile] = useState<number | "">("");
  const [metadataProfile, setMetadataProfile] = useState<number | "">("");
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<ArrCandidate | null>(null);

  const routeDef = ROUTE_DEFS.find((r) => r.id === route)!;
  const isMusic = route === "music";

  const optionsQ = usePolled<OptionsResponse>(`/api/requests/${route}/options`);
  const searchQ = usePolled<CandidatesResponse>(
    committedTerm ? `/api/requests/${route}/search?term=${encodeURIComponent(committedTerm)}` : null,
  );

  const submit = useMutation(
    (body: RequestBody) => apiSend<SubmitResponse>(`/api/requests/${route}`, "POST", body),
  );

  // Switching routes starts over: a candidate/profile chosen for a movie means
  // nothing once the tab says "artist".
  useEffect(() => {
    setTerm(seed.current?.q ?? ""); setCommittedTerm(seed.current?.q ?? null); setSelected(null);
    setPick(seed.current?.pick ?? null);
    setProfile(""); setMetadataProfile(""); setRoot("");
    submit.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // Pre-fill from the first option once they load, but never clobber a choice
  // the user already made (e.g. a background refresh of the same options).
  useEffect(() => {
    const opts = optionsQ.data;
    if (!opts) return;
    setProfile((p) => (p === "" && opts.profiles[0] ? opts.profiles[0].id : p));
    setRoot((r) => (r === "" ? opts.defaultRootFolderPath ?? opts.roots[0]?.path ?? "" : r));
    setMetadataProfile((m) => (m === "" && opts.metadataProfiles[0] ? opts.metadataProfiles[0].id : m));
  }, [optionsQ.data]);

  // Choose the Catalogue's title once the lookup answers; if the *arr didn't
  // return it, the list is left for the user to choose from.
  useEffect(() => {
    if (!pick || !searchQ.data) return;
    const match = searchQ.data.candidates.find((c) => c.selectionId === pick);
    if (match) setSelected(match);
    setPick(null);
  }, [pick, searchQ.data]);

  function runSearch() {
    const t = term.trim();
    if (!t) return;
    setPick(null);
    setSelected(null);
    submit.reset();
    setCommittedTerm(t);
  }

  async function doSubmit() {
    if (!selected || committedTerm == null || profile === "") return;
    const body: RequestBody = {
      term: committedTerm,
      selectionId: selected.selectionId,
      qualityProfileId: profile,
      rootFolderPath: root,
      searchNow: true,
      ...(isMusic ? { metadataProfileId: metadataProfile === "" ? undefined : metadataProfile } : {}),
    };
    const r = await submit.run(body);
    if (r.ok) { setSelected(null); setCommittedTerm(null); setTerm(""); }
  }

  const canSubmit = selected != null && profile !== "" && root !== "" && (!isMusic || metadataProfile !== "");

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle="Ask Radarr, Sonarr or Lidarr to add something new. TorHQ only submits the request — the *arr owns search, grab, import, rename, and final placement."
      />

      <Card flush>
        <div className="tabs" role="group" aria-label="What are you requesting?">
          {ROUTE_DEFS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={cx("tab", route === r.id && "active")}
              aria-pressed={route === r.id}
              onClick={() => { seed.current = null; setRoute(r.id); }}
            >
              <Icon name={r.icon} size={14} />
              {r.label} → {r.service}
            </button>
          ))}
        </div>

        <div className="card-body">
          <Async q={optionsQ} what={`${routeDef.service} options`}>
            {(opts) => (
              <div className="stack">
                <div className="row-nowrap">
                  <div className="searchbar">
                    <Icon name="search" size={14} />
                    <input
                      className="input"
                      value={term}
                      placeholder={routeDef.placeholder}
                      onChange={(e) => setTerm(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                      aria-label={`Search for a ${routeDef.label.toLowerCase()}`}
                    />
                  </div>
                  <Button variant="primary" icon="search" disabled={!term.trim()} onClick={runSearch}>Search</Button>
                </div>

                <div className="grid-2">
                  <SelectField
                    label="Quality profile"
                    value={profile}
                    onChange={(e) => setProfile(Number(e.target.value))}
                  >
                    {opts.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </SelectField>
                  <SelectField
                    label="Root folder"
                    value={root}
                    onChange={(e) => setRoot(e.target.value)}
                  >
                    {opts.roots.map((r) => (
                      <option key={r.id} value={r.path}>
                        {r.path}{r.freeSpace != null ? ` · ${bytes(r.freeSpace)} free` : ""}
                      </option>
                    ))}
                  </SelectField>
                  {isMusic && (
                    <SelectField
                      label="Metadata profile"
                      hint="Lidarr requires one to add an artist."
                      value={metadataProfile}
                      onChange={(e) => setMetadataProfile(Number(e.target.value))}
                    >
                      {opts.metadataProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </SelectField>
                  )}
                </div>
              </div>
            )}
          </Async>
        </div>
      </Card>

      {submit.error && <Alert tone="err" title="Request failed">{submit.error}</Alert>}
      {submit.data && (
        <Alert tone="ok" title="Requested">
          "{submit.data.title}" was sent to {routeDef.service}.
        </Alert>
      )}

      {committedTerm && (
        <Card title={`Results for "${committedTerm}"`}>
          <Async q={searchQ} what="candidates">
            {(data) => (
              data.candidates.length === 0 ? (
                <EmptyState icon="search" title="No matches" message="Try a different search term." />
              ) : (
                <div className="stack">
                  <div className="list">
                    {data.candidates.map((c) => (
                      <label key={c.selectionId} className="list-row" style={{ alignItems: "flex-start", cursor: "pointer" }}>
                        <input
                          type="radio"
                          name="candidate"
                          style={{ marginTop: 4 }}
                          checked={selected?.selectionId === c.selectionId}
                          onChange={() => setSelected(c)}
                          aria-label={`Select ${c.title}`}
                        />
                        {c.poster && (
                          <img
                            src={c.poster}
                            alt=""
                            width={40}
                            style={{ borderRadius: 4, flex: "none" }}
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        )}
                        <div className="grow">
                          <div>
                            <strong>{c.title}</strong>{c.year ? ` (${c.year})` : ""}
                            {c.alreadyAdded && <> <Badge tone="info">already in library</Badge></>}
                          </div>
                          {c.subtitle && <div className="small muted">{c.subtitle}</div>}
                          {c.overview && <div className="small muted mt-2 clamp-2">{c.overview}</div>}
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="row">
                    <Button variant="primary" icon="send" disabled={!canSubmit} pending={submit.pending} onClick={() => void doSubmit()}>
                      Confirm request
                    </Button>
                    {selected?.alreadyAdded && (
                      <span className="small muted">Already in the library — confirming will not duplicate it.</span>
                    )}
                  </div>
                </div>
              )
            )}
          </Async>
        </Card>
      )}
    </>
  );
}
