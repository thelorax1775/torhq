#!/usr/bin/env node
/**
 * Screenshot smoke test for the web UI.
 *
 *   CHROMIUM_PATH=/path/to/chrome node scripts/ui-screenshots.mjs [outDir]
 *
 * Needs a built app (`npm run build`). Starts the server against a throwaway
 * data dir and master key, seeds an admin and a member, signs in as each in a
 * real headless Chromium and saves one PNG per routed page at 1280px and 390px:
 *   <outDir>/admin/<page>-1280.png, <outDir>/member/<page>-390.png, ...
 * No external service is configured, so pages show their empty/unconfigured
 * states. Exits non-zero if a page fails to load or logs a page error.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import net from "node:net";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, "screenshots"));
const chromium = process.env.CHROMIUM_PATH;
if (!chromium) { console.error("Set CHROMIUM_PATH to a Chromium/Chrome binary."); process.exit(2); }
if (!existsSync(join(root, "server/dist/index.js")) || !existsSync(join(root, "web/dist/index.html"))) {
  console.error("Build first: npm run build"); process.exit(2);
}

// [path, name, adminOnly]. Keep in step with web/src/App.tsx.
const PAGES = [
  ["/", "home"], ["/dashboard", "dashboard", true], ["/discover", "discover"], ["/search", "search", true],
  ["/activity", "activity"], ["/activity?view=requests", "activity-requests", true], ["/transfers", "transfers", true],
  ["/history", "history", true], ["/books", "books"], ["/audiobooks", "audiobooks"], ["/imports", "imports", true],
  ["/libraries", "libraries", true], ["/mounts", "mounts", true], ["/services", "services", true],
  ["/settings", "settings", true], ["/users", "users", true], ["/does-not-exist", "not-found"],
];
const VIEWPORTS = [[1280, 800], [390, 844]];
const ADMIN = { username: "admin", password: "admin-password-1" };
const MEMBER = { username: "member", password: "member-password-1" };

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  s.on("error", rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "torhq-shots-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [join(root, "server/dist/index.js")], {
  cwd: root,
  env: {
    ...process.env, NODE_ENV: "production", TORHQ_HOST: "127.0.0.1", TORHQ_PORT: String(port),
    TORHQ_DATA_DIR: join(tmp, "data"), TORHQ_APPROVED_ROOTS: tmp,
    TORHQ_MASTER_KEY: randomBytes(48).toString("base64"), TORHQ_LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
mkdirSync(join(tmp, "data"), { recursive: true });

let browser; let failures = 0;
async function cleanup() {
  try { await browser?.close(); } catch { /* already gone */ }
  server.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}

async function post(path, body, cookie, csrf) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res;
}

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/auth/me`)).ok) break; } catch { /* not up yet */ }
    if (server.exitCode !== null) throw new Error("server exited during startup");
    if (i > 100) throw new Error("server did not start in 20s");
    await sleep(200);
  }
  // Seed: first-run register makes the admin; the admin then creates the member.
  const reg = await post("/api/auth/register", ADMIN);
  const { csrfToken } = await reg.json();
  const cookie = reg.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await post("/api/users", MEMBER, cookie, csrfToken);
  // One member book request, so Activity's Requests tab and the nav badge have something to show.
  const ml = await post("/api/auth/login", MEMBER);
  const mCookie = ml.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await post("/api/books/request", { title: "Frankenstein", author: "Mary Shelley" }, mCookie, (await ml.json()).csrfToken);

  browser = await puppeteer.launch({
    executablePath: chromium, headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  for (const [who, creds] of [["admin", ADMIN], ["member", MEMBER]]) {
    const dir = join(outDir, who);
    mkdirSync(dir, { recursive: true });
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(base + "/", { waitUntil: "networkidle0" });
    await page.type("#login-username", creds.username);
    await page.type("#login-password", creds.password);
    await page.click("button[type=submit]");
    await page.waitForSelector(".shell", { timeout: 15000 });

    // Member sees every non-admin page; admin-only ones bounce to Search,
    // which is already pictured, so they are skipped to keep names honest.
    const pages = PAGES.filter(([, , adminOnly]) => who === "admin" || !adminOnly);
    for (const [w, h] of VIEWPORTS) {
      await page.setViewport({ width: w, height: h });
      for (const [path, name] of pages) {
        errors.length = 0;
        // Client-side navigation: full reloads of every page x viewport would
        // trip the server's global 300 req/min rate limit.
        await page.evaluate((to) => {
          history.pushState({}, "", to);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, path);
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 15000 }).catch(() => {});
        await page.waitForSelector(".content", { timeout: 15000 }).catch(async (e) => {
          console.error(`debug ${who} ${path} @${w}:`, (await page.evaluate(() => document.body.innerText)).slice(0, 300));
          throw e;
        });
        const file = join(dir, `${name}-${w}.png`);
        await page.screenshot({ path: file, fullPage: true });
        if (errors.length) { failures++; console.error(`FAIL ${who} ${path} @${w}: ${errors.join("; ")}`); }
        else console.log(`ok   ${file}`);
      }
    }
    await ctx.close();
  }
} catch (e) {
  failures++;
  console.error("ui-screenshots failed:", e);
} finally {
  await cleanup();
}
console.log(failures ? `${failures} failure(s)` : `done: screenshots in ${outDir}`);
process.exit(failures ? 1 : 0);
