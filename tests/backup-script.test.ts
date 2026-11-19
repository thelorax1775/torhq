import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const REPO = resolve(__dirname, "..");
const SCRIPT = join(REPO, "scripts", "backup.sh");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function setup(users: number, withEnv = true) {
  const root = mkdtempSync(join(tmpdir(), "torhq-bk-"));
  dirs.push(root);
  mkdirSync(join(root, "data"));
  const dbPath = join(root, "data", "torhq.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("create table users (id integer primary key, name text)");
  for (let i = 0; i < users; i++) db.prepare("insert into users (name) values (?)").run(`user${i}`);
  db.close();
  const envFile = join(root, "torhq.env");
  if (withEnv) writeFileSync(envFile, "TORHQ_MASTER_KEY=dummy-not-a-real-key\n");
  const dest = join(root, "bk");
  const r = spawnSync("bash", ["-c", 'umask 022; exec bash "$0" "$1"', SCRIPT, dest], {
    env: { ...process.env, TORHQ_APP_DIR: REPO, TORHQ_DB: dbPath, TORHQ_ENV_FILE: envFile },
    encoding: "utf8",
  });
  return { root, dest, r };
}
const mode = (p: string) => statSync(p).mode & 0o777;
const list = (d: string) => readdirSync(d);

describe("scripts/backup.sh", () => {
  it("sets umask 077 before the first write", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const u = text.indexOf("umask 077");
    expect(u).toBeGreaterThan(-1);
    expect(u).toBeLessThan(text.indexOf("mkdir"));
    expect(u).toBeLessThan(text.indexOf("cp "));
  });

  it("writes one private tarball and nothing else", () => {
    const { dest, r, root } = setup(1);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Backup written: .*torhq-\d{8}-\d{6}\.tar\.gz \(1 user account\(s\)\)/);
    const files = list(dest);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^torhq-\d{8}-\d{6}\.tar\.gz$/);
    expect(mode(join(dest, files[0]))).toBe(0o600);
    expect(mode(dest)).toBe(0o700);

    const out = join(root, "x");
    mkdirSync(out);
    const t = spawnSync("tar", ["-xzf", join(dest, files[0]), "-C", out], { encoding: "utf8" });
    expect(t.status, t.stderr).toBe(0);
    const members = list(out).sort();
    expect(members).toHaveLength(2);
    expect(members[0]).toMatch(/\.db$/);
    expect(members[1]).toMatch(/\.env$/);
    const db = new Database(join(out, members[0]), { readonly: true });
    const row = db.prepare("select count(*) c from users").get() as { c: number };
    db.close();
    expect(row.c).toBe(1);
  });

  it("refuses a backup with no user accounts and leaves nothing behind", () => {
    const { dest, r } = setup(0);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("contains no user accounts");
    expect(list(dest)).toEqual([]);
  });

  it("leaves no loose files when it fails midway", () => {
    const { dest, r } = setup(1, false);
    expect(r.status).not.toBe(0);
    expect(list(dest)).toEqual([]);
  });
});
