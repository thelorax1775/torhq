import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import type { AppContext } from "./lib/context.js";
import { loggerOptions } from "./lib/logger.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./routes/auth.js";
import { setupRoutes } from "./routes/setup.js";
import { userRoutes } from "./routes/users.js";
import { requestRoutes } from "./routes/requests.js";
import { searchRoutes } from "./routes/search.js";
import { acquireRoutes } from "./routes/acquire.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { hubRoutes } from "./routes/hub.js";
import { bookRoutes } from "./routes/books.js";
import { identifyRoutes } from "./routes/identify.js";
import { downloadRoutes } from "./routes/downloads.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import { jobRoutes } from "./routes/jobs.js";
import { activityFeedRoutes } from "./routes/activityFeed.js";
import { statusRoutes } from "./routes/status.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { systemRoutes } from "./routes/system.js";
import { updateRoutes } from "./routes/update.js";
import { openApiRoutes } from "./routes/openapi.js";

/**
 * Turn a validation failure into one line a person can act on: which field, and
 * what was wrong with it. Bounded, because a bad request can carry many issues
 * and the message ends up in a toast.
 */
function describeIssues(err: ZodError): string {
  const parts = err.issues.slice(0, 3).map((i) => {
    const field = i.path.join(".");
    return field ? `${field}: ${i.message.toLowerCase()}` : i.message.toLowerCase();
  });
  const more = err.issues.length - parts.length;
  return `validation failed — ${parts.join("; ")}${more > 0 ? ` (and ${more} more)` : ""}`;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(ctx.env.TORHQ_LOG_LEVEL),
    trustProxy: ctx.env.TORHQ_TRUST_PROXY,
    bodyLimit: 5 * 1024 * 1024,
  });

  // Uniform error shape; hide internals, surface validation messages.
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) {
      // Name the fields. "validation failed" on its own sends the user hunting
      // through a form of a dozen inputs for the one the server rejected, and
      // the UI only surfaces `error` — `issues` alone never reaches them.
      return reply.code(400).send({ error: describeIssues(err), issues: err.issues });
    }
    const status = (err as any).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  await app.register(cookie);
  // Global rate limit. The strict brute-force budget is applied per-route (see
  // authRoutes) rather than to a whole scope, so that read-only endpoints the
  // SPA polls -- notably GET /api/auth/me -- cannot exhaust the login budget
  // and lock a legitimate user out of signing in.
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await authPlugin(app); // call directly so decorators apply to the root instance

  // Routes. Credential endpoints carry their own tight per-route limit.
  authRoutes(app, ctx);
  webhookRoutes(app, ctx);
  setupRoutes(app, ctx);
  userRoutes(app, ctx);
  requestRoutes(app, ctx);
  searchRoutes(app, ctx);
  acquireRoutes(app, ctx);
  catalogueRoutes(app, ctx);
  hubRoutes(app, ctx);
  bookRoutes(app, ctx);
  identifyRoutes(app, ctx);
  downloadRoutes(app, ctx);
  pipelineRoutes(app, ctx);
  jobRoutes(app, ctx);
  activityFeedRoutes(app, ctx);
  statusRoutes(app, ctx);
  systemRoutes(app, ctx);
  updateRoutes(app, ctx);
  openApiRoutes(app);

  // Serve built SPA if present (single-origin deployment).
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, "..", "..", "web", "dist");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/webhooks")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html"); // SPA fallback
    });
  }

  return app;
}
