import type Database from "better-sqlite3";
import { getRaw, initDb } from "./index.js";
import { loadEnv } from "../config/env.js";

/**
 * Forward-only, versioned migrations.
 *
 * Each migration has a monotonically increasing `version`; applied versions are
 * recorded in `schema_migrations`. On startup we apply every migration whose
 * version has not yet been recorded, in order, each inside its own transaction.
 * This is safe to run repeatedly and — crucially — safe on already-deployed
 * databases: the baseline migration uses `IF NOT EXISTS`, so an existing v1 DB
 * with no `schema_migrations` row simply records version 1 without change, and
 * later migrations then apply on top. Schema evolution beyond the baseline
 * (ALTER TABLE, new indexes, backfills) is expressed as new numbered
 * migrations rather than by mutating the baseline DDL.
 */
interface Migration {
  version: number;
  name: string;
  /** Called inside a transaction; must be idempotent-safe for its version. */
  up(db: Database.Database): void;
}

const BASELINE_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  secret_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  extra_json TEXT,
  last_healthy INTEGER,
  last_status TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_service TEXT NOT NULL,
  dest_path TEXT NOT NULL,
  staging_path TEXT NOT NULL,
  rescan INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT UNIQUE,
  library_key TEXT,
  source_path TEXT NOT NULL,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_next_idx ON jobs(next_run_at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  kind TEXT NOT NULL,
  service TEXT,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS activity_job_idx ON activity(job_id);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity(created_at);
`;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up: (db) => db.exec(BASELINE_DDL),
  },
  {
    version: 2,
    name: "libraries_add_import_mode",
    // Existing libraries keep the original copy-then-delete behaviour; "link" is
    // opt-in per library so enabling it can never silently start (or stop)
    // deleting a source directory that something else still depends on.
    up: (db) => {
      if (!hasColumn(db, "libraries", "import_mode")) {
        db.exec("ALTER TABLE libraries ADD COLUMN import_mode TEXT NOT NULL DEFAULT 'move'");
      }
    },
  },
  {
    version: 3,
    name: "settings",
    up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )`),
  },
  // Future schema changes go here as new numbered migrations, e.g.:
  // { version: 3, name: "jobs_add_started_at",
  //   up: (db) => { if (!hasColumn(db, "jobs", "started_at")) db.exec("ALTER TABLE jobs ADD COLUMN started_at INTEGER"); } },
];

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`);
}

/** True if `table` has `column` — useful for writing idempotent ALTER migrations. */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export function appliedVersions(db: Database.Database = getRaw()): number[] {
  ensureMigrationsTable(db);
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
  return rows.map((r) => r.version);
}

export function runMigrations(): void {
  const db = getRaw();
  ensureMigrationsTable(db);
  const applied = new Set(appliedVersions(db));
  const record = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name);
    });
    tx();
  }
}

// Allow `npm run migrate` standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  // eslint-disable-next-line no-console
  console.log("TorHQ migrations applied at", env.TORHQ_DATA_DIR, "→ versions", appliedVersions().join(", ") || "none");
}
