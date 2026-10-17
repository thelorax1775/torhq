/**
 * Drives, on the Settings page: which drive each kind of content goes to by
 * default, and what each drive is called in every service's view.
 *
 * The defaults are what the Get, Requests, Search and Intake pages start on;
 * anyone can still pick another drive there for a single item. A drive is
 * matched by path prefix because Radarr, qBittorrent and TorHQ each name the
 * same disk differently, so all of those names are listed under it.
 */
import { useEffect, useState } from "react";
import { apiSend } from "../lib/api.js";
import { bytes } from "../lib/format.js";
import { useMutation } from "../lib/useMutation.js";
import { usePolled } from "../lib/usePolled.js";
import {
  Alert, Async, Button, Card, Field, ProgressBar, SelectField, TextField,
} from "./ui.js";

const PURPOSES = ["movies", "tv", "music", "books", "comics", "downloads"] as const;
type Purpose = (typeof PURPOSES)[number];

const PURPOSE_LABEL: Record<Purpose, { label: string; hint: string }> = {
  movies: { label: "Movies", hint: "Radarr's root folder on this drive." },
  tv: { label: "TV", hint: "Sonarr's root folder on this drive." },
  music: { label: "Music", hint: "Lidarr's root folder, and the music intake library." },
  books: { label: "Books", hint: "The books intake library." },
  comics: { label: "Comics & manga", hint: "The comics and manga intake libraries." },
  downloads: { label: "Manual downloads", hint: "Search grabs sent straight to qBittorrent." },
};

interface Drive {
  id: string;
  label: string;
  paths: string[];
  downloadPath?: string;
  usage?: { totalBytes: number; freeBytes: number };
}
type Defaults = { default?: string } & Partial<Record<Purpose, string>>;
interface DrivesResponse { drives: Drive[]; defaults: Defaults }

interface DraftDrive { id: string; label: string; paths: string; downloadPath: string; usage?: Drive["usage"] }

function toDraft(d: Drive): DraftDrive {
  return { id: d.id, label: d.label, paths: d.paths.join("\n"), downloadPath: d.downloadPath ?? "", usage: d.usage };
}

function toBody(drives: DraftDrive[], defaults: Defaults) {
  return {
    drives: drives.map((d) => ({
      id: d.id.trim(),
      label: d.label.trim(),
      paths: d.paths.split("\n").map((p) => p.trim()).filter(Boolean),
      downloadPath: d.downloadPath.trim() || undefined,
    })),
    defaults: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v)),
  };
}

function usageTone(used: number): "ok" | "warn" | "err" | undefined {
  if (used >= 0.95) return "err";
  if (used >= 0.85) return "warn";
  return undefined;
}

export function DrivesCard() {
  const q = usePolled<DrivesResponse>("/api/drives", 0);
  const [drives, setDrives] = useState<DraftDrive[] | null>(null);
  const [defaults, setDefaults] = useState<Defaults>({});
  const [dirty, setDirty] = useState(false);

  const save = useMutation(
    (body: unknown) => apiSend<DrivesResponse>("/api/drives", "PUT", body),
    { invalidates: ["/api/drives"] },
  );

  useEffect(() => {
    if (!q.data || dirty) return;
    setDrives(q.data.drives.map(toDraft));
    setDefaults(q.data.defaults);
  }, [q.data, dirty]);

  function editDrive(i: number, patch: Partial<DraftDrive>) {
    setDrives((ds) => ds!.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setDirty(true);
  }
  function removeDrive(i: number) {
    const gone = drives![i]!.id;
    setDrives((ds) => ds!.filter((_, j) => j !== i));
    setDefaults((df) => Object.fromEntries(Object.entries(df).filter(([, v]) => v !== gone)));
    setDirty(true);
  }
  function setDefault(key: "default" | Purpose, id: string) {
    setDefaults((df) => ({ ...df, [key]: id || undefined }));
    setDirty(true);
  }
  async function doSave() {
    const r = await save.run(toBody(drives ?? [], defaults));
    if (r.ok) setDirty(false);
  }

  const list = drives ?? [];
  const labelOf = (id?: string) => list.find((d) => d.id === id)?.label;

  return (
    <Card
      title="Drives"
      subtitle="Where new things go. Every page that places something starts on these, and you can still pick another drive there."
      icon="folder"
      footer={
        <div className="row">
          <Button variant="primary" icon="check" pending={save.pending} disabled={!dirty} onClick={() => void doSave()}>
            Save drives
          </Button>
          {dirty && (
            <Button onClick={() => { setDirty(false); save.reset(); }}>Discard changes</Button>
          )}
          {save.error && <span className="small err">{save.error}</span>}
        </div>
      }
    >
      <Async q={q} what="drives">
        {() => (
          <div className="stack">
            {list.length === 0 && (
              <Alert tone="info" title="No drives yet">
                Add one per disk. Until then each page falls back to the first folder the service lists.
              </Alert>
            )}

            {list.length > 0 && (
              <div className="grid-3">
                <SelectField
                  label="Default drive"
                  hint="Used for anything without its own choice below."
                  value={defaults.default ?? ""}
                  onChange={(e) => setDefault("default", e.target.value)}
                >
                  <option value="">None — first folder each service lists</option>
                  {list.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </SelectField>
                {PURPOSES.map((p) => (
                  <SelectField
                    key={p}
                    label={PURPOSE_LABEL[p].label}
                    hint={PURPOSE_LABEL[p].hint}
                    value={defaults[p] ?? ""}
                    onChange={(e) => setDefault(p, e.target.value)}
                  >
                    <option value="">Same as default{labelOf(defaults.default) ? ` (${labelOf(defaults.default)})` : ""}</option>
                    {list.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </SelectField>
                ))}
              </div>
            )}

            {list.map((d, i) => {
              const used = d.usage && d.usage.totalBytes > 0 ? (d.usage.totalBytes - d.usage.freeBytes) / d.usage.totalBytes : undefined;
              return (
                <div key={i} className="stack-sm" style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--s4)" }}>
                  <div className="spread">
                    <strong>{d.label || "New drive"}</strong>
                    <Button size="sm" icon="trash" onClick={() => removeDrive(i)}>Remove</Button>
                  </div>
                  {used !== undefined && d.usage && (
                    <div>
                      <div className="small muted">{bytes(d.usage.freeBytes)} free of {bytes(d.usage.totalBytes)}</div>
                      <ProgressBar value={used} tone={usageTone(used)} />
                    </div>
                  )}
                  <div className="grid-2">
                    <TextField label="Name" value={d.label} placeholder="4TB-x2" onChange={(e) => editDrive(i, { label: e.target.value })} />
                    <TextField
                      label="ID"
                      hint="Lowercase letters, digits and dashes. Changing it resets any default that used it."
                      value={d.id}
                      placeholder="4tb-x2"
                      onChange={(e) => editDrive(i, { id: e.target.value })}
                    />
                  </div>
                  <Field
                    label="Paths on this drive"
                    hint="One per line, as any service sees it: Radarr's /mnt/storage-x2, qBittorrent's /mnt/torrents-x2, TorHQ's /mnt/storage-4tb-x2."
                  >
                    <textarea
                      className="textarea mono"
                      rows={4}
                      value={d.paths}
                      onChange={(e) => editDrive(i, { paths: e.target.value })}
                    />
                  </Field>
                  <TextField
                    label="qBittorrent download folder (optional)"
                    hint="As qBittorrent sees it. Manual grabs to this drive save to a category folder inside it. Leave blank if qBittorrent can't reach this drive."
                    value={d.downloadPath}
                    placeholder="/mnt/torrents-x2"
                    onChange={(e) => editDrive(i, { downloadPath: e.target.value })}
                  />
                </div>
              );
            })}

            <div className="row">
              <Button
                icon="plus"
                onClick={() => { setDrives((ds) => [...(ds ?? []), { id: "", label: "", paths: "", downloadPath: "" }]); setDirty(true); }}
              >
                Add a drive
              </Button>
            </div>
          </div>
        )}
      </Async>
    </Card>
  );
}
