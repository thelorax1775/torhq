/**
 * Imports to approve — finished book and audiobook downloads wait here, each with
 * its import preview, until the admin approves (or declines) them. Below that,
 * the manual intake form: TorHQ's own staging for the content the *arr stack
 * does not own: books,
 * manga, comics and music going into Kavita/Navidrome. It never touches a
 * Radarr/Sonarr/Lidarr library — those are owned end-to-end by the *arr
 * (search, grab, import, rename, placement), and the destination libraries
 * configured on the Libraries page only ever target Kavita or Navidrome.
 *
 * Preview is mandatory before commit: `POST /api/intake/preview` is a dry run
 * that validates both paths against the approved roots and shows exactly what
 * would move, and the commit button is disabled the moment the form no longer
 * matches the preview it was run against, so a stale preview can never be
 * used to justify a different import.
 */
import { useState } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import { ago, bytes } from "../lib/format.js";
import {
  Alert, Async, Badge, Button, Card, EmptyState, Field, LinkButton, PageHeader,
  SelectField, TableWrap, TextField, type Tone,
} from "../components/ui.js";

interface Library {
  key: string;
  label: string;
  kind: string;
  targetService: string;
  destPath: string;
  stagingPath: string;
  rescan: boolean;
  importMode: "move" | "link";
}
interface LibrariesResponse { libraries: Library[] }
interface RootsResponse { approvedRoots: string[] }

interface IntakePreview {
  libraryKey: string;
  sourcePath: string;
  destPath: string;
  importMode: "move" | "link";
  entries: Array<{ name: string; size: number; isDir: boolean }>;
  totalBytes: number;
  warnings: string[];
}
interface IntakeBody { libraryKey: string; sourcePath: string; targetName?: string }

interface IntakeJob {
  id: string;
  type: string;
  status: string;
  libraryKey: string | null;
  sourcePath: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
}
interface JobsResponse { jobs: IntakeJob[] }

const JOB_TONE: Record<string, Tone> = {
  completed: "ok", queued: "warn", running: "info", failed: "err", dead: "err",
};

/** Best-effort containment check so the boundary is visible before submit —
 *  the server's `safeResolve` is the actual authority (it also rejects
 *  symlink escapes this can't see). */
function withinRoots(path: string, roots: string[]): boolean {
  const p = path.trim();
  if (!p || roots.length === 0) return true;
  return roots.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`));
}

interface WaitingItem {
  id: string; kind: "book" | "audiobook"; title: string; author: string | null; status: string;
  requestedBy: string; releaseTitle?: string | null;
  preview?: { destPath: string; targetName: string; totalBytes: number; entries: unknown[]; importMode: string; warnings: string[] } | null;
}

/** Downloads TorHQ has previewed and that only need a yes or no. */
function Waiting() {
  const books = usePolled<{ items: WaitingItem[] }>("/api/books/wanted", 15000);
  const audiobooks = usePolled<{ items: WaitingItem[] }>("/api/audiobooks/wanted", 15000);
  const base = (w: WaitingItem) => (w.kind === "audiobook" ? "/api/audiobooks" : "/api/books");
  const opts = { invalidates: ["/api/books/wanted", "/api/audiobooks/wanted", "/api/attention", "/api/jobs"] };
  const approve = useMutation((w: WaitingItem) => apiSend(`${base(w)}/wanted/${w.id}/approve`, "POST"), opts);
  const decline = useMutation((w: WaitingItem) => apiSend(`${base(w)}/wanted/${w.id}/decline`, "POST"), opts);
  const ready = [...(books.data?.items ?? []), ...(audiobooks.data?.items ?? [])].filter((w) => w.status === "ready");
  const loading = books.initial || audiobooks.initial;

  return (
    <Card title="Waiting for your OK" icon="check" subtitle="Each one has been checked against your libraries; nothing moves until you approve it.">
      {approve.error && <Alert tone="err" title="Couldn't approve it">{approve.error}</Alert>}
      {decline.error && <Alert tone="err" title="Couldn't decline it">{decline.error}</Alert>}
      {loading ? null : ready.length === 0 ? (
        <EmptyState icon="inbox" title="Nothing waiting" message="When a book or audiobook finishes downloading, it shows up here with exactly what will be imported and where." />
      ) : (
        <ul className="list" aria-label="Imports waiting for approval">
          {ready.map((w) => (
            <li key={w.id} className="list-row" style={{ alignItems: "flex-start" }}>
              <Badge tone="info">{w.kind === "audiobook" ? "Audiobook" : "Book"}</Badge>
              <div className="grow" style={{ minWidth: 0 }}>
                <div><strong>{w.title}</strong>{w.author ? <span className="muted"> · {w.author}</span> : null}</div>
                <div className="small muted">requested by {w.requestedBy}{w.releaseTitle ? ` · ${w.releaseTitle}` : ""}</div>
                {w.preview && (
                  <div className="small mt-2">
                    Goes to <span className="mono break">{w.preview.destPath}</span> · {bytes(w.preview.totalBytes)}
                    {w.preview.importMode === "move" ? " · the download is moved, not copied" : " · hardlinked, the download keeps seeding"}
                    {w.preview.warnings.map((m, i) => <div key={i} className="warn-text">{m}</div>)}
                  </div>
                )}
                <div className="row mt-2">
                  <Button size="sm" variant="primary" icon="check" pending={approve.pending} onClick={() => void approve.run(w)}>Approve import</Button>
                  <Button size="sm" variant="danger" icon="close" pending={decline.pending} onClick={() => void decline.run(w)}>Decline</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Imports() {
  const libsQ = usePolled<LibrariesResponse>("/api/libraries");
  const rootsQ = usePolled<RootsResponse>("/api/config/roots");
  const jobsQ = usePolled<JobsResponse>("/api/jobs", 15000);

  const [libraryKey, setLibraryKey] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [targetName, setTargetName] = useState("");
  const [previewedFor, setPreviewedFor] = useState<IntakeBody | null>(null);

  const preview = useMutation((body: IntakeBody) => apiSend<IntakePreview>("/api/intake/preview", "POST", body));
  const commit = useMutation(
    (body: IntakeBody) => apiSend<{ ok: true; jobId: string; status: string }>("/api/intake", "POST", body),
    { invalidates: ["/api/jobs"] },
  );

  const libraries = libsQ.data?.libraries ?? [];
  const roots = rootsQ.data?.approvedRoots ?? [];
  const key = libraryKey || libraries[0]?.key || "";
  const lib = libraries.find((l) => l.key === key);
  const outOfBounds = !withinRoots(sourcePath, roots);

  function body(): IntakeBody {
    return { libraryKey: key, sourcePath: sourcePath.trim(), targetName: targetName.trim() || undefined };
  }

  async function doPreview() {
    commit.reset();
    const b = body();
    const r = await preview.run(b);
    if (r.ok) setPreviewedFor(b);
  }
  async function doCommit() {
    const r = await commit.run(body());
    if (r.ok) { setSourcePath(""); setTargetName(""); preview.reset(); setPreviewedFor(null); }
  }

  const b = body();
  const stale = !!previewedFor
    && (previewedFor.libraryKey !== b.libraryKey || previewedFor.sourcePath !== b.sourcePath || previewedFor.targetName !== b.targetName);
  const canPreview = !!key && !!sourcePath.trim() && !outOfBounds && !preview.pending;
  const canCommit = !!preview.data && !stale && !commit.pending;

  const intakeJobs = (jobsQ.data?.jobs ?? []).filter((j) => j.type === "manual_intake").slice(0, 8);

  return (
    <>
      <PageHeader
        title="Imports to approve"
        subtitle="Finished book and audiobook downloads wait here for your OK before TorHQ files them; you can also import a folder by hand."
      />

      <Waiting />

      <h3 className="section-title">Import files by hand</h3>
      <p className="small muted">For books, comics, manga or music already on disk. Radarr, Sonarr and Lidarr file their own downloads, so never point this at their folders.</p>

      {libraries.length === 0 && !libsQ.loading ? (
        <Card>
          <EmptyState
            icon="inbox"
            title="No destination libraries configured"
            message="Define at least one on the Libraries page before intake has anywhere to put files."
            actions={<LinkButton to="/libraries" icon="book" variant="primary">Open Libraries</LinkButton>}
          />
        </Card>
      ) : (
        <Card title="Choose what to import" icon="inbox">
          <div className="grid-2">
            <SelectField label="Destination library" value={key} onChange={(e) => { setLibraryKey(e.target.value); setPreviewedFor(null); preview.reset(); }}>
              {libraries.map((l) => <option key={l.key} value={l.key}>{l.label} ({l.kind} → {l.targetService})</option>)}
            </SelectField>
            <TextField
              label="Final name (optional)"
              hint="Defaults to the source's own file/folder name."
              value={targetName}
              onChange={(e) => { setTargetName(e.target.value); setPreviewedFor(null); }}
              placeholder="Artist - Album (2024)"
            />
          </div>

          <Field
            label="Source path"
            hint={roots.length > 0 ? <>Must be inside an approved root: <span className="mono">{roots.join(", ")}</span></> : undefined}
          >
            <input
              className="input"
              value={sourcePath}
              onChange={(e) => { setSourcePath(e.target.value); setPreviewedFor(null); }}
              placeholder="/srv/torhq/downloads/torhq-music/Album"
            />
          </Field>
          {outOfBounds && (
            <Alert tone="warn" title="Outside every approved root">
              The server will reject this path before it touches anything. Move the content under one of the
              roots above, or fix <span className="mono">TORHQ_APPROVED_ROOTS</span> on the Settings page.
            </Alert>
          )}
          {lib && (
            <p className="muted small">
              Destination: <span className="mono">{lib.destPath}</span> · staged via <span className="mono">{lib.stagingPath}</span>
              {" · "}
              {lib.importMode === "link"
                ? "hardlinked in place, so the source is left untouched and keeps seeding"
                : "copied in, then the source is deleted"}
            </p>
          )}

          <div className="row">
            <Button icon="search" disabled={!canPreview} pending={preview.pending} onClick={() => void doPreview()}>Preview</Button>
            <Button
              variant="primary"
              icon="check"
              disabled={!canCommit}
              pending={commit.pending}
              title={stale ? "Inputs changed since the last preview — preview again first" : undefined}
              onClick={() => void doCommit()}
            >
              Import
            </Button>
            {stale && preview.data && <span className="small warn-text">Preview is stale — run it again before importing.</span>}
          </div>

          {preview.error && <Alert tone="err" title="Preview failed">{preview.error}</Alert>}
          {commit.error && <Alert tone="err" title="Import failed">{commit.error}</Alert>}
          {commit.data && (
            <Alert tone="ok" title="Queued">
              Job {commit.data.jobId.slice(0, 8)} is {commit.data.status}. Track it below or on History.
            </Alert>
          )}
        </Card>
      )}

      {preview.data && (
        <Card
          title="Preview"
          subtitle={
            `→ ${preview.data.destPath} · ${bytes(preview.data.totalBytes)} · ${preview.data.entries.length} entries` +
            (preview.data.importMode === "link" ? " · hardlinked, source kept" : "")
          }
          icon="folder"
        >
          {preview.data.warnings.map((w, i) => <Alert key={i} tone="warn">{w}</Alert>)}
          {preview.data.entries.length === 0 ? (
            <EmptyState icon="folder" title="Nothing to import" message="The source is an empty directory." />
          ) : (
            <TableWrap>
              <table className="table">
                <thead><tr><th>Name</th><th>Type</th><th className="num">Size</th></tr></thead>
                <tbody>
                  {preview.data.entries.map((e, i) => (
                    <tr key={i}>
                      <td className="break">{e.name}</td>
                      <td className="muted">{e.isDir ? "directory" : "file"}</td>
                      <td className="num">{e.isDir ? "—" : bytes(e.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      <Card
        title="Recent imports"
        subtitle="What was imported lately; retries live on History."
        icon="clock"
        actions={<LinkButton to="/history" size="sm">Open History</LinkButton>}
      >
        <Async q={jobsQ} what="jobs">
          {() => (
            intakeJobs.length === 0 ? (
              <EmptyState icon="clock" title="No imports yet" message="Imports you approve or start here show up here." />
            ) : (
              <div className="list">
                {intakeJobs.map((j) => (
                  <div key={j.id} className="list-row">
                    <Badge tone={JOB_TONE[j.status] ?? "neutral"}>{j.status}</Badge>
                    <div className="grow">
                      <div className="mono small truncate" title={j.sourcePath}>{j.sourcePath}</div>
                      {j.lastError && <div className="err-text xs break">{j.lastError}</div>}
                    </div>
                    <span className="dim small">{ago(j.createdAt)}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </Async>
      </Card>
    </>
  );
}
