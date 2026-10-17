import { statfsSync, statSync } from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { settings } from "../db/schema.js";
import { isWithinApprovedRoots } from "../security/paths.js";

/**
 * Drives — the physical disks content can be placed on, and which one each kind
 * of content goes to unless someone picks otherwise.
 *
 * Every service names the same disk differently: Radarr sees the 1TB as
 * `/mnt/storage2`, TorHQ as `/mnt/storage-1tb`, qBittorrent not at all. So a
 * drive is a label plus every path prefix that lives on it, in any service's
 * view, and a path belongs to the drive with the longest matching prefix. The
 * paths are compared as POSIX strings on whole segments, never resolved on this
 * host, because most of them only exist inside another container.
 */

export const DRIVE_PURPOSES = ["movies", "tv", "music", "books", "comics", "downloads"] as const;
export type DrivePurpose = (typeof DRIVE_PURPOSES)[number];

/** Which purpose an *arr's root folders serve. */
export const ARR_PURPOSE = { radarr: "movies", sonarr: "tv", lidarr: "music" } as const satisfies Record<string, DrivePurpose>;

/** Which purpose an intake library serves, by its `kind`. */
export function libraryPurpose(kind: string): DrivePurpose | undefined {
  if (kind === "books") return "books";
  if (kind === "comics" || kind === "manga") return "comics";
  if (kind === "music") return "music";
  return undefined;
}

const DriveId = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes only");

const AbsPath = z.string().trim().min(1).max(512)
  .regex(/^\//, "must be an absolute path")
  .refine((p) => !p.split("/").includes(".."), "must not contain ..")
  .transform((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p));

const DriveSchema = z.object({
  id: DriveId,
  label: z.string().trim().min(1).max(64),
  paths: z.array(AbsPath).min(1).max(32),
  /** Where qBittorrent should save raw grabs placed on this drive, in qBittorrent's own view. */
  downloadPath: AbsPath.optional(),
});
export type Drive = z.infer<typeof DriveSchema>;

const DefaultsSchema = z.object({
  default: DriveId.optional(),
  ...Object.fromEntries(DRIVE_PURPOSES.map((p) => [p, DriveId.optional()])),
}) as z.ZodType<DriveDefaults>;
export type DriveDefaults = { default?: string } & Partial<Record<DrivePurpose, string>>;

export const DriveSettingsSchema = z.object({
  drives: z.array(DriveSchema).max(16),
  defaults: DefaultsSchema.default({}),
}).superRefine((s, ctx) => {
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  s.drives.forEach((d, i) => {
    if (ids.has(d.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drives", i, "id"], message: `drive id "${d.id}" is used twice` });
    ids.add(d.id);
    for (const p of d.paths) {
      const other = owner.get(p);
      if (other && other !== d.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["drives", i, "paths"], message: `${p} is already on drive "${other}"` });
      }
      owner.set(p, d.id);
    }
  });
  for (const [purpose, id] of Object.entries(s.defaults)) {
    if (id !== undefined && !ids.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["defaults", purpose], message: `no drive with id "${id}"` });
    }
  }
});
export type DriveSettings = z.infer<typeof DriveSettingsSchema>;

const KEY = "drives";

export function getDriveSettings(): DriveSettings {
  const row = getDb().select().from(settings).where(eq(settings.key, KEY)).get();
  if (!row) return { drives: [], defaults: {} };
  const parsed = DriveSettingsSchema.safeParse(JSON.parse(row.valueJson));
  return parsed.success ? parsed.data : { drives: [], defaults: {} };
}

/** Validate and store the whole drive configuration, replacing what was there. */
export function saveDriveSettings(input: unknown): DriveSettings {
  const next = DriveSettingsSchema.parse(input);
  const valueJson = JSON.stringify(next);
  getDb().insert(settings).values({ key: KEY, valueJson, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: Date.now() } })
    .run();
  return next;
}

/** True when `path` is `prefix` or below it, compared on whole POSIX segments. */
function under(path: string, prefix: string): boolean {
  if (prefix === "/") return path.startsWith("/");
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The drive a path lives on: the one with the longest prefix containing it. */
export function driveOf(path: string, drives: Drive[]): Drive | undefined {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  let best: { drive: Drive; len: number } | undefined;
  for (const d of drives) {
    for (const prefix of d.paths) {
      if (under(p, prefix) && (!best || prefix.length > best.len)) best = { drive: d, len: prefix.length };
    }
  }
  return best?.drive;
}

/** The drive a purpose defaults to: its own setting, else the instance-wide default. */
export function driveFor(purpose: DrivePurpose, s: DriveSettings): Drive | undefined {
  const id = s.defaults[purpose] ?? s.defaults.default;
  return id ? s.drives.find((d) => d.id === id) : undefined;
}

/** A drive as the browser sees it: just enough to label an option. */
export interface DriveRef { id: string; label: string }

/** Every configured drive, labels only, for pickers that show a drive with nothing on it as unavailable. */
export function driveRefs(s: DriveSettings): DriveRef[] {
  return s.drives.map((d) => ({ id: d.id, label: d.label }));
}

/** Tag each *arr root folder with the drive it is on, when it is on a known one. */
export function withDrives<T extends { path: string }>(roots: T[], drives: Drive[]): Array<T & { drive?: DriveRef }> {
  return roots.map((r) => {
    const d = driveOf(r.path, drives);
    return d ? { ...r, drive: { id: d.id, label: d.label } } : r;
  });
}

/**
 * The root folder a new *arr item should default to. The purpose's default
 * drive wins when the *arr has a root on it; otherwise a root saved per *arr
 * before drives existed, while the *arr still lists it; otherwise nothing, and
 * the caller falls back to the *arr's first root.
 */
export function defaultRootFor(
  purpose: DrivePurpose,
  roots: Array<{ path: string }>,
  s: DriveSettings,
  legacyRoot?: unknown,
): string | undefined {
  const drive = driveFor(purpose, s);
  if (drive) {
    const onDrive = roots.find((r) => driveOf(r.path, s.drives)?.id === drive.id);
    if (onDrive) return onDrive.path;
  }
  return typeof legacyRoot === "string" && roots.some((r) => r.path === legacyRoot) ? legacyRoot : undefined;
}

/**
 * Free and total space for a drive, measured on the approved roots that sit on
 * it plus any of its own paths inside an approved root. When those report
 * different filesystems the largest one is the drive: a smaller one is a disk
 * mounted over part of it, the way pve-1 lays an SSD over the 4TB's
 * `literature`. Undefined when TorHQ can see no part of the drive.
 */
export function driveUsage(
  d: Drive, s: DriveSettings, approvedRoots: string[],
): { totalBytes: number; freeBytes: number } | undefined {
  const candidates = [
    ...approvedRoots.filter((r) => driveOf(r, s.drives)?.id === d.id),
    ...d.paths.filter((p) => isWithinApprovedRoots(p, approvedRoots)),
  ];
  let best: { totalBytes: number; freeBytes: number } | undefined;
  for (const p of candidates) {
    try {
      statSync(p);
      const fs = statfsSync(p);
      const usage = { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
      if (!best || usage.totalBytes > best.totalBytes) best = usage;
    } catch {
      continue;
    }
  }
  return best;
}
