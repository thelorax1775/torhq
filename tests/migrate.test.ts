import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getRaw } from "../server/src/db/index.js";
import { runMigrations, appliedVersions } from "../server/src/db/migrate.js";

/** Every migration version that ships today; extend when adding a migration. */
const ALL_VERSIONS = [1, 2, 3];

const dirs: string[] = [];
function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "torhq-mig-"));
  dirs.push(dir);
  initDb(dir);
}
function tableExists(name: string): boolean {
  const r = getRaw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!r;
}
function columns(table: string): string[] {
  return (getRaw().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("forward-only migrations", () => {
  it("applies the baseline on a fresh database", () => {
    freshDb();
    runMigrations();
    expect(appliedVersions()).toEqual(ALL_VERSIONS);
    for (const t of ["users", "sessions", "services", "libraries", "jobs", "activity", "schema_migrations"]) {
      expect(tableExists(t)).toBe(true);
    }
  });

  it("is idempotent: re-running records nothing new", () => {
    freshDb();
    runMigrations();
    runMigrations();
    runMigrations();
    expect(appliedVersions()).toEqual(ALL_VERSIONS);
    const count = getRaw().prepare("SELECT COUNT(*) c FROM schema_migrations").get() as { c: number };
    expect(count.c).toBe(ALL_VERSIONS.length);
  });

  it("records the baseline on a legacy DB (tables already present, no schema_migrations) without data loss", () => {
    freshDb();
    // Simulate a database deployed before schema_migrations existed: the tables
    // are already there (from the old CREATE IF NOT EXISTS bootstrap) and hold data.
    const db = getRaw();
    db.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("legacy-admin", "hash");

    runMigrations();

    expect(appliedVersions()).toEqual(ALL_VERSIONS);
    // Pre-existing data survives (the baseline used IF NOT EXISTS, no rewrite).
    const user = db.prepare("SELECT username FROM users").get() as { username: string };
    expect(user.username).toBe("legacy-admin");
    // And the rest of the baseline tables now exist too.
    expect(tableExists("jobs")).toBe(true);
  });
});

describe("v2 — libraries.import_mode", () => {
  it("adds the column with a default that preserves the old behaviour", () => {
    freshDb();
    runMigrations();
    expect(columns("libraries")).toContain("import_mode");

    // A row written without naming the column must not silently become a
    // hardlink import: that would change whether the source gets deleted.
    getRaw().prepare(`INSERT INTO libraries (key, label, kind, target_service, dest_path, staging_path)
      VALUES ('legacy', 'Legacy', 'books', 'kavita', '/d', '/s')`).run();
    const row = getRaw().prepare("SELECT import_mode FROM libraries WHERE key='legacy'").get() as { import_mode: string };
    expect(row.import_mode).toBe("move");
  });

  it("backfills a library table created before the column existed", () => {
    freshDb();
    const db = getRaw();
    db.exec(`CREATE TABLE libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      kind TEXT NOT NULL, target_service TEXT NOT NULL, dest_path TEXT NOT NULL,
      staging_path TEXT NOT NULL, rescan INTEGER NOT NULL DEFAULT 1)`);
    db.prepare(`INSERT INTO libraries (key, label, kind, target_service, dest_path, staging_path)
      VALUES ('old', 'Old', 'music', 'navidrome', '/d', '/s')`).run();

    runMigrations();

    const row = db.prepare("SELECT import_mode FROM libraries WHERE key='old'").get() as { import_mode: string };
    expect(row.import_mode).toBe("move");
  });
});
