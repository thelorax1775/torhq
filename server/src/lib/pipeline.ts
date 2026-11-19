import type { ArrDownloadClient, ArrFlavor, ArrQueueItem } from "../adapters/arr.js";
import type { QbTorrent } from "../adapters/qbittorrent.js";

/**
 * The "why didn't my download get imported?" diagnostic, as pure functions over
 * snapshots the route fetches. Everything here is READ-ONLY by construction: a
 * check reports a problem and names the fix, it never applies one. TorHQ does
 * not silently reconfigure an *arr or a download client on the user's behalf.
 */
export type CheckSeverity = "error" | "warn" | "info";

export interface PipelineCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: CheckSeverity;
  detail: string;
  /** What the user should do about it. Present whenever `ok` is false. */
  fix?: string;
}

/** What TorHQ could learn about qBittorrent. Undefined fields = not readable. */
export interface QbSnapshot {
  configured: boolean;
  error?: string;
  categories?: Record<string, { name: string; savePath: string }>;
  defaultSavePath?: string;
  torrents?: QbTorrent[];
}

/** What TorHQ could learn about one *arr. Undefined fields = not readable. */
export interface ArrSnapshot {
  service: ArrFlavor;
  configured: boolean;
  error?: string;
  downloadClients?: ArrDownloadClient[];
  config?: { enableCompletedDownloadHandling?: boolean };
  rootFolders?: Array<{ id: number; path: string; accessible?: boolean }>;
  queue?: ArrQueueItem[];
  /**
   * For each directory qBittorrent saves into: can this *arr see it through its
   * own filesystem, and failing that, can it see the parent? Undefined when
   * TorHQ could not ask.
   */
  visiblePaths?: Array<{ path: string; visible: boolean; parentVisible: boolean }>;
}

/** How long an item may sit in import limbo before it counts as stuck. */
export const STUCK_IMPORT_MS = 60 * 60 * 1000;

const LABEL: Record<ArrFlavor, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };

export function buildPipelineChecks(input: {
  qb: QbSnapshot;
  arrs: ArrSnapshot[];
  now?: number;
}): PipelineCheck[] {
  const { qb, arrs } = input;
  const now = input.now ?? Date.now();
  const checks: PipelineCheck[] = [qbReachable(qb)];
  for (const arr of arrs) checks.push(...arrChecks(arr, qb, now));
  return checks;
}

function qbReachable(qb: QbSnapshot): PipelineCheck {
  const base = { id: "qb-reachable", label: "qBittorrent is reachable" };
  if (!qb.configured) {
    return {
      ...base, ok: false, severity: "error",
      detail: "qBittorrent is not configured in TorHQ, so nothing downstream of a grab can be verified.",
      fix: "Add qBittorrent on the Services page.",
    };
  }
  if (qb.error) {
    return {
      ...base, ok: false, severity: "error",
      detail: `qBittorrent did not respond: ${qb.error}`,
      fix: "Check the base URL and WebUI credentials on the Services page.",
    };
  }
  const names = Object.keys(qb.categories ?? {});
  return {
    ...base, ok: true, severity: "info",
    detail: `Connected. ${names.length} categor${names.length === 1 ? "y" : "ies"}`
      + (names.length ? ` (${names.join(", ")})` : "")
      + (qb.defaultSavePath ? `, default save path ${qb.defaultSavePath}.` : "."),
  };
}

function arrChecks(arr: ArrSnapshot, qb: QbSnapshot, now: number): PipelineCheck[] {
  const name = LABEL[arr.service];
  if (!arr.configured) {
    // Not an error: a homelab without music simply has no Lidarr.
    return [{
      id: `${arr.service}-configured`, label: `${name} is configured`, ok: false, severity: "info",
      detail: `${name} is not configured in TorHQ, so its half of the pipeline is not checked.`,
      fix: `Add ${name} on the Services page if you use it.`,
    }];
  }
  if (arr.error) {
    return [{
      id: `${arr.service}-reachable`, label: `${name} is reachable`, ok: false, severity: "error",
      detail: `${name} did not respond: ${arr.error}`,
      fix: `Check ${name}'s base URL and API key on the Services page.`,
    }];
  }

  const checks: PipelineCheck[] = [{
    id: `${arr.service}-reachable`, label: `${name} is reachable`, ok: true, severity: "info",
    detail: `${name} answered TorHQ's API calls.`,
  }];

  const client = pickQbClient(arr.downloadClients);
  checks.push(downloadClientCheck(arr, name, client));
  checks.push(categoryCheck(arr, name, qb, client));
  checks.push(completedHandlingCheck(arr, name));
  checks.push(rootFolderCheck(arr, name, qb));
  checks.push(savePathVisibleCheck(arr, name, qb, client));
  checks.push(stuckImportCheck(arr, name, qb, now));
  return checks;
}

/** The enabled qBittorrent client if there is one, else any qBittorrent client. */
function pickQbClient(clients: ArrDownloadClient[] | undefined): ArrDownloadClient | undefined {
  const qbs = (clients ?? []).filter((c) => /qbittorrent/i.test(c.implementation));
  return qbs.find((c) => c.enable) ?? qbs[0];
}

function downloadClientCheck(arr: ArrSnapshot, name: string, client: ArrDownloadClient | undefined): PipelineCheck {
  const base = { id: `${arr.service}-download-client`, label: `${name} has qBittorrent as a download client` };
  if (arr.downloadClients === undefined) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `TorHQ could not read ${name}'s download-client list.`,
      fix: `Confirm the API key stored for ${name} has full access.`,
    };
  }
  if (!client) {
    return {
      ...base, ok: false, severity: "error",
      detail: `${name} has no qBittorrent download client, so it will never adopt a torrent TorHQ grabs.`,
      fix: `Add qBittorrent under Settings → Download Clients in ${name}.`,
    };
  }
  if (!client.enable) {
    return {
      ...base, ok: false, severity: "error",
      detail: `${name}'s qBittorrent client "${client.name}" exists but is disabled.`,
      fix: `Enable "${client.name}" under Settings → Download Clients in ${name}.`,
    };
  }
  return {
    ...base, ok: true, severity: "info",
    detail: `${name} downloads through "${client.name}".`,
  };
}

/**
 * Each *arr names the download-client category field after its own media type —
 * Radarr `movieCategory`, Sonarr `tvCategory`, Lidarr `musicCategory` — and only
 * some builds also expose a plain `category`. Reading one name finds an empty
 * string on a correctly-configured stack, so try the flavour's own name first.
 */
const CATEGORY_FIELDS: Record<ArrFlavor, string[]> = {
  radarr: ["movieCategory", "category"],
  sonarr: ["tvCategory", "category"],
  lidarr: ["musicCategory", "category"],
};

function clientCategory(service: ArrFlavor, client: ArrDownloadClient | undefined): string {
  for (const field of CATEGORY_FIELDS[service]) {
    const value = client?.fields[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function categoryCheck(
  arr: ArrSnapshot, name: string, qb: QbSnapshot, client: ArrDownloadClient | undefined,
): PipelineCheck {
  const category = clientCategory(arr.service, client);
  const base = {
    id: `qb-category-${arr.service}`,
    label: `qBittorrent has a \`${category || arr.service}\` category`,
  };
  if (!client || qb.categories === undefined) {
    return {
      ...base, ok: false, severity: "warn",
      detail: !client
        ? `No qBittorrent client in ${name} to read a category from.`
        : "TorHQ could not read qBittorrent's categories.",
      fix: "Resolve the checks above first; this one depends on them.",
    };
  }
  if (!category) {
    return {
      ...base, ok: false, severity: "error",
      detail: `${name}'s qBittorrent client sets no category, so its downloads are indistinguishable from everything else in the client.`,
      fix: `Set the category to \`${arr.service}\` in ${name}'s download-client settings.`,
    };
  }
  if (!(category in qb.categories)) {
    return {
      ...base, ok: false, severity: "error",
      detail: `No category named ${category}; grabs tagged ${category} will not be adopted.`,
      fix: `Create the ${category} category in qBittorrent, or change the category in ${name}'s download-client settings to one that exists.`,
    };
  }
  return {
    ...base, ok: true, severity: "info",
    detail: `${name} tags its grabs \`${category}\`, which exists in qBittorrent`
      + (qb.categories[category]!.savePath ? ` (save path ${qb.categories[category]!.savePath}).` : "."),
  };
}

function completedHandlingCheck(arr: ArrSnapshot, name: string): PipelineCheck {
  const base = { id: `${arr.service}-completed-download-handling`, label: `${name} imports completed downloads` };
  if (arr.config?.enableCompletedDownloadHandling === undefined) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `TorHQ could not read ${name}'s download-handling settings.`,
      fix: `Confirm the API key stored for ${name} has full access.`,
    };
  }
  if (!arr.config.enableCompletedDownloadHandling) {
    return {
      ...base, ok: false, severity: "error",
      detail: `Completed Download Handling is off in ${name}; finished torrents will sit in qBittorrent forever.`,
      fix: `Turn on Settings → Download Clients → Completed Download Handling in ${name}.`,
    };
  }
  return { ...base, ok: true, severity: "info", detail: "Completed Download Handling is enabled." };
}

function rootFolderCheck(arr: ArrSnapshot, name: string, qb: QbSnapshot): PipelineCheck {
  const base = { id: `${arr.service}-root-folder`, label: `${name}'s root folder is usable` };
  if (arr.rootFolders === undefined) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `TorHQ could not read ${name}'s root folders.`,
      fix: `Confirm the API key stored for ${name} has full access.`,
    };
  }
  if (arr.rootFolders.length === 0) {
    return {
      ...base, ok: false, severity: "error",
      detail: `${name} has no root folder, so it has nowhere to import to.`,
      fix: `Add a root folder under Settings → Media Management in ${name}.`,
    };
  }
  const unusable = arr.rootFolders.filter((f) => f.accessible === false);
  if (unusable.length) {
    return {
      ...base, ok: false, severity: "error",
      detail: `${name} reports ${unusable.map((f) => f.path).join(", ")} as inaccessible — it cannot write imports there.`,
      fix: `Fix the mount or permissions for that path inside ${name}'s container, then re-check.`,
    };
  }
  const savePaths = qbSavePaths(qb);
  const nested = arr.rootFolders.filter((f) => savePaths.some((p) => isInside(f.path, p)));
  if (nested.length) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `${name}'s root folder ${nested[0]!.path} sits inside qBittorrent's download directory; imports would land back in the folder being seeded, and a delete in the client can take the library with it.`,
      fix: "Point the root folder at a directory outside qBittorrent's save path (a sibling of it, sharing a filesystem so hardlinks still work).",
    };
  }
  return {
    ...base, ok: true, severity: "info",
    detail: `${arr.rootFolders.map((f) => f.path).join(", ")} — accessible and outside the download directory.`,
  };
}

/**
 * The failure no amount of configuration inspection catches: every setting is
 * right, both sides agree on the path string, and the *arr still never imports —
 * because the download directory was never mounted into its container, so the
 * path it is being handed does not exist in its filesystem at all. This asks the
 * *arr directly, through its own file browser.
 *
 * A category's save path is only created by qBittorrent when a torrent first
 * lands in it, so a missing subdirectory whose parent *is* visible is normal on
 * a new category and must not be reported as a mount failure. Only a parent the
 * *arr cannot see means the mount is genuinely absent.
 */
function savePathVisibleCheck(
  arr: ArrSnapshot, name: string, qb: QbSnapshot, client: ArrDownloadClient | undefined,
): PipelineCheck {
  const base = { id: `${arr.service}-sees-save-path`, label: `${name} can see qBittorrent's download directory` };
  const savePaths = arrSavePaths(arr, qb, client);
  if (savePaths.length === 0) {
    return {
      ...base, ok: false, severity: "info",
      detail: "No qBittorrent save path is known yet, so there is nothing to look for.",
      fix: "Configure qBittorrent and its categories first.",
    };
  }
  if (arr.visiblePaths === undefined) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `TorHQ could not ask ${name} to browse its own filesystem.`,
      fix: `Confirm the API key stored for ${name} has full access.`,
    };
  }

  // The route probes every directory qBittorrent writes into; only the ones this
  // *arr imports from are its business (TorHQ's own book categories are not).
  const visiblePaths = arr.visiblePaths.filter((v) => savePaths.some((p) => normalizePath(p) === normalizePath(v.path)));
  const unmounted = visiblePaths.filter((v) => !v.visible && !v.parentVisible);
  if (unmounted.length) {
    return {
      ...base, ok: false, severity: "error",
      detail: `${name} cannot see ${unmounted.map((v) => v.path).join(", ")}, nor the directory above. `
        + "Downloads will complete in qBittorrent and then sit there forever, with no error in either app.",
      fix: `Mount that directory into ${name}'s container at the same path qBittorrent uses. `
        + "On Proxmox: `pct set <ctid> -mpN /host/path,mp=/same/path/qbittorrent/uses`, then reboot the container. "
        + "Keeping the path identical also avoids a remote path mapping, and lets imports hardlink instead of copy.",
    };
  }

  const pending = visiblePaths.filter((v) => !v.visible);
  const mounted = visiblePaths.filter((v) => v.visible).map((v) => v.path);
  if (pending.length) {
    return {
      ...base, ok: true, severity: "info",
      detail: `${name} can see the download directory. `
        + `${pending.map((v) => v.path).join(", ")} does not exist yet — qBittorrent creates a category's `
        + "save path when the first torrent lands in it, and it will be visible then.",
    };
  }
  return {
    ...base, ok: true, severity: "info",
    detail: `${name} can browse ${mounted.join(", ")}.`,
  };
}

function stuckImportCheck(arr: ArrSnapshot, name: string, qb: QbSnapshot, now: number): PipelineCheck {
  const base = { id: `${arr.service}-stuck-imports`, label: `${name} has nothing stuck in import` };
  if (arr.queue === undefined) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `TorHQ could not read ${name}'s queue.`,
      fix: `Confirm the API key stored for ${name} has full access.`,
    };
  }
  const stuck = arr.queue.filter((item) => {
    const state = (item.trackedDownloadState ?? "").toLowerCase();
    if (state !== "importpending" && state !== "importblocked") return false;
    const started = itemStartedAt(item, qb);
    return started != null && now - started > STUCK_IMPORT_MS;
  });
  if (stuck.length) {
    return {
      ...base, ok: false, severity: "warn",
      detail: `${stuck.length} item${stuck.length === 1 ? " has" : "s have"} been waiting to import for over an hour (oldest: "${stuck[0]!.title}").`,
      fix: "Each one is listed under Needs attention on Transfers with the app's reason; fix that, then press Retry import.",
    };
  }
  return { ...base, ok: true, severity: "info", detail: "No queue item has been waiting to import for over an hour." };
}

/**
 * When the item entered the pipeline, in epoch ms. Current *arr builds report
 * `added`; older ones do not, so fall back to qBittorrent's own added-on for the
 * matching torrent. Returns null when neither is known — an item of unknown age
 * is never reported as stuck.
 */
function itemStartedAt(item: ArrQueueItem, qb: QbSnapshot): number | null {
  if (item.added) {
    const t = Date.parse(item.added);
    if (!Number.isNaN(t)) return t;
  }
  const hash = item.downloadId?.toLowerCase();
  if (!hash) return null;
  const torrent = qb.torrents?.find((t) => t.hash.toLowerCase() === hash);
  return torrent?.addedOn ? torrent.addedOn * 1000 : null;
}

/**
 * The directories this *arr actually imports from: the save path of the category
 * its own download client uses, or qBittorrent's default save path when it sets
 * no category (or the category has no path of its own). Never the other
 * categories — torhq-books and friends belong to TorHQ, not to any *arr.
 */
function arrSavePaths(arr: ArrSnapshot, qb: QbSnapshot, client: ArrDownloadClient | undefined): string[] {
  const category = clientCategory(arr.service, client);
  const own = category ? qb.categories?.[category]?.savePath : undefined;
  const path = own && own.trim() ? own : qb.defaultSavePath;
  return path && path.trim() ? [path] : [];
}

/** Every directory qBittorrent may write downloads into. */
function qbSavePaths(qb: QbSnapshot): string[] {
  const paths = Object.values(qb.categories ?? {}).map((c) => c.savePath);
  if (qb.defaultSavePath) paths.push(qb.defaultSavePath);
  return paths.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/**
 * Path containment for *remote* paths (they belong to the *arr and qBittorrent
 * containers, not to this one), so this is plain POSIX string work — never
 * `node:path` resolution against TorHQ's own filesystem.
 */
export function isInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + "/");
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** A queue record that needs a human to push the import through. */
export interface FailedImport {
  service: ArrFlavor;
  id: number;
  title: string;
  path?: string;
  reason: string;
  downloadId?: string;
}

/**
 * States that mean "downloaded, but not imported". `importPending` on its own is
 * normal (the *arr just hasn't got to it yet), so it only counts once the *arr
 * itself has flagged the item as a warning or error.
 */
const BLOCKED_STATES = new Set(["importblocked", "importfailed", "failedpending", "failed"]);

export function needsManualImport(item: ArrQueueItem): boolean {
  const state = (item.trackedDownloadState ?? "").toLowerCase();
  const status = (item.trackedDownloadStatus ?? "").toLowerCase();
  if (BLOCKED_STATES.has(state)) return true;
  return state === "importpending" && (status === "warning" || status === "error");
}

export function extractFailedImports(items: ArrQueueItem[]): FailedImport[] {
  return items.filter(needsManualImport).map((item) => ({
    service: item.service,
    id: item.id,
    title: item.title,
    path: item.outputPath,
    reason: item.errorMessage ?? item.statusMessages[0] ?? item.trackedDownloadState ?? "unknown",
    downloadId: item.downloadId,
  }));
}
