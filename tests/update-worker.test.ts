import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * deploy/updater/update-worker.mjs, run as a child process against a throwaway
 * origin repo + clone inside a temp dir. Nothing outside the temp dir is touched.
 */
const WORKER = resolve(__dirname, "..", "deploy", "updater", "update-worker.mjs");
const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
};

function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

interface Opts { buildFails?: boolean }

function setup(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "torhq-uw-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const app = join(root, "app");
  const data = join(root, "data");
  const marks = join(root, "marks");
  mkdirSync(marks);
  mkdirSync(data);
  mkdirSync(seed);
  sh(root, "git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh(seed, "git", ["init", "-q", "-b", "main"]);
  sh(seed, "git", ["remote", "add", "origin", origin]);

  const write = (rel: string, text: string) => {
    mkdirSync(join(seed, rel, ".."), { recursive: true });
    writeFileSync(join(seed, rel), text);
  };
  write("package.json", JSON.stringify({
    name: "fake-torhq", version: "1.0.0", private: true, workspaces: ["server"],
    scripts: { build: opts.buildFails ? "exit 1" : `git rev-parse HEAD > ${marks}/build` },
  }));
  write("server/package.json", JSON.stringify({
    name: "server", version: "1.0.0", private: true,
    scripts: { migrate: `git rev-parse HEAD > ${marks}/migrate` },
  }));
  write("package-lock.json", JSON.stringify({
    name: "fake-torhq", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "fake-torhq", version: "1.0.0", workspaces: ["server"] },
      "node_modules/server": { resolved: "server", link: true },
      server: { version: "1.0.0" },
    },
  }));
  // Stub backup: records the HEAD it saw, so we can tell it ran before the pull.
  write("scripts/backup.sh", `#!/bin/bash\ngit rev-parse HEAD > ${marks}/backup\n`);
  write("file.txt", "one\n");
  sh(seed, "git", ["add", "-A"]);
  sh(seed, "git", ["commit", "-q", "-m", "initial"]);
  sh(seed, "git", ["push", "-q", "origin", "main"]);
  sh(root, "git", ["clone", "-q", "-b", "main", origin, app]);

  const envFile = join(root, "torhq.env");
  writeFileSync(envFile, `TORHQ_DATA_DIR=${data}\nTORHQ_PORT=1\n`);

  // `take` creates this directory on a real install; the other phases assume it exists.
  const update = join(data, "update");
  mkdirSync(update, { recursive: true });
  const api = {
    root, app, data, marks, envFile,
    status: () => JSON.parse(readFileSync(join(update, "status.json"), "utf8")),
    log: () => readFileSync(join(update, "update.log"), "utf8"),
    mark: (n: string) => join(marks, n),
    request: (text: string) => { mkdirSync(update, { recursive: true }); writeFileSync(join(update, "request"), text); },
    requestPath: join(update, "request"),
    head: (dir = app) => sh(dir, "git", ["rev-parse", "HEAD"]),
    originHead: () => sh(root, "git", ["--git-dir", origin, "rev-parse", "main"]),
    /** Commit on origin (via the seed clone). */
    pushToOrigin(subject: string) {
      writeFileSync(join(seed, "file.txt"), `${subject}\n`);
      sh(seed, "git", ["commit", "-q", "-am", subject]);
      sh(seed, "git", ["push", "-q", "origin", "main"]);
    },
    env: (extra: Record<string, string> = {}) => ({
      ...process.env, ...GIT_ENV, TORHQ_APP_DIR: app, TORHQ_ENV_FILE: envFile, ...extra,
    }),
    run(phase: string) {
      return spawnSync("node", [WORKER, phase], { env: api.env(), encoding: "utf8", timeout: 60_000 });
    },
  };
  return api;
}

describe("deploy/updater/update-worker.mjs", () => {
  it("take: claims a check request, prints it, and marks the run as started", () => {
    const t = setup();
    t.request("check\n");
    const r = t.run("take");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("check");
    expect(existsSync(t.requestPath)).toBe(false);
    expect(t.status()).toMatchObject({ state: "running", action: "check" });
  });

  it("take: no request prints nothing; an unknown request is discarded silently", () => {
    const t = setup();
    const none = t.run("take");
    expect(none.status).toBe(0);
    expect(none.stdout).toBe("");

    t.request("rm -rf /\n");
    const bogus = t.run("take");
    expect(bogus.status).toBe(0);
    expect(bogus.stdout).toBe("");
    expect(existsSync(t.requestPath)).toBe(false);
    expect(existsSync(join(t.data, "update", "status.json"))).toBe(false);
  });

  it("check: reports two new commits on origin", () => {
    const t = setup();
    t.pushToOrigin("add widget");
    t.pushToOrigin("fix widget");
    const r = t.run("check");
    expect(r.status).toBe(0);
    const s = t.status();
    expect(s).toMatchObject({ state: "done", behind: 2, diverged: false });
    expect(s.commits.map((c: { subject: string }) => c.subject).sort()).toEqual(["add widget", "fix widget"]);
    expect(t.head()).not.toBe(t.originHead()); // check never moves HEAD
  });

  it("check: up to date", () => {
    const t = setup();
    const r = t.run("check");
    expect(r.status).toBe(0);
    expect(t.status()).toMatchObject({ state: "done", behind: 0, message: "Up to date" });
  });

  it("apply: up to date exits 10 and does not take a backup", () => {
    const t = setup();
    const r = t.run("apply");
    expect(r.status).toBe(10);
    expect(t.status().state).toBe("done");
    expect(existsSync(t.mark("backup"))).toBe(false);
    expect(existsSync(t.mark("build"))).toBe(false);
  });

  it("apply: backs up, pulls, installs, builds and migrates, then asks for a restart", () => {
    const t = setup();
    const before = t.head();
    t.pushToOrigin("new feature");
    const r = t.run("apply");
    expect(r.status, r.stderr).toBe(0);
    expect(t.head()).toBe(t.originHead());
    for (const m of ["backup", "build", "migrate"]) expect(existsSync(t.mark(m)), m).toBe(true);
    // backup saw the old HEAD (ran before the pull); build and migrate saw the new one
    expect(readFileSync(t.mark("backup"), "utf8").trim()).toBe(before);
    expect(readFileSync(t.mark("build"), "utf8").trim()).toBe(t.originHead());
    expect(readFileSync(t.mark("migrate"), "utf8").trim()).toBe(t.originHead());
    expect(statSync(t.mark("backup")).mtimeMs).toBeLessThanOrEqual(statSync(t.mark("build")).mtimeMs);
    expect(t.status()).toMatchObject({ state: "restarting", behind: 0 });
    const log = t.log();
    for (const step of ["backup", "pull", "install", "build", "migrate"]) expect(log).toContain(`==> ${step}:`);
  });

  it("apply: refuses over an uncommitted change to a tracked file", () => {
    const t = setup();
    t.pushToOrigin("new feature");
    writeFileSync(join(t.app, "file.txt"), "local edit\n");
    const before = t.head();
    const r = t.run("apply");
    expect(r.status).not.toBe(0);
    const s = t.status();
    expect(s.state).toBe("failed");
    expect(s.message).toContain("file.txt");
    expect(t.head()).toBe(before);
    expect(existsSync(t.mark("backup"))).toBe(false);
  });

  it("apply: refuses when the checkout has diverged from origin", () => {
    const t = setup();
    writeFileSync(join(t.app, "local.txt"), "mine\n");
    sh(t.app, "git", ["add", "local.txt"]);
    sh(t.app, "git", ["commit", "-q", "-m", "local only"]);
    t.pushToOrigin("upstream change");
    const before = t.head();
    const r = t.run("apply");
    expect(r.status).not.toBe(0);
    expect(t.status()).toMatchObject({ state: "failed", diverged: true });
    expect(t.status().message).toContain("diverged");
    expect(t.head()).toBe(before);
    expect(existsSync(t.mark("backup"))).toBe(false);
  });

  it("apply: a failing build stops the update before migrate", () => {
    const t = setup({ buildFails: true });
    t.pushToOrigin("new feature");
    const r = t.run("apply");
    expect(r.status).not.toBe(0);
    const s = t.status();
    expect(s.state).toBe("failed");
    expect(s.message).toContain("build");
    expect(existsSync(t.mark("migrate"))).toBe(false);
  });

  it("apply: a failing step rolls the checkout back to the old version and keeps the backup", () => {
    const t = setup({ buildFails: true });
    const before = t.head();
    t.pushToOrigin("new feature");
    const r = t.run("apply");
    expect(r.status).not.toBe(0);
    expect(t.head()).toBe(before);
    expect(t.status()).toMatchObject({ state: "failed" });
    expect(t.log()).toContain("rollback");
    expect(readFileSync(t.mark("backup"), "utf8").trim()).toBe(before);
    expect(readFileSync(join(t.app, "file.txt"), "utf8")).toBe("one\n");
  });

  it("check/apply: GitHub unreachable reports it plainly and changes nothing", () => {
    const t = setup();
    const before = t.head();
    sh(t.app, "git", ["remote", "set-url", "origin", join(t.root, "gone.git")]);
    for (const phase of ["check", "apply"]) {
      const r = t.run(phase);
      expect(r.status).not.toBe(0);
      expect(t.status()).toMatchObject({ state: "failed" });
      expect(t.status().message).toContain("Cannot reach GitHub");
      expect(t.status().message).toContain("TORHQ_GITHUB_TOKEN");
    }
    expect(t.head()).toBe(before);
    expect(existsSync(t.mark("backup"))).toBe(false);
  });

  it("never writes the GitHub token to the log or status", () => {
    const t = setup();
    const secret = "ghp_SECRET_TOKEN_VALUE_123";
    writeFileSync(t.envFile, `TORHQ_DATA_DIR=${t.data}\nTORHQ_PORT=1\nTORHQ_GITHUB_TOKEN=${secret}\n`);
    t.pushToOrigin("new feature");
    t.run("apply");
    sh(t.app, "git", ["remote", "set-url", "origin", join(t.root, "gone.git")]);
    t.run("check");
    expect(t.log()).not.toContain(secret);
    expect(JSON.stringify(t.status())).not.toContain(secret);
    expect(t.status().message).toContain("Cannot reach GitHub");
  });

  it("check: compares against the origin head - behind, equal, and ahead-of-origin (diverged)", () => {
    const t = setup();
    expect(t.run("check").status).toBe(0);
    expect(t.status()).toMatchObject({ behind: 0, diverged: false });
    t.pushToOrigin("newer");
    t.run("check");
    expect(t.status()).toMatchObject({ behind: 1, diverged: false, latest: t.originHead().slice(0, 7) });
  });

  it("finish: records success once /health answers", async () => {
    const t = setup();
    const server = createServer((req, res) => {
      res.statusCode = req.url === "/health" ? 200 : 404;
      res.end("ok");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(t.envFile, `TORHQ_DATA_DIR=${t.data}\nTORHQ_HOST=127.0.0.1\nTORHQ_PORT=${port}\n`);
      // async spawn so this process's event loop can serve /health
      const child = spawn("node", [WORKER, "finish"], { env: t.env(), stdio: "ignore" });
      const code = await new Promise<number | null>((done) => child.on("close", done));
      expect(code).toBe(0);
      expect(t.status()).toMatchObject({ state: "done", message: "Updated and restarted" });
    } finally {
      server.close();
    }
  }, 30_000);
});
