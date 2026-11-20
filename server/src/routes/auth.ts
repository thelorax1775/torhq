import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SESSION_COOKIE, adminExists, authenticate, createAdmin,
  createSession, destroySession,
} from "../auth/session.js";
import type { AppContext } from "../lib/context.js";

const Credentials = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
});

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Tight budget for endpoints that accept credentials, to blunt brute force.
  // Deliberately NOT applied to /api/auth/me or /api/auth/logout: those are
  // driven by the SPA on every page load, and sharing a bucket with login meant
  // a handful of refreshes returned 429 and locked the user out of signing in.
  const credentialLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  const cookieOpts = {
    httpOnly: true,
    // Lax (not Strict) so the session cookie is reliably stored and sent by
    // browsers on same-site requests — including plain-HTTP access by LAN IP,
    // where some browsers drop Strict cookies. CSRF is still enforced separately
    // via the double-submit X-CSRF-Token header on every mutation.
    sameSite: "lax" as const,
    secure: ctx.env.TORHQ_COOKIE_SECURE,
    path: "/",
  };

  // First-run: create the single admin account. Disabled once one exists.
  app.post("/api/auth/register", credentialLimit, async (req, reply) => {
    if (adminExists()) return reply.code(409).send({ error: "admin already exists" });
    const body = Credentials.parse(req.body);
    try {
      const user = await createAdmin(body.username, body.password);
      const s = createSession(user);
      reply.setCookie(SESSION_COOKIE, s.sessionId, cookieOpts);
      return { username: user.username, csrfToken: s.csrfToken };
    } catch (err: any) {
      if (err.message === "ADMIN_EXISTS") {
        return reply.code(409).send({ error: "admin already exists" });
      }
      throw err;
    }
  });

  app.post("/api/auth/login", credentialLimit, async (req, reply) => {
    const body = Credentials.parse(req.body);
    const user = await authenticate(body.username, body.password);
    if (!user) return reply.code(401).send({ error: "invalid credentials" });
    const s = createSession(user);
    reply.setCookie(SESSION_COOKIE, s.sessionId, cookieOpts);
    return { username: user.username, csrfToken: s.csrfToken };
  });

  // Logout is a state change, so it requires the CSRF token like every other mutation.
  app.post("/api/auth/logout", { preHandler: [app.requireAuth, app.requireCsrf] }, async (req, reply) => {
    if (req.session) destroySession(req.session.sessionId);
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  // Session probe for the SPA (also returns whether setup is needed).
  app.get("/api/auth/me", async (req) => {
    return {
      authenticated: !!req.session,
      needsSetup: !adminExists(),
      csrfToken: req.session?.csrfToken ?? null,
      role: req.session?.role ?? null,
    };
  });
}
