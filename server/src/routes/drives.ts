import type { FastifyInstance } from "fastify";
import {
  DRIVE_PURPOSES, driveUsage, getDriveSettings, saveDriveSettings, type DriveSettings,
} from "../config/drives.js";
import type { AppContext } from "../lib/context.js";

/**
 * Drives: which disks content can go on, and the default for each kind of
 * content. Read by the admin pages that place things; written only from
 * Settings. Members never need this: the Requests options already carry each
 * root folder's drive.
 */
export function driveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  const view = (s: DriveSettings) => ({
    drives: s.drives.map((d) => ({ ...d, usage: driveUsage(d, s, ctx.env.approvedRoots) })),
    defaults: s.defaults,
    purposes: DRIVE_PURPOSES,
  });

  app.get("/api/drives", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => view(getDriveSettings()));

  app.put("/api/drives", guard, async (req) => view(saveDriveSettings(req.body)));
}
