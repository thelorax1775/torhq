/**
 * Mounts — storage visibility. TorHQ runs unprivileged inside its container
 * and cannot mount anything itself (see server/src/lib/mounts.ts), so this
 * page has two read-only views (network shares actually bind-mounted in, and
 * free space on the approved roots) plus a pure client-side generator for the
 * host-side command that adds a new share — nothing here calls the server to
 * change storage, because the server has no such endpoint by design.
 */
import { useState } from "react";
import { usePolled } from "../lib/usePolled.js";
import { bytes } from "../lib/format.js";
import {
  Alert, Async, Button, Card, EmptyState, Field, PageHeader, ProgressBar,
  RefreshButton, SelectField, StaleNotice, TableWrap, TextField,
} from "../components/ui.js";

const RAW = "https://raw.githubusercontent.com/thelorax1775/TorHQ/main/scripts/mount-share.sh";

interface NetworkMount { target: string; source: string; fstype: string; totalBytes?: number; freeBytes?: number }
interface MountsResponse { mounts: NetworkMount[] }
interface DiskUsage { path: string; totalBytes: number; freeBytes: number }
interface StorageResponse { disks: DiskUsage[] }

function usedFraction(total: number, free: number): number {
  return total > 0 ? (total - free) / total : 0;
}
/** Free space rarely needs attention until it's nearly gone. */
function spaceTone(used: number): "ok" | "warn" | "err" | undefined {
  if (used >= 0.95) return "err";
  if (used >= 0.85) return "warn";
  return undefined;
}

export function Mounts() {
  const mountsQ = usePolled<MountsResponse>("/api/status/mounts", 30000);
  const storageQ = usePolled<StorageResponse>("/api/status/storage", 30000);

  const [type, setType] = useState<"nfs" | "cifs">("nfs");
  const [remote, setRemote] = useState("");
  const [name, setName] = useState("media");
  const [smbUser, setSmbUser] = useState("");
  const [smbDomain, setSmbDomain] = useState("");
  const [ctid, setCtid] = useState("");
  const [ctPath, setCtPath] = useState("");
  const [opts, setOpts] = useState("");
  const [copied, setCopied] = useState(false);

  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  function command(): string {
    const p: string[] = [`TORHQ_SHARE_TYPE=${type}`];
    if (remote) p.push(`TORHQ_SHARE_REMOTE=${q(remote)}`);
    if (name) p.push(`TORHQ_SHARE_NAME=${q(name)}`);
    if (type === "cifs" && smbUser) p.push(`TORHQ_SMB_USER=${q(smbUser)}`);
    if (type === "cifs" && smbDomain) p.push(`TORHQ_SMB_DOMAIN=${q(smbDomain)}`);
    if (ctid) p.push(`TORHQ_TARGET_CTID=${q(ctid)}`);
    if (ctPath) p.push(`TORHQ_CT_PATH=${q(ctPath)}`);
    if (opts) p.push(`TORHQ_SHARE_OPTS=${q(opts)}`);
    // NFS can run fully unattended; SMB stays interactive so the password is
    // typed on the host instead of ending up in shell history.
    if (type === "nfs") p.push("TORHQ_NONINTERACTIVE=1");
    return `${p.join(" ")} \\\n  bash -c "$(curl -fsSL ${RAW})"`;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context, permission) — command is still on screen to select manually */
    }
  }

  return (
    <>
      <PageHeader
        title="Mounts"
        subtitle="The network shares this TorHQ can see and how much space is left where it may write; TorHQ never mounts anything itself."
        actions={<RefreshButton q={mountsQ} />}
      />

      <Card title="Approved roots" subtitle="Free space where TorHQ is allowed to read and write." icon="folder">
        <Async q={storageQ} what="storage usage">
          {(data) => (
            data.disks.length === 0 ? (
              <EmptyState icon="folder" title="No approved roots configured"
                message="Set TORHQ_APPROVED_ROOTS on the server — see the Settings page." />
            ) : (
              <div className="stack-sm">
                {data.disks.map((d) => {
                  const used = usedFraction(d.totalBytes, d.freeBytes);
                  return (
                    <div key={d.path}>
                      <div className="spread">
                        <span className="small mono break">{d.path}</span>
                        <span className="small muted">{bytes(d.freeBytes)} free of {bytes(d.totalBytes)}</span>
                      </div>
                      <ProgressBar value={used} tone={spaceTone(used)} />
                    </div>
                  );
                })}
              </div>
            )
          )}
        </Async>
      </Card>

      <Card title="Network shares" subtitle="NFS/SMB mounts visible from inside this container." icon="server">
        <Async q={mountsQ} what="mounted shares">
          {(data) => (
            data.mounts.length === 0 ? (
              <EmptyState icon="server" title="No network shares mounted"
                message="Build a command below and run it on the Proxmox host to add one." />
            ) : (
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Mountpoint</th>
                      <th>Source</th>
                      <th>Type</th>
                      <th style={{ minWidth: 140 }}>Used</th>
                      <th className="num">Free</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.mounts.map((m) => {
                      const cap = typeof m.totalBytes === "number" && typeof m.freeBytes === "number";
                      const used = cap ? usedFraction(m.totalBytes as number, m.freeBytes as number) : 0;
                      return (
                        <tr key={m.target}>
                          <td className="mono small">{m.target}</td>
                          <td className="mono small dim break">{m.source}</td>
                          <td className="nowrap">{m.fstype}</td>
                          <td>{cap ? <ProgressBar value={used} tone={spaceTone(used)} /> : <span className="dim small">unreachable</span>}</td>
                          <td className="num">{cap ? bytes(m.freeBytes) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )
          )}
        </Async>
        <StaleNotice q={mountsQ} />
      </Card>

      <Card
        title="Add a share"
        subtitle="Generates the exact command — run it on the Proxmox host shell, not in here."
        icon="plus"
      >
        <Alert tone="info">
          TorHQ runs unprivileged and can't mount from inside its own container. This fills in a command that
          mounts the share on the <strong>Proxmox host</strong> and, if you give a container ID, bind-mounts it
          into that LXC (e.g. the one running qBittorrent).
        </Alert>

        <div className="grid-2 mt-3">
          <SelectField label="Type" value={type} onChange={(e) => setType(e.target.value as "nfs" | "cifs")}>
            <option value="nfs">NFS</option>
            <option value="cifs">SMB / CIFS</option>
          </SelectField>
          <TextField
            label={`Remote share ${type === "nfs" ? "(server:/export)" : "(//server/share)"}`}
            value={remote}
            onChange={(e) => setRemote(e.target.value)}
            placeholder={type === "nfs" ? "192.168.1.10:/volume1/media" : "//192.168.1.10/media"}
          />
        </div>

        <div className="grid-2">
          <TextField label="Short name (a-z0-9-)" value={name} onChange={(e) => setName(e.target.value)} placeholder="media" />
          <TextField
            label="Extra mount options (optional)"
            hint="e.g. uid=101000,gid=101000 for write access"
            value={opts}
            onChange={(e) => setOpts(e.target.value)}
            placeholder="uid=101000,gid=101000"
          />
        </div>

        {type === "cifs" && (
          <div className="grid-2">
            <TextField label="SMB username" value={smbUser} onChange={(e) => setSmbUser(e.target.value)} />
            <TextField label="SMB domain/workgroup (optional)" value={smbDomain} onChange={(e) => setSmbDomain(e.target.value)} />
          </div>
        )}
        {type === "cifs" && (
          <p className="muted small">
            The SMB password is entered on the host when you run the command — it is never put in the command
            or sent to TorHQ.
          </p>
        )}

        <div className="grid-2">
          <TextField label="Bind into container ID (optional)" hint="e.g. qBittorrent's CTID" value={ctid} onChange={(e) => setCtid(e.target.value)} placeholder="105" inputMode="numeric" />
          {ctid && (
            <TextField label="Mountpoint inside that container" value={ctPath} onChange={(e) => setCtPath(e.target.value)} placeholder={`/mnt/${name || "media"}`} />
          )}
        </div>

        <Field label="Run this on the Proxmox host">
          <pre>{command()}</pre>
        </Field>
        <div className="row">
          <Button variant="primary" icon="copy" disabled={!remote || !name} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy command"}
          </Button>
        </div>
      </Card>
    </>
  );
}
