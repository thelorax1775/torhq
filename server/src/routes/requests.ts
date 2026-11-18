import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import { ArrAdapter } from "../adapters/arr.js";
import { logActivity } from "../lib/activity.js";
import { getServiceDecrypted } from "../config/store.js";
import type { AppContext } from "../lib/context.js";

const SearchQuery = z.object({ term: z.string().min(1).max(256) });

const AddRequest = z.object({
  term: z.string().min(1).max(256),
  // The user must pick a specific candidate returned by /search — we never add
  // "the first result".
  selectionId: z.string().min(1).max(128),
  // Both optional: left out, the saved defaults (then the *arr's first choice)
  // apply, so a member never has to know or see a server path.
  qualityProfileId: z.number().int().positive().optional(),
  rootFolderPath: z.string().min(1).optional(),
  monitored: z.boolean().optional(),
  searchNow: z.boolean().optional(),
  // Lidarr only.
  metadataProfileId: z.number().int().positive().optional(),
});

const ARR_KIND = { movie: "radarr", tv: "sonarr", music: "lidarr" } as const;
type Route = keyof typeof ARR_KIND;

export function requestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireCsrf] };

  for (const [route, kind] of Object.entries(ARR_KIND) as Array<[Route, string]>) {
    // Profiles / root folders (and Lidarr metadata profiles) for the form.
    app.get(`/api/requests/${route}/options`, { preHandler: app.requireAuth }, async (_req, reply) => {
      const a = getAdapter(kind, ctx.masterKey) as ArrAdapter | null;
      if (!a) return reply.code(409).send({ error: `${kind} not configured` });
      try {
        const [profiles, roots, metadataProfiles] = await Promise.all([
          a.qualityProfiles(), a.rootFolders(), a.metadataProfiles(),
        ]);
        return { profiles, roots, metadataProfiles };
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
      try {
        const saved = (getServiceDecrypted(kind, ctx.masterKey)?.extra ?? {}) as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        const rootFolderPath = body.rootFolderPath
          ?? (typeof saved.rootFolderPath === "string" ? saved.rootFolderPath : undefined)
          ?? (await a.rootFolders())[0]?.path;
        const qualityProfileId = body.qualityProfileId ?? num(saved.qualityProfileId)
          ?? (await a.qualityProfiles())[0]?.id;
        if (!rootFolderPath || qualityProfileId == null) {
          return reply.code(409).send({ error: `${kind} has no root folder or quality profile configured` });
        }
        const metadataProfileId = body.metadataProfileId ?? num(saved.metadataProfileId)
          ?? (kind === "lidarr" ? (await a.metadataProfiles())[0]?.id : undefined);
        if (kind === "lidarr" && metadataProfileId == null) {
          return reply.code(400).send({ error: "metadataProfileId is required for music (Lidarr) requests" });
        }
        const created = await a.addSelected({ ...body, rootFolderPath, qualityProfileId, metadataProfileId });
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
