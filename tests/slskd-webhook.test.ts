import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { initDb } from "../server/src/db/index.js";
import { runMigrations } from "../server/src/db/migrate.js";
import { loadEnv } from "../server/src/config/env.js";
import { makeContext } from "../server/src/lib/context.js";
import { buildApp } from "../server/src/app.js";
import { upsertService, upsertLibrary, getLibrary } from "../server/src/config/store.js";
import { getJob } from "../server/src/queue/queue.js";

let app: FastifyInstance;
let dataDir: string;
let ctx: ReturnType<typeof makeContext>;
let masterKey: Buffer;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "torhq-slskd-webhook-"));
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  ctx = makeContext(env);
  masterKey = ctx.masterKey;
  app = await buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset DB state between tests by re-initializing
  const env = loadEnv({
    NODE_ENV: "test",
    TORHQ_MASTER_KEY: "test-master-key-0123456789",
    TORHQ_DATA_DIR: dataDir,
    TORHQ_APPROVED_ROOTS: dataDir,
  } as any);
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();
  ctx = makeContext(env);
  masterKey = ctx.masterKey;
  app = await buildApp(ctx);
  await app.ready();
});

async function postSlskd(body: any, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["x-torhq-token"] = token;
  return app.inject({
    method: "POST",
    url: "/webhooks/slskd",
    headers,
    payload: body,
  });
}

describe("slskd completed-download webhook", () => {
  describe("authentication", () => {
    it("returns 401 when no slskd service is saved at all", async () => {
      const res = await postSlskd({ localPath: "/x" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "invalid webhook token" });
    });

    it("returns 401 when slskd service exists but has no webhookToken, with and without header", async () => {
      upsertService(
        { kind: "slskd", label: "slskd", baseUrl: "http://127.0.0.1:1", extra: {} },
        masterKey
      );

      const withHeader = await postSlskd({ localPath: "/x" }, "whatever123");
      expect(withHeader.statusCode).toBe(401);
      expect(withHeader.json()).toMatchObject({ error: "invalid webhook token" });

      const withoutHeader = await postSlskd({ localPath: "/x" });
      expect(withoutHeader.statusCode).toBe(401);
      expect(withoutHeader.json()).toMatchObject({ error: "invalid webhook token" });
    });

    it("returns 401 for wrong token, missing token, or token prefix when correct token is saved", async () => {
      upsertService(
        {
          kind: "slskd",
          label: "slskd",
          baseUrl: "http://127.0.0.1:1",
          extra: { webhookToken: "correct-token-1" },
        },
        masterKey
      );

      const noHeader = await postSlskd({ localPath: "/x" });
      expect(noHeader.statusCode).toBe(401);
      expect(noHeader.json()).toMatchObject({ error: "invalid webhook token" });

      const wrongToken = await postSlskd({ localPath: "/x" }, "wrong-token-11");
      expect(wrongToken.statusCode).toBe(401);
      expect(wrongToken.json()).toMatchObject({ error: "invalid webhook token" });

      const prefixToken = await postSlskd({ localPath: "/x" }, "correct-token");
      expect(prefixToken.statusCode).toBe(401);
      expect(prefixToken.json()).toMatchObject({ error: "invalid webhook token" });
    });
  });

  describe("library validation", () => {
    beforeEach(async () => {
      upsertService(
        {
          kind: "slskd",
          label: "slskd",
          baseUrl: "http://127.0.0.1:1",
          extra: { webhookToken: "correct-token-1" },
        },
        masterKey
      );
    });

    it("returns 409 when correct token but no library with default key 'navidrome-music'", async () => {
      const res = await postSlskd({ localPath: "/x" }, "correct-token-1");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "library navidrome-music not configured" });
    });

    it("returns 409 when correct token but specified libraryKey does not exist", async () => {
      const res = await postSlskd({ localPath: "/y", libraryKey: "nope" }, "correct-token-1");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "library nope not configured" });
    });
  });

  describe("request validation", () => {
    beforeEach(async () => {
      upsertService(
        {
          kind: "slskd",
          label: "slskd",
          baseUrl: "http://127.0.0.1:1",
          extra: { webhookToken: "correct-token-1" },
        },
        masterKey
      );
      const tmp = mkdtempSync(join(tmpdir(), "torhq-lib-"));
      upsertLibrary({
        key: "navidrome-music",
        label: "Music",
        kind: "music",
        targetService: "navidrome",
        destPath: join(tmp, "m"),
        stagingPath: join(tmp, "s"),
        rescan: false,
        importMode: "move",
      });
    });

    it("returns 400 when localPath is missing from body", async () => {
      const res = await postSlskd({ filename: "a" }, "correct-token-1");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain("localPath");
    });
  });

  describe("successful enqueue", () => {
    let tmp: string;

    beforeEach(async () => {
      upsertService(
        {
          kind: "slskd",
          label: "slskd",
          baseUrl: "http://127.0.0.1:1",
          extra: { webhookToken: "correct-token-1" },
        },
        masterKey
      );
      tmp = mkdtempSync(join(tmpdir(), "torhq-lib-"));
      upsertLibrary({
        key: "navidrome-music",
        label: "Music",
        kind: "music",
        targetService: "navidrome",
        destPath: join(tmp, "m"),
        stagingPath: join(tmp, "s"),
        rescan: false,
        importMode: "move",
      });
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("returns 200 with ok and jobId, and job has correct properties", async () => {
      const localPath = join(tmp, "dl", "Album");
      const res = await postSlskd({ localPath }, "correct-token-1");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ ok: true });
      expect(typeof body.jobId).toBe("string");
      expect(body.jobId.length).toBeGreaterThan(0);

      const job = getJob(body.jobId);
      expect(job).toBeDefined();
      expect(job!.type).toBe("manual_intake");
      expect(job!.libraryKey).toBe("navidrome-music");
      expect(job!.status).toBe("queued");
      expect(job!.sourcePath).toBe(localPath);
    });

    it("returns same jobId on duplicate call with same localPath (idempotency)", async () => {
      const localPath = join(tmp, "dl", "Album");
      const res1 = await postSlskd({ localPath }, "correct-token-1");
      expect(res1.statusCode).toBe(200);
      const jobId1 = res1.json().jobId;

      const res2 = await postSlskd({ localPath }, "correct-token-1");
      expect(res2.statusCode).toBe(200);
      const jobId2 = res2.json().jobId;

      expect(jobId2).toBe(jobId1);
    });
  });
});