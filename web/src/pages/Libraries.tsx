/**
 * Libraries — destination rules for manual intake (books/manga/comics/music
 * into Kavita or Navidrome). Unrelated to the *arr, which own their own
 * libraries end to end; this page never touches Radarr/Sonarr/Lidarr media.
 *
 * Consumes `GET /api/libraries`, `GET /api/config/roots` and
 * `POST /api/libraries` (upsert by `key` — there is no delete endpoint, so a
 * library once created can be edited but not removed from here).
 */
import { useState, type FormEvent } from "react";
import { apiSend } from "../lib/api.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, PageHeader,
  RefreshButton, SelectField, TableWrap, TextField,
} from "../components/ui.js";

type LibraryKind = "books" | "manga" | "comics" | "music" | "audiobooks";
type TargetService = "kavita" | "navidrome" | "audiobookshelf";
type ImportMode = "move" | "link";

interface Library {
  key: string;
  label: string;
  kind: LibraryKind;
  targetService: TargetService;
  destPath: string;
  stagingPath: string;
  rescan: boolean;
  importMode: ImportMode;
}
interface LibrariesResponse { libraries: Library[] }
interface RootsResponse { approvedRoots: string[] }

const KIND_LABEL: Record<LibraryKind, string> = { books: "Books", manga: "Manga", comics: "Comics", music: "Music", audiobooks: "Audiobooks" };
const TARGET_LABEL: Record<TargetService, string> = { kavita: "Kavita", navidrome: "Navidrome", audiobookshelf: "Audiobookshelf" };
const MODE_LABEL: Record<ImportMode, string> = { move: "Move", link: "Hardlink" };
/** Kavita serves books/manga/comics; Navidrome serves music; Audiobookshelf serves audiobooks. Not a user choice. */
const targetFor = (kind: LibraryKind): TargetService => (kind === "music" ? "navidrome" : kind === "audiobooks" ? "audiobookshelf" : "kavita");

type FormState = Omit<Library, "targetService">;
const EMPTY_FORM: FormState = {
  key: "", label: "", kind: "books", destPath: "", stagingPath: "", rescan: true, importMode: "move",
};
const KEY_RE = /^[a-z0-9-]+$/;

export function Libraries() {
  const q = usePolled<LibrariesResponse>("/api/libraries", 0);
  const roots = usePolled<RootsResponse>("/api/config/roots", 0);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Library | null>(null);

  const save = useMutation(
    (body: Library) => apiSend<{ ok: true }>("/api/libraries", "POST", body),
    { invalidates: ["/api/libraries"] },
  );

  const remove = useMutation(
    (lib: Library) => apiSend<{ ok: true }>(`/api/libraries/${encodeURIComponent(lib.key)}`, "DELETE"),
    { invalidates: ["/api/libraries"] },
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function startEdit(lib: Library) {
    setForm({
      key: lib.key, label: lib.label, kind: lib.kind, destPath: lib.destPath,
      stagingPath: lib.stagingPath, rescan: lib.rescan, importMode: lib.importMode ?? "move",
    });
    setEditing(true);
    save.reset();
  }
  function startNew() {
    setForm(EMPTY_FORM);
    setEditing(false);
    save.reset();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.run({ ...form, targetService: targetFor(form.kind) });
  }

  const approvedRoots = roots.data?.approvedRoots ?? [];
  const target = targetFor(form.kind);
  const keyValid = KEY_RE.test(form.key);
  const canSave = keyValid && form.label.trim() !== "" && form.destPath.trim() !== "" && form.stagingPath.trim() !== "";

  return (
    <>
      <PageHeader
        title="Libraries"
        subtitle="Where manual intake copies books, manga, comics and music. Radarr, Sonarr and Lidarr manage their own libraries and never go through this."
        actions={<RefreshButton q={q} />}
      />

      <Card title="Configured" icon="book">
        <Async q={q} what="libraries">
          {(data) => (
            data.libraries.length === 0 ? (
              <EmptyState icon="book" title="No libraries yet" message="Add one below before queuing a manual intake." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Library</th>
                      <th>Kind</th>
                      <th>Target</th>
                      <th>Destination</th>
                      <th>Staging</th>
                      <th>Import</th>
                      <th>Rescan</th>
                      <th className="shrink" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.libraries.map((l) => (
                      <tr key={l.key}>
                        <td>
                          <div>{l.label}</div>
                          <div className="dim xs mono">{l.key}</div>
                        </td>
                        <td className="nowrap"><Badge>{KIND_LABEL[l.kind]}</Badge></td>
                        <td className="nowrap">{TARGET_LABEL[l.targetService]}</td>
                        <td className="truncate mono small" style={{ maxWidth: 260 }} title={l.destPath}>{l.destPath}</td>
                        <td className="truncate mono small" style={{ maxWidth: 220 }} title={l.stagingPath}>{l.stagingPath}</td>
                        <td className="nowrap">
                          <Badge tone={l.importMode === "link" ? "ok" : "neutral"}>
                            {MODE_LABEL[l.importMode ?? "move"]}
                          </Badge>
                        </td>
                        <td className="nowrap">{l.rescan ? "Yes" : "No"}</td>
                        <td className="shrink row-nowrap">
                          <Button size="sm" variant="ghost" icon="settings" title="Edit" aria-label={`Edit ${l.label}`} onClick={() => startEdit(l)} />
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="trash"
                            title="Remove"
                            aria-label={`Remove ${l.label}`}
                            onClick={() => { remove.reset(); setConfirmRemove(l); }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )
          )}
        </Async>
      </Card>

      <Card
        title={editing ? `Edit ${form.label || form.key}` : "Add a library"}
        subtitle={approvedRoots.length > 0 ? `Destination and staging paths must live inside: ${approvedRoots.join(", ")}` : undefined}
        icon="plus"
        actions={editing && <Button size="sm" variant="ghost" onClick={startNew}>Add a different one</Button>}
      >
        {save.error && <Alert tone="err" title="Save failed">{save.error}</Alert>}
        {save.data && !save.error && <Alert tone="ok" title="Saved">{form.label} is ready for manual intake.</Alert>}

        <form className="stack" onSubmit={submit}>
          <div className="grid-2">
            <TextField
              label="Key"
              value={form.key}
              onChange={(e) => set("key", e.target.value)}
              disabled={editing}
              pattern="[a-z0-9-]+"
              placeholder="kavita-manga"
              hint="Lowercase letters, digits and hyphens — the stable id intake refers to. Can't be changed once created."
              required
            />
            <TextField
              label="Label"
              value={form.label}
              onChange={(e) => set("label", e.target.value)}
              placeholder="Kavita — Manga"
              required
            />
          </div>

          <SelectField
            label="Content kind"
            value={form.kind}
            onChange={(e) => set("kind", e.target.value as LibraryKind)}
            hint={`Routes to ${TARGET_LABEL[target]} — Kavita serves books/manga/comics, Navidrome serves music, Audiobookshelf serves audiobooks.`}
          >
            {(Object.keys(KIND_LABEL) as LibraryKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </SelectField>

          <TextField
            label="Destination path"
            value={form.destPath}
            onChange={(e) => set("destPath", e.target.value)}
            placeholder="/srv/torhq/libraries/manga"
            hint={`Final directory ${TARGET_LABEL[target]} scans. Doesn't need to exist yet.`}
            required
          />
          <TextField
            label="Staging path"
            value={form.stagingPath}
            onChange={(e) => set("stagingPath", e.target.value)}
            placeholder="/srv/torhq/staging/manga"
            hint={
              form.importMode === "link"
                ? "Working directory intake builds the hardlinks in before the atomic move. Must be on the same filesystem as the destination."
                : "Working directory intake copies into before the atomic move to the destination."
            }
            required
          />

          <SelectField
            label="Import mode"
            value={form.importMode}
            onChange={(e) => set("importMode", e.target.value as ImportMode)}
            hint={
              form.importMode === "link"
                ? "Hardlinks the files into the library: instant, no extra disk space, and the source is left alone — so a torrent seeding from it keeps seeding. Source and destination must share one filesystem."
                : "Copies the files in, then deletes the source once the import has succeeded. Use this for a scratch drop directory, not for anything still being seeded."
            }
          >
            <option value="move">Move — copy in, then delete the source</option>
            <option value="link">Hardlink — import in place, keep the source</option>
          </SelectField>

          <Checkbox
            label={`Ask ${TARGET_LABEL[target]} to rescan after each import`}
            checked={form.rescan}
            onChange={(v) => set("rescan", v)}
          />

          <div className="row">
            <Button type="submit" variant="primary" icon={editing ? "check" : "plus"} pending={save.pending} disabled={!canSave}>
              {editing ? "Save changes" : "Add library"}
            </Button>
          </div>
        </form>
      </Card>

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.label}?`}
          confirmLabel="Remove library"
          tone="danger-solid"
          pending={remove.pending}
          error={remove.error}
          onClose={() => { setConfirmRemove(null); remove.reset(); }}
          onConfirm={async () => {
            const r = await remove.run(confirmRemove);
            if (r.ok) setConfirmRemove(null);
          }}
          body={
            <>
              <p>
                TorHQ forgets where <strong>{confirmRemove.label}</strong> lives.
                <strong> Nothing on disk is deleted</strong> — the files stay exactly where they are, and
                Kavita/Navidrome keep serving them.
              </p>
              <p className="muted small">
                New intake can no longer target this library. The removal is refused if intake jobs are
                still queued against it.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
