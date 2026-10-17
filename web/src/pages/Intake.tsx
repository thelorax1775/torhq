/**
 * Intake — manual staging for the content the *arr stack does not own: books,
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
  drive?: { id: string; label: string };
}
interface LibrariesResponse { libraries: Library[] }
interface DrivesResponse { defaults: Partial<Record<"default" | "books" | "comics" | "music", string>> }

const KIND_LABEL: Record<string, string> = { books: "Books", manga: "Manga", comics: "Comics", music: "Music" };

/** The Settings default that applies to a library kind. */
function purposeOf(kind: string): "books" | "comics" | "music" | undefined {
  if (kind === "books") return "books";
  if (kind === "comics" || kind === "manga") return "comics";
  if (kind === "music") return "music";
  return undefined;
}
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

export function Intake() {
  const libsQ = usePolled<LibrariesResponse>("/api/libraries");
  const rootsQ = usePolled<RootsResponse>("/api/config/roots");
  const jobsQ = usePolled<JobsResponse>("/api/jobs", 15000);
  const drivesQ = usePolled<DrivesResponse>("/api/drives", 0);

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
  const kinds = [...new Set(libraries.map((l) => l.kind))];

  /** The library a kind starts on: the one on that kind's default drive, else its first. */
  function defaultLibraryFor(kind: string): string {
    const ofKind = libraries.filter((l) => l.kind === kind);
    const defaults = drivesQ.data?.defaults ?? {};
    const purpose = purposeOf(kind);
    const driveId = (purpose && defaults[purpose]) ?? defaults.default;
    return (ofKind.find((l) => l.drive?.id === driveId) ?? ofKind[0])?.key ?? "";
  }

  const key = libraryKey || (kinds[0] ? defaultLibraryFor(kinds[0]) : "");
  const lib = libraries.find((l) => l.key === key);
  const sameKind = libraries.filter((l) => l.kind === lib?.kind);
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
        title="Intake"
        subtitle="Stage completed files into a Kavita or Navidrome library. Never point this at a Radarr/Sonarr/Lidarr folder — the *arr own those completely."
      />

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
        <Card title="Stage an import" icon="inbox">
          <div className="grid-2">
            <SelectField
              label="What is it?"
              value={lib?.kind ?? ""}
              onChange={(e) => { setLibraryKey(defaultLibraryFor(e.target.value)); setPreviewedFor(null); preview.reset(); }}
            >
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
            </SelectField>
            <SelectField
              label="Drive"
              value={key}
              onChange={(e) => { setLibraryKey(e.target.value); setPreviewedFor(null); preview.reset(); }}
            >
              {sameKind.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.drive ? `${l.drive.label} — ${l.label}` : l.label} ({l.targetService})
                </option>
              ))}
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
              Job {commit.data.jobId.slice(0, 8)} is {commit.data.status}. Track it below or on the Jobs page.
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
        title="Recent intake jobs"
        subtitle="What this page has queued lately — full history and retries live on the Jobs page."
        icon="clock"
        actions={<LinkButton to="/jobs" size="sm">Open Jobs</LinkButton>}
      >
        <Async q={jobsQ} what="jobs">
          {() => (
            intakeJobs.length === 0 ? (
              <EmptyState icon="clock" title="No intake jobs yet" message="Imports queued from this page will show up here." />
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
