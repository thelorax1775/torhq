import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import { ArrAdapter } from "../adapters/arr.js";
import { logActivity } from "../lib/activity.js";
import { getServiceDecrypted } from "../config/store.js";
import { ARR_PURPOSE, defaultRootFor, driveRefs, getDriveSettings, withDrives } from "../config/drives.js";
import type { AppContext } from "../lib/context.js";

const SearchQuery = z.object({ term: z.string().min(1).max(256) });

const AddRequest = z.object({
  term: z.string().min(1).max(256),
  // The user must pick a specific candidate returned by /search — we never add
  // "the first result".
  selectionId: z.string().min(1).max(128),
  qualityProfileId: z.number().int().positive(),
  rootFolderPath: z.string().min(1),
  monitored: z.boolean().optional(),
  searchNow: z.boolean().optional(),
  // Lidarr only.
  metadataProfileId: z.number().int().positive().optional(),
});

const ARR_KIND = { movie: "radarr", tv: "sonarr", music: "lidarr" } as const;
type Route = keyof typeof ARR_KIND;

export function requestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };

  /**
   * The root folder a member's form starts on: the one on the default drive
   * from Settings, else the root an admin saved on the Get page, and only ever
   * a root the *arr still lists. Undefined means the form falls back to the
   * first root.
   */
  function defaultRoot(kind: keyof typeof ARR_PURPOSE, roots: Array<{ path: string }>): string | undefined {
    const legacy = getServiceDecrypted(kind, ctx.masterKey)?.extra?.rootFolderPath;
    return defaultRootFor(ARR_PURPOSE[kind], roots, getDriveSettings(), legacy);
  }

  for (const [route, kind] of Object.entries(ARR_KIND) as Array<[Route, (typeof ARR_KIND)[Route]]>) {
    // Profiles / root folders (and Lidarr metadata profiles) for the form.
    app.get(`/api/requests/${route}/options`, { preHandler: app.requireAuth }, async (_req, reply) => {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) return reply.code(409).send({ error: `${kind} not configured` });
      try {
        const [profiles, roots, metadataProfiles] = await Promise.all([
          a.qualityProfiles(), a.rootFolders(), a.metadataProfiles(),
        ]);
        const drives = getDriveSettings();
        return {
          profiles, roots: withDrives(roots, drives.drives), metadataProfiles,
          drives: driveRefs(drives), defaultRootFolderPath: defaultRoot(kind, roots),
        };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });

    // Search and return candidates. Read-only, so no CSRF — but auth required.
    app.get(`/api/requests/${route}/search`, { preHandler: app.requireAuth }, async (req, reply) => {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) return reply.code(409).send({ error: `${kind} not configured` });
      const { term } = SearchQuery.parse(req.query);
      try {
        return { candidates: await a.searchCandidates(term) };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });

    // Submit the *chosen* candidate. TorHQ only asks the *arr to add+search.
    app.post(`/api/requests/${route}`, guard, async (req, reply) => {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) return reply.code(409).send({ error: `${kind} not configured` });
      const body = AddRequest.parse(req.body);
      if (kind === "lidarr" && body.metadataProfileId == null) {
        return reply.code(400).send({ error: "metadataProfileId is required for music (Lidarr) requests" });
      }
      try {
        const created = await a.addSelected(body);
        logActivity({
          kind: "requested",
          service: kind,
          message: `Requested ${created.title} (by ${req.session!.username})`,
          data: { id: created.id },
        });
        return { ok: true, id: created.id, title: created.title };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });
  }
}
