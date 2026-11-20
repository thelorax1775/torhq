import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { deriveKey } from "../server/src/lib/crypto.js";
import { upsertService, listServicesSafe } from "../server/src/config/store.js";
import { mergeExtra, safeExtra, hasExtraConfig } from "../server/src/config/extra.js";
import { loadEnv } from "../server/src/config/env.js";

describe("env boolean parsing (env strings, not Boolean())", () => {
  const base = { TORHQ_MASTER_KEY: "test-master-key-0123456789" } as any;
  it("treats the string 'false' as false (the Secure-cookie bug)", () => {
    const env = loadEnv({ ...base, TORHQ_COOKIE_SECURE: "false", TORHQ_TRUST_PROXY: "false" });
    expect(env.TORHQ_COOKIE_SECURE).toBe(false);
    expect(env.TORHQ_TRUST_PROXY).toBe(false);
  });
  it("treats 'true'/'1'/'yes' as true and everything else as false", () => {
    expect(loadEnv({ ...base, TORHQ_COOKIE_SECURE: "true" }).TORHQ_COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...base, TORHQ_COOKIE_SECURE: "1" }).TORHQ_COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...base, TORHQ_COOKIE_SECURE: "yes" }).TORHQ_COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...base, TORHQ_COOKIE_SECURE: "0" }).TORHQ_COOKIE_SECURE).toBe(false);
    expect(loadEnv({ ...base }).TORHQ_COOKIE_SECURE).toBe(false); // unset
  });
});

describe("typed extra config: mergeExtra", () => {
  it("coerces and stores a Kavita libraryId", () => {
    expect(mergeExtra("kavita", { libraryId: "3" }, {})).toEqual({ libraryId: 3 });
  });
  it("clears an omitted non-secret field (libraryId)", () => {
    expect(mergeExtra("kavita", {}, { libraryId: 3 })).toEqual({});
  });
  it("stores a submitted slskd webhook token", () => {
    expect(mergeExtra("slskd", { webhookToken: "supersecrettoken" }, {})).toEqual({ webhookToken: "supersecrettoken" });
  });
  it("retains an existing webhook token when the save omits it (write-only)", () => {
    expect(mergeExtra("slskd", {}, { webhookToken: "keepme12" })).toEqual({ webhookToken: "keepme12" });
    expect(mergeExtra("slskd", { webhookToken: "" }, { webhookToken: "keepme12" })).toEqual({ webhookToken: "keepme12" });
  });
  it("rejects an invalid (too short) webhook token", () => {
    expect(() => mergeExtra("slskd", { webhookToken: "short" }, {})).toThrow();
  });
  it("ignores extra for kinds without a schema", () => {
    // jellyfin has no configurable extra: an unknown field is dropped entirely.
    expect(mergeExtra("jellyfin", { anything: 1 }, {})).toEqual({});
    expect(hasExtraConfig("jellyfin")).toBe(false);
    expect(hasExtraConfig("slskd")).toBe(true);
  });
  it("keeps the acquire placement defaults on each *arr", () => {
    // The Get page saves where an *arr should put what it adds. Unknown fields
    // are still dropped, so an old client cannot write arbitrary config.
    for (const kind of ["radarr", "sonarr", "lidarr"]) {
      expect(hasExtraConfig(kind)).toBe(true);
      expect(mergeExtra(kind, { rootFolderPath: "/mnt/storage/movies", qualityProfileId: 4, anything: 1 }, {}))
        .toEqual({ rootFolderPath: "/mnt/storage/movies", qualityProfileId: 4 });
    }
    expect(mergeExtra("lidarr", { metadataProfileId: 2 }, {})).toEqual({ metadataProfileId: 2 });
  });
  it("treats an omitted extra as leave-alone, so an unrelated save keeps the defaults", () => {
    // Services sends no extra for these kinds; that must not wipe placement.
    const saved = { rootFolderPath: "/mnt/storage/movies", qualityProfileId: 4 };
    expect(mergeExtra("radarr", undefined, saved)).toEqual(saved);
  });
});

describe("typed extra config: safeExtra never leaks secrets", () => {
  it("projects a secret field to a boolean flag", () => {
    expect(safeExtra("slskd", { webhookToken: "x" })).toEqual({ webhookTokenSet: true });
    expect(safeExtra("slskd", {})).toEqual({ webhookTokenSet: false });
  });
  it("passes non-secret fields through", () => {
    expect(safeExtra("kavita", { libraryId: 3 })).toEqual({ libraryId: 3 });
  });
});

describe("secret mask in listServicesSafe", () => {
  let dir: string;
  const masterKey = deriveKey("secret-mask-test-key");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "torhq-secret-mask-"));
    initDb(dir);
    runMigrations();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 8 bullets for a service with a secret, null without", () => {
    upsertService(
      { kind: "radarr", label: "Radarr", baseUrl: "http://x", secret: "abcd1234wxyz" },
      masterKey
    );
    const withSecret = listServicesSafe().find((s) => s.kind === "radarr");
    expect(withSecret!.secretMask).toBe("••••••••");

    upsertService(
      { kind: "sonarr", label: "Sonarr", baseUrl: "http://y", enabled: true },
      masterKey
    );
    const withoutSecret = listServicesSafe().find((s) => s.kind === "sonarr");
    expect(withoutSecret!.secretMask).toBeNull();
  });
});
