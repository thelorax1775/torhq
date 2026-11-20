import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { sessions, users, type User } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
export const SESSION_COOKIE = "torhq_sid";

export function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function createAdmin(username: string, password: string): Promise<User> {
  const db = getDb();
  const passwordHash = await hashPassword(password);
  return db.transaction(() => {
    if (adminExists()) {
      throw new Error("ADMIN_EXISTS");
    }
    db.insert(users).values({ username, passwordHash, role: "admin" }).run();
    return db.select().from(users).where(eq(users.username, username)).get()!;
  });
}

export function adminExists(): boolean {
  return !!getDb().select().from(users).get();
}

export async function authenticate(username: string, password: string): Promise<User | null> {
  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) {
    // Constant-work path to reduce user-enumeration timing signal.
    await verifyPassword(password, "scrypt$32768$8$1$AAAA$AAAA");
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

export interface SessionCtx {
  sessionId: string;
  csrfToken: string;
  userId: number;
  role: string;
  username: string;
}

export function createSession(user: User): SessionCtx {
  const db = getDb();
  const sessionId = token();
  const csrfToken = token();
  db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    csrfToken,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }).run();
  return { sessionId, csrfToken, userId: user.id, role: user.role, username: user.username };
}

export function getSession(sessionId: string | undefined): SessionCtx | null {
  if (!sessionId) return null;
  const db = getDb();
  const row = db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      role: users.role,
      username: users.username,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }
  return { sessionId: row.sessionId, csrfToken: row.csrfToken, userId: row.userId, role: row.role, username: row.username };
}

export function destroySession(sessionId: string): void {
  getDb().delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function destroySessionsForUser(userId: number): void {
  getDb().delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function purgeExpiredSessions(): void {
  getDb().delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}
