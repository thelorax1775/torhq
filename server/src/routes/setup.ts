import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SERVICE_KINDS, listServicesSafe, upsertService,
  listLibraries, upsertLibrary, getLibrary, deleteLibrary, activeJobsForLibrary,
} from "../config/store.js";
import { testConfig } from "../adapters/registry.js";
import { safeResolve } from "../security/paths.js";
import type { AppContext } from "../lib/context.js";

const ServiceInput = z.object({
  kind: z.enum(SERVICE_KINDS),
  label: z.string().min(1).max(64),
  baseUrl: z.string().url(),
  secret: z.string().max(1024).optional(),
  enabled: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const LibraryInput = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(64),
  kind: z.enum(["books", "manga", "comics", "music", "audiobooks"]),
  targetService: z.enum(["kavita", "navidrome", "audiobookshelf"]),
  destPath: z.string().min(1),
  stagingPath: z.string().min(1),
  rescan: z.boolean().optional(),
  // "move" consumes the source; "link" hardlinks and leaves it in place, which
  // is what lets an import run straight off a still-seeding download.
  importMode: z.enum(["move", "link"]).optional(),
});

const LibraryKeyParam = z.object({ key: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/) });

export function setupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  // List configured services (secrets masked — never full keys to browser).
  app.get("/api/services", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({
    services: listServicesSafe(),
    kinds: SERVICE_KINDS,
  }));

  // Save/update a service. If secret omitted, prior secret is retained.
  app.post("/api/services", guard, async (req) => {
    const body = ServiceInput.parse(req.body);
    upsertService(body, ctx.masterKey);
    return { ok: true };
  });

  // Test a connection using either the submitted secret or the stored one.
  app.post("/api/services/test", guard, async (req, reply) => {
    const body = ServiceInput.parse(req.body);
    let secret = body.secret;
    if (!secret) {
      const { getServiceDecrypted } = await import("../config/store.js");
      secret = getServiceDecrypted(body.kind, ctx.masterKey)?.secret ?? "";
    }
    const result = await testConfig(body.kind, { baseUrl: body.baseUrl, secret, extra: body.extra });
    if (!result.healthy) reply.code(502);
    return result;
  });

  // Destination libraries for manual intake. Paths validated against roots.
  app.get("/api/libraries", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({
    libraries: listLibraries(),
  }));

  app.post("/api/libraries", guard, async (req, reply) => {
    const body = LibraryInput.parse(req.body);
    // Both dest and staging must resolve within approved roots (may not exist yet).
    try {
      safeResolve(body.destPath, ctx.env.approvedRoots, { mustExist: false });
      safeResolve(body.stagingPath, ctx.env.approvedRoots, { mustExist: false });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    upsertLibrary({ ...body, rescan: body.rescan ?? true, importMode: body.importMode ?? "move" });
    return { ok: true };
  });

  /**
   * Remove a library definition. Refused while intake jobs are still queued or
   * running against it, because those jobs resolve their destination by key and
   * would fail at the point of import instead of here, where the cause is clear.
   * Nothing on disk is touched either way.
   */
  app.delete("/api/libraries/:key", guard, async (req, reply) => {
    const { key } = LibraryKeyParam.parse(req.params);
    if (!getLibrary(key)) return reply.code(404).send({ error: `no library named ${key}` });

    const active = activeJobsForLibrary(key);
    if (active > 0) {
      return reply.code(409).send({
        error: `${active} intake job${active === 1 ? " is" : "s are"} still queued against ${key}`,
      });
    }
    deleteLibrary(key);
    return { ok: true };
  });

  // Expose approved roots so the UI can guide path entry (read-only).
  app.get("/api/config/roots", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => ({
    approvedRoots: ctx.env.approvedRoots,
  }));
}
