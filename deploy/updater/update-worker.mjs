/**
 * TorHQ self-update worker. Installed root-owned at
 * /usr/local/lib/torhq/update-worker.mjs and always run as the torhq user by
 * /usr/local/sbin/torhq-update, one phase per invocation:
 *
 *   take              claim the web UI's request file; print the action
 *   check             fetch origin and record how far behind HEAD is
 *   apply             backup, fast-forward, npm ci, build, migrate
 *                     (exit 0 = restart needed, 10 = nothing to restart)
 *   finish            after the root wrapper restarts the service: wait for
 *                     /health and record the final state
 *
 * Every phase reports through <data>/update/status.json and update.log, which
 * the service reads back for the UI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ENV_FILE = process.env.TORHQ_ENV_FILE ?? "/etc/torhq/torhq.env";
const APP_DIR = process.env.TORHQ_APP_DIR ?? "/srv/torhq/app";
const fileEnv = loadEnvFile(ENV_FILE);
const DATA_DIR = fileEnv.TORHQ_DATA_DIR ?? "/srv/torhq/data";
const DIR = join(DATA_DIR, "update");
const REQUEST = join(DIR, "request");
const STATUS = join(DIR, "status.json");
const LOG = join(DIR, "update.log");
const NOTHING_TO_RESTART = 10;

/** Parse KEY=VALUE lines the way the systemd EnvironmentFile does, closely enough for torhq.env. */
function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS, "utf8")); } catch { return {}; }
}

function writeStatus(patch) {
  mkdirSync(DIR, { recursive: true });
  const next = { ...readStatus(), ...patch, updatedAt: Date.now() };
  const tmp = `${STATUS}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, STATUS);
}

function log(line) {
  appendFileSync(LOG, `${line}\n`);
}

/**
 * Optional GitHub token (TORHQ_GITHUB_TOKEN in the env file; never from the UI) for a private
 * repo. Handed to git through GIT_CONFIG_* environment variables so it never appears in a
 * command line, the log or the status file.
 */
function gitAuthEnv() {
  const token = fileEnv.TORHQ_GITHUB_TOKEN;
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(...args) {
  return execFileSync("git", ["-C", APP_DIR, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...gitAuthEnv() },
  }).trim();
}

function fetchOrigin() {
  try {
    git("fetch", "--quiet", "origin");
  } catch {
    const hint = fileEnv.TORHQ_GITHUB_TOKEN
      ? "check the network and that TORHQ_GITHUB_TOKEN can read the repository"
      : "check the network; a private repository needs TORHQ_GITHUB_TOKEN in the env file";
    throw new Error(`Cannot reach GitHub (git fetch failed) — ${hint}`);
  }
}

function run(step, cmd, args, env = {}) {
  writeStatus({ step });
  log(`\n==> ${step}: ${[cmd, ...args].join(" ")}`);
  const fd = openSync(LOG, "a");
  try {
    const r = spawnSync(cmd, args, { cwd: APP_DIR, stdio: ["ignore", fd, fd], env: { ...process.env, ...gitAuthEnv(), ...env } });
    if (r.error) throw new Error(`${step} could not start: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${step} failed (exit ${r.status ?? r.signal}) — see the log below`);
  } finally {
    closeSync(fd);
  }
}

function headCommit() {
  return { sha: git("rev-parse", "--short", "HEAD"), subject: git("log", "-1", "--format=%s") };
}

function revisions() {
  log("==> fetch: git fetch origin");
  fetchOrigin();
  const commits = git("log", "--format=%h%x09%s", "HEAD..@{u}")
    .split("\n").filter(Boolean)
    .map((l) => { const [sha, ...rest] = l.split("\t"); return { sha, subject: rest.join("\t") }; });
  let diverged = false;
  try { git("merge-base", "--is-ancestor", "HEAD", "@{u}"); } catch { diverged = true; }
  return {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    current: headCommit(),
    latest: git("rev-parse", "--short", "@{u}"),
    behind: Number(git("rev-list", "--count", "HEAD..@{u}")),
    diverged,
    commits: commits.slice(0, 30),
    checkedAt: Date.now(),
  };
}

function summary(rev) {
  if (rev.diverged) return `Local checkout has diverged from origin/${rev.branch}; a fast-forward update is not possible`;
  if (rev.behind === 0) return "Up to date";
  return `${rev.behind} new commit${rev.behind === 1 ? "" : "s"} on origin/${rev.branch}`;
}

/**
 * A step failed after the pull: put the previous commit back (the running service was never
 * restarted, so it is still the old version) and best-effort rebuild it so a later restart
 * starts the old version too. The backup taken before the pull is left untouched.
 * Returns an empty string on full success, otherwise a warning message for the admin.
 */
function rollback(previous) {
  try {
    log(`\n==> rollback: restoring ${previous.slice(0, 7)}`);
    if (git("rev-parse", "HEAD") !== previous) run("rollback", "git", ["reset", "--hard", previous]);
    try {
      run("rollback-install", "npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]);
      run("rollback-build", "npm", ["run", "build"]);
    } catch (e) {
      const msg = `The previous version was restored but could not be rebuilt, so TorHQ will not start after its next restart. Run npm ci and npm run build in the app folder by hand. App folder: ${APP_DIR}`;
      log(`rollback rebuild failed: ${e instanceof Error ? e.message : e}`);
      return msg;
    }
    writeStatus({ current: headCommit() });
    return "";
  } catch (e) {
    const shortSha = previous.slice(0, 7);
    const msg = `Git reset failed; restore ${shortSha} by hand.`;
    log(`rollback failed: ${e instanceof Error ? e.message : e} — restore ${previous} by hand`);
    return msg;
  }
}

function take() {
  if (!existsSync(REQUEST)) return;
  const action = readFileSync(REQUEST, "utf8").trim();
  rmSync(REQUEST, { force: true });
  if (action !== "check" && action !== "apply") return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LOG, `TorHQ ${action} started ${new Date().toISOString()}\n`);
  writeStatus({ state: "running", action, step: null, message: null, startedAt: Date.now(), finishedAt: null });
  process.stdout.write(action);
}

function check() {
  const rev = revisions();
  writeStatus({ ...rev, state: "done", step: null, message: summary(rev), finishedAt: Date.now() });
}

function apply() {
  const rev = revisions();
  writeStatus(rev);
  if (rev.diverged) throw new Error(summary(rev));
  if (rev.behind === 0) {
    writeStatus({ state: "done", step: null, message: "Already up to date — nothing to install", finishedAt: Date.now() });
    return NOTHING_TO_RESTART;
  }
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) throw new Error(`${APP_DIR} has uncommitted changes; refusing to update over them:\n${dirty}`);

  const previous = git("rev-parse", "HEAD");
  run("backup", "bash", [join(APP_DIR, "scripts/backup.sh")]);
  try {
    run("pull", "git", ["pull", "--ff-only"]);
    run("install", "npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]);
    run("build", "npm", ["run", "build"]);
    run("migrate", "npm", ["run", "migrate", "--workspace", "server"], fileEnv);
  } catch (e) {
    const rollbackMsg = rollback(previous);
    if (rollbackMsg) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n${rollbackMsg}`);
    }
    throw e;
  }
  writeStatus({ state: "restarting", step: "restart", current: headCommit(), behind: 0, commits: [] });
  log("\n==> restart: systemctl restart torhq");
  return 0;
}

async function finish() {
  const host = fileEnv.TORHQ_HOST && fileEnv.TORHQ_HOST !== "0.0.0.0" ? fileEnv.TORHQ_HOST : "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${fileEnv.TORHQ_PORT ?? "8787"}/health`;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        log("TorHQ is back up.");
        writeStatus({ state: "done", step: null, current: headCommit(), message: "Updated and restarted", finishedAt: Date.now() });
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("TorHQ did not answer /health within a minute of restarting — check journalctl -u torhq");
}

async function main(phase) {
  try {
    if (phase === "take") return take();
    if (phase === "check") return check();
    if (phase === "apply") return apply();
    if (phase === "finish") return await finish();
    throw new Error(`unknown phase: ${phase}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      log(`\nerror: ${message}`);
      writeStatus({ state: "failed", message, finishedAt: Date.now() });
    } catch {}
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = (await main(process.argv[2])) ?? 0;
