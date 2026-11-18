import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/registry.js";
import type { ArrAdapter } from "../adapters/arr.js";
import type { TmdbAdapter } from "../adapters/tmdb.js";
import type { RawgAdapter } from "../adapters/rawg.js";
import { openLibraryWork, searchOpenLibrary } from "../adapters/openlibrary.js";
import { getServiceDecrypted } from "../config/store.js";
import { HUB_KINDS, HubItemError, hubItem, hubSearch, type HubDeps, type HubKind } from "../lib/hub.js";
import type { AppContext } from "../lib/context.js";

const SOURCE_TIMEOUT_MS = 6000;

const KindList = z.string().max(100).transform((s, ctx) => {
  const kinds = s.split(",").map((k) => k.trim()).filter(Boolean);
  const bad = kinds.find((k) => !(HUB_KINDS as readonly string[]).includes(k));
  if (bad) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown kind "${bad}" (expected ${HUB_KINDS.join(", ")})` });
    return z.NEVER;
  }
  return kinds as HubKind[];
});

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(256),
  kinds: KindList.optional(),
});

const ItemQuery = z.object({
  kind: z.enum(HUB_KINDS),
  id: z.string().trim().min(1).max(128),
});

let override: HubDeps | null = null;
/** Test hook: replace the real adapters with mocks. Pass null to restore. */
export function setHubDepsForTest(d: HubDeps | null): void {
  override = d;
}

function realDeps(ctx: AppContext): HubDeps {
  return {
    arr: (s) => getAdapter(s, ctx.masterKey) as ArrAdapter | null,
    tmdb: () => getAdapter("tmdb", ctx.masterKey) as TmdbAdapter | null,
    rawg: () => getAdapter("rawg", ctx.masterKey) as RawgAdapter | null,
    prowlarrConfigured: () => getAdapter("prowlarr", ctx.masterKey) !== null,
    openLibrary: {
      search: (q) => searchOpenLibrary(q, 10, SOURCE_TIMEOUT_MS),
      work: (id) => openLibraryWork(id, SOURCE_TIMEOUT_MS),
    },
    savedDefaults: (service) => {
      const extra = (getServiceDecrypted(service, ctx.masterKey)?.extra ?? {}) as Record<string, unknown>;
      return {
        rootFolderPath: typeof extra.rootFolderPath === "string" ? extra.rootFolderPath : undefined,
        qualityProfileId: typeof extra.qualityProfileId === "number" ? extra.qualityProfileId : undefined,
        metadataProfileId: typeof extra.metadataProfileId === "number" ? extra.metadataProfileId : undefined,
      };
    },
    timeoutMs: SOURCE_TIMEOUT_MS,
  };
}

/**
 * Hub — one search across every media kind, and the detail behind a result.
 * Read-only and open to members as well as the admin (requireAuth): it reveals
 * nothing the Requests and Catalogue pages do not, and it is how a friend finds
 * something to ask for. It never adds or moves anything.
 */
export function hubRoutes(app: FastifyInstance, ctx: AppContext): void {
  const read = { preHandler: app.requireAuth };
  const deps = () => override ?? realDeps(ctx);

  app.get("/api/hub/search", read, async (req) => {
    const { q, kinds } = SearchQuery.parse(req.query);
    return hubSearch(deps(), q, kinds && kinds.length ? kinds : HUB_KINDS);
  });

  app.get("/api/hub/item", read, async (req, reply) => {
    const { kind, id } = ItemQuery.parse(req.query);
    try {
      return { item: await hubItem(deps(), kind, id, req.session!.role === "admin") };
    } catch (e) {
      if (e instanceof HubItemError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  });
}
