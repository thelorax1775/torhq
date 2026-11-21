import type { FastifyInstance } from "fastify";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { destroySessionsForUser } from "../auth/session.js";
import type { AppContext } from "../lib/context.js";

const CreateUser = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
});
const ResetPassword = z.object({ password: z.string().min(8).max(256) });
const UserIdParam = z.object({ id: z.coerce.number().int().positive() });

/** Never the password hash — this is the shape returned to the browser. */
function safeUser(u: { id: number; username: string; role: string; createdAt: number }) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}

export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  app.get("/api/users", { preHandler: [app.requireAuth, app.requireAdmin] }, async () => {
    const rows = getDb().select().from(users).all();
    return { users: rows.map(safeUser) };
  });

  // Friend accounts only — admin creation stays on /api/auth/register, gated
  // by adminExists(). This route can never create a second admin.
  app.post("/api/users", guard, async (req, reply) => {
    const body = CreateUser.parse(req.body);
    const existing = getDb().select().from(users).where(sql`lower(${users.username}) = lower(${body.username})`).get();
    if (existing) return reply.code(409).send({ error: `username ${body.username} already exists` });
    const passwordHash = await hashPassword(body.password);
    getDb().insert(users).values({ username: body.username, passwordHash, role: "member" }).run();
    const created = getDb().select().from(users).where(eq(users.username, body.username)).get()!;
    return { ok: true, user: safeUser(created) };
  });

  app.post("/api/users/:id/password", guard, async (req, reply) => {
    const { id } = UserIdParam.parse(req.params);
    const target = getDb().select().from(users).where(eq(users.id, id)).get();
    if (!target) return reply.code(404).send({ error: `no user with id ${id}` });
    const { password } = ResetPassword.parse(req.body);
    const passwordHash = await hashPassword(password);
    getDb().update(users).set({ passwordHash }).where(eq(users.id, id)).run();
    destroySessionsForUser(id); // a reset password should not leave old sessions valid
    return { ok: true };
  });

  app.delete("/api/users/:id", guard, async (req, reply) => {
    const { id } = UserIdParam.parse(req.params);
    const target = getDb().select().from(users).where(eq(users.id, id)).get();
    if (!target) return reply.code(404).send({ error: `no user with id ${id}` });
    if (target.role === "admin") {
      const otherAdmins = getDb().select().from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, id))).all();
      if (otherAdmins.length === 0) {
        return reply.code(409).send({ error: "cannot delete the last remaining admin" });
      }
    }
    destroySessionsForUser(id);
    getDb().delete(users).where(eq(users.id, id)).run();
    return { ok: true };
  });
}
