import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { services, libraries, jobs, type Service, type Library } from "../db/schema.js";
import { encryptSecret, decryptSecret, maskSecret } from "../lib/crypto.js";
import { mergeExtra, safeExtra } from "./extra.js";

export const SERVICE_KINDS = [
  "qbittorrent", "radarr", "sonarr", "lidarr", "prowlarr",
  "slskd", "jellyfin", "navidrome", "kavita", "calibreweb", "torrentsearch", "websearch", "gemini",
  "tmdb", "rawg",
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export interface DecryptedService {
  kind: string;
  label: string;
  baseUrl: string;
  secret: string; // apiKey or "user:pass" depending on adapter
  enabled: boolean;
  extra: Record<string, unknown>;
}

/** Persist a service config, encrypting its secret. Never stores plaintext. */
export function upsertService(
  input: { kind: string; label: string; baseUrl: string; secret?: string; enabled?: boolean; extra?: Record<string, unknown> },
  masterKey: Buffer,
): void {
  const db = getDb();
  const existing = db.select().from(services).where(eq(services.kind, input.kind)).get();
  const secretEnc = input.secret
    ? encryptSecret(input.secret, masterKey)
    : existing?.secretEnc ?? null; // keep prior secret if not re-sent
  // Merge typed extra config, retaining write-only secrets (e.g. webhook token).
  const existingExtra: Record<string, unknown> = existing?.extraJson ? JSON.parse(existing.extraJson) : {};
  const mergedExtra = mergeExtra(input.kind, input.extra, existingExtra);
  const row = {
    kind: input.kind,
    label: input.label,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    secretEnc,
    enabled: input.enabled ?? true,
    extraJson: Object.keys(mergedExtra).length ? JSON.stringify(mergedExtra) : null,
    updatedAt: Date.now(),
  };
  if (existing) {
    db.update(services).set(row).where(eq(services.kind, input.kind)).run();
  } else {
    db.insert(services).values(row).run();
  }
}

export function getServiceDecrypted(kind: string, masterKey: Buffer): DecryptedService | null {
  const db = getDb();
  const row = db.select().from(services).where(eq(services.kind, kind)).get();
  if (!row) return null;
  return {
    kind: row.kind,
    label: row.label,
    baseUrl: row.baseUrl,
    secret: row.secretEnc ? decryptSecret(row.secretEnc, masterKey) : "",
    enabled: row.enabled,
    extra: row.extraJson ? JSON.parse(row.extraJson) : {},
  };
}

/** Public/browser-safe view: secrets are masked, never returned in full. */
export function listServicesSafe(): Array<
  Pick<Service, "kind" | "label" | "baseUrl" | "enabled" | "lastHealthy" | "lastStatus">
  & { secretMask: string | null; extra: Record<string, unknown> }
> {
  const db = getDb();
  return db.select().from(services).all().map((r) => ({
    kind: r.kind,
    label: r.label,
    baseUrl: r.baseUrl,
    enabled: r.enabled,
    lastHealthy: r.lastHealthy,
    lastStatus: r.lastStatus,
    secretMask: r.secretEnc ? maskSecret(r.secretEnc) : null,
    // Secret extra fields (e.g. slskd webhookToken) are projected to booleans.
    extra: safeExtra(r.kind, r.extraJson ? JSON.parse(r.extraJson) : {}),
  }));
}

export function setServiceHealth(kind: string, healthy: boolean, status: string): void {
  const db = getDb();
  db.update(services)
    .set({ lastHealthy: healthy ? Date.now() : null, lastStatus: status, updatedAt: Date.now() })
    .where(eq(services.kind, kind))
    .run();
}

export function upsertLibrary(lib: Omit<Library, "id">): void {
  const db = getDb();
  const existing = db.select().from(libraries).where(eq(libraries.key, lib.key)).get();
  if (existing) db.update(libraries).set(lib).where(eq(libraries.key, lib.key)).run();
  else db.insert(libraries).values(lib).run();
}

export function listLibraries(): Library[] {
  return getDb().select().from(libraries).all();
}

export function getLibrary(key: string): Library | undefined {
  return getDb().select().from(libraries).where(eq(libraries.key, key)).get();
}

/**
 * Forget a destination library. Returns false when there was nothing to remove.
 * Only the definition goes — no file on disk is touched, and completed jobs keep
 * their `libraryKey` as a record of where content actually went.
 */
export function deleteLibrary(key: string): boolean {
  return getDb().delete(libraries).where(eq(libraries.key, key)).run().changes > 0;
}

/** Jobs that would be left pointing at nothing if this library disappeared. */
export function activeJobsForLibrary(key: string): number {
  const rows = getDb().select().from(jobs)
    .where(and(eq(jobs.libraryKey, key), inArray(jobs.status, ["queued", "running"])))
    .all();
  return rows.length;
}
