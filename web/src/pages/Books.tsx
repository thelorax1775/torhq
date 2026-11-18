/**
 * Books — the one kind with no *arr, so TorHQ's own intake owns it.
 *
 * Everyone: search for a book and ask for it, and watch the state of their own
 * requests. Admin: the same page shows every request; pick a release (best match
 * pre-selected), watch it download, and approve the import preview with one
 * click. Nothing is moved until that click — the preview is a dry run.
 *
 * Backed by `/api/hub/search` (Open Library + "do we have it") and `/api/books/*`.
 */
import { useEffect, useState } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { ago, bytes } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, EmptyState, LinkButton, Modal, PageHeader, TableWrap, type Tone,
} from "../components/ui.js";

type Role = "admin" | "member" | null;

interface HubResult {
  kind: string; id: string; title: string; year?: number; subtitle?: string; poster?: string;
  status: string; actionable: boolean;
}
interface HubSearch { results: HubResult[]; sources: Array<{ kind: string; available: boolean; detail?: string }> }

type WantedStatus = "requested" | "grabbed" | "ready" | "importing" | "imported" | "failed" | "declined";
interface Preview {
  destPath: string; sourcePath: string; importMode: "move" | "link";
  entries: Array<{ name: string; size: number; isDir: boolean }>; totalBytes: number; warnings: string[]; targetName: string;
}
interface Wanted {
  id: string; title: string; author: string | null; externalId: string | null; status: WantedStatus;
  requestedBy: string; createdAt: number; updatedAt: number;
  releaseTitle?: string | null; releaseFormat?: string | null; error?: string | null; preview?: Preview | null;
}
interface Release {
  guid: string; indexerId: number; indexer: string; title: string; size: number | null;
  seeders: number | null; format: string | null; matches: boolean; alive: boolean;
  magnetUrl?: string; downloadUrl?: string;
}
interface SearchResponse { query: string; releases: Release[]; bestGuid: string | null }
interface BooksStatus { ready: boolean; problems: string[]; category: string }

const STATUS_LABEL: Record<WantedStatus, string> = {
  requested: "Requested", grabbed: "Downloading", ready: "Ready to import", importing: "Importing",
  imported: "Available", failed: "Needs attention", declined: "Declined",
};
const STATUS_TONE: Record<WantedStatus, Tone> = {
  requested: "info", grabbed: "info", ready: "warn", importing: "info", imported: "ok", failed: "err", declined: "neutral",
};
const HUB_TONE: Record<string, Tone> = {
  available: "ok", requested: "info", downloading: "info", missing: "warn", none: "neutral", unknown: "neutral",
};

export function Books({ role }: { role: Role }) {
  const isAdmin = role === "admin";
  const [term, setTerm] = useState("");
  const [committed, setCommitted] = useState<string | null>(null);
  const [picking, setPicking] = useState<Wanted | null>(null);

  const searchQ = usePolled<HubSearch>(committed ? `/api/hub/search?q=${encodeURIComponent(committed)}&kinds=book` : null);
  const wantedQ = usePolled<{ items: Wanted[] }>("/api/books/wanted", 10000);
  const statusQ = usePolled<BooksStatus>(isAdmin ? "/api/books/status" : null);

  const request = useMutation(
    (r: HubResult) => apiSend<{ ok: true; existing: boolean }>("/api/books/request", "POST", {
      title: r.title, author: r.subtitle?.split(",")[0]?.trim() || undefined, externalId: /^OL\d+W$/.test(r.id) ? r.id : undefined,
    }),
    { invalidates: ["/api/books/wanted", "/api/hub/search"] },
  );
  const approve = useMutation(
    (id: string) => apiSend(`/api/books/wanted/${id}/approve`, "POST"),
    { invalidates: ["/api/books/wanted"] },
  );
  const decline = useMutation(
    (id: string) => apiSend(`/api/books/wanted/${id}/decline`, "POST"),
    { invalidates: ["/api/books/wanted"] },
  );

  const items = wantedQ.data?.items ?? [];
  const results = (searchQ.data?.results ?? []).filter((r) => r.kind === "book");
  const bookSource = searchQ.data?.sources.find((s) => s.kind === "book");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = term.trim();
    if (t) setCommitted(t);
  }

  return (
    <>
      <PageHeader
        title="Books"
        subtitle={isAdmin
          ? "Find a book, pick a release, and approve the import. Nothing is filed until you approve the preview."
          : "Search for a book and request it. An admin will find a copy and add it to the library."}
      />

      {isAdmin && statusQ.data && !statusQ.data.ready && (
        <Alert tone="warn" title="Books are not fully set up">
          <ul className="stack-sm">
            {statusQ.data.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </Alert>
      )}

      <Card title="Find a book" icon="search">
        <form className="row" onSubmit={submit} role="search">
          <input
            className="input grow" aria-label="Search books" placeholder="Title or author"
            value={term} onChange={(e) => setTerm(e.target.value)}
          />
          <Button variant="primary" icon="search" type="submit" disabled={!term.trim()}>Search</Button>
        </form>
        {request.error && <Alert tone="err" title="Request failed">{request.error}</Alert>}
        {committed && (
          <Async q={searchQ} what="books">
            {() => (
              bookSource && !bookSource.available ? (
                <Alert tone="warn" title="Book search is unavailable">{bookSource.detail ?? "The metadata source did not answer."}</Alert>
              ) : results.length === 0 ? (
                <EmptyState icon="book" title="No books found" message="Try the author's name or fewer words." />
              ) : (
                <div className="list">
                  {results.map((r) => (
                    <div key={r.id} className="list-row">
                      <div className="grow">
                        <div className="truncate"><strong>{r.title}</strong>{r.year ? <span className="dim"> · {r.year}</span> : null}</div>
                        {r.subtitle && <div className="muted small truncate">{r.subtitle}</div>}
                      </div>
                      {r.status !== "unknown" && r.status !== "none"
                        ? <Badge tone={HUB_TONE[r.status] ?? "neutral"}>{r.status === "downloading" ? "On its way" : r.status[0]!.toUpperCase() + r.status.slice(1)}</Badge>
                        : null}
                      <Button
                        size="sm" variant="primary" icon={isAdmin ? "plus" : "send"}
                        disabled={!r.actionable || request.pending}
                        title={r.actionable ? undefined : "Already held, on its way, or the grab path is not set up"}
                        onClick={() => void request.run(r)}
                      >
                        {isAdmin ? "Add" : "Request"}
                      </Button>
                    </div>
                  ))}
                </div>
              )
            )}
          </Async>
        )}
      </Card>

      <Card title={isAdmin ? "Requests" : "Your requests"} icon="star">
        <Async q={wantedQ} what="requests">
          {() => (
            items.length === 0 ? (
              <EmptyState icon="book" title="Nothing requested yet" message="Search above and add a book." />
            ) : (
              <div className="list">
                {items.map((w) => (
                  <div key={w.id} className="list-row" style={{ alignItems: "flex-start" }}>
                    <div className="grow">
                      <div className="truncate"><strong>{w.title}</strong>{w.author ? <span className="muted"> · {w.author}</span> : null}</div>
                      <div className="dim small">
                        {isAdmin ? `${w.requestedBy} · ` : ""}{ago(w.createdAt)}
                        {isAdmin && w.releaseTitle ? ` · ${w.releaseFormat ?? "unknown format"}` : ""}
                      </div>
                      {isAdmin && w.error && <div className="err-text xs break">{w.error}</div>}
                      {isAdmin && w.status === "ready" && w.preview && (
                        <PreviewBox preview={w.preview} />
                      )}
                    </div>
                    <div className="row">
                      <Badge tone={STATUS_TONE[w.status]}>{STATUS_LABEL[w.status]}</Badge>
                      {isAdmin && (w.status === "requested" || w.status === "failed") && (
                        <>
                          <Button size="sm" variant="primary" icon="search" onClick={() => setPicking(w)}>Find a release</Button>
                          <Button size="sm" variant="ghost" onClick={() => void decline.run(w.id)} disabled={decline.pending}>Decline</Button>
                        </>
                      )}
                      {isAdmin && w.status === "ready" && (
                        <Button size="sm" variant="primary" icon="check" pending={approve.pending} onClick={() => void approve.run(w.id)}>
                          Approve import
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </Async>
        {approve.error && <Alert tone="err" title="Could not approve">{approve.error}</Alert>}
        {isAdmin && (
          <p className="muted small">
            Approved imports run through <LinkButton to="/jobs" size="sm">Jobs &amp; activity</LinkButton> like any other intake.
          </p>
        )}
      </Card>

      {picking && <ReleasePicker item={picking} onClose={() => setPicking(null)} />}
    </>
  );
}

function PreviewBox({ preview }: { preview: Preview }) {
  return (
    <div className="muted small" style={{ marginTop: "var(--s2)" }}>
      Preview: <span className="mono break">{preview.targetName}</span> → <span className="mono break">{preview.destPath}</span>
      {" · "}{bytes(preview.totalBytes)} · {preview.entries.length} {preview.entries.length === 1 ? "entry" : "entries"}
      {preview.importMode === "move" ? " · the download is moved, not copied" : " · hardlinked, download kept"}
      {preview.warnings.map((w, i) => <div key={i} className="warn-text">{w}</div>)}
    </div>
  );
}

function ReleasePicker({ item, onClose }: { item: Wanted; onClose: () => void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const search = useMutation(() => apiSend<SearchResponse>(`/api/books/wanted/${item.id}/search`, "POST"));
  const grab = useMutation(
    (r: Release) => apiSend(`/api/books/wanted/${item.id}/grab`, "POST", {
      guid: r.guid, indexerId: r.indexerId, title: r.title, magnet: r.magnetUrl, downloadUrl: r.downloadUrl,
    }),
    { invalidates: ["/api/books/wanted"] },
  );
  // Search once when the dialog opens; the best match comes back pre-selected.
  useEffect(() => {
    let live = true;
    void search.run().then((r) => { if (live && r.ok) setChosen(r.data.bestGuid); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const data = search.data;
  const picked = data?.releases.find((r) => r.guid === chosen) ?? null;

  async function doGrab() {
    if (!picked) return;
    const r = await grab.run(picked);
    if (r.ok) onClose();
  }

  return (
    <Modal
      wide title={`Find a release: ${item.title}`} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="download" disabled={!picked} pending={grab.pending} onClick={() => void doGrab()}>
            Grab selected
          </Button>
        </>
      }
    >
      <div className="stack">
        {search.pending && <div className="muted">Searching Prowlarr's book categories…</div>}
        {search.error && <Alert tone="err" title="Search failed">{search.error}</Alert>}
        {grab.error && <Alert tone="err" title="Grab failed">{grab.error}</Alert>}
        {data && (
          <>
            <p className="muted small">
              Searched <span className="mono">{data.query}</span>. Ranked epub, then azw3, mobi, pdf; then seeders.
              {data.bestGuid ? " The best match is selected." : " No release matches the title and has seeders, so nothing is pre-selected."}
            </p>
            {data.releases.length === 0 ? (
              <EmptyState icon="search" title="No releases found" message="No indexer has a torrent for this in the book categories." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead><tr><th /><th>Release</th><th>Format</th><th className="num">Seeders</th><th className="num">Size</th></tr></thead>
                  <tbody>
                    {data.releases.slice(0, 25).map((r) => (
                      <tr key={r.guid}>
                        <td>
                          <input type="radio" name="release" aria-label={`Select ${r.title}`} checked={chosen === r.guid} onChange={() => setChosen(r.guid)} />
                        </td>
                        <td className="break">
                          {r.title}
                          {r.guid === data.bestGuid && <> <Badge tone="ok">Best match</Badge></>}
                          {!r.matches && <> <Badge tone="warn" title="The release name does not contain the whole title">Different title?</Badge></>}
                        </td>
                        <td>{r.format ? r.format.toUpperCase() : <span className="dim">?</span>}</td>
                        <td className="num">{r.seeders ?? "—"}</td>
                        <td className="num">{r.size ? bytes(r.size) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
