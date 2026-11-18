import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { activity, type ActivityRow } from "../db/schema.js";

export type ActivityKind =
  | "requested" | "queued" | "downloading" | "completed"
  | "importing" | "imported" | "failed" | "info";

export function logActivity(input: {
  kind: ActivityKind;
  message: string;
  jobId?: string;
  service?: string;
  data?: unknown;
}): void {
  getDb().insert(activity).values({
    kind: input.kind,
    message: input.message,
    jobId: input.jobId ?? null,
    service: input.service ?? null,
    dataJson: input.data ? JSON.stringify(input.data) : null,
  }).run();
}

export function recentActivity(limit = 100): ActivityRow[] {
  return getDb().select().from(activity).orderBy(desc(activity.createdAt)).limit(limit).all();
}

export function jobActivity(jobId: string): ActivityRow[] {
  return getDb().select().from(activity).where(eq(activity.jobId, jobId))
    .orderBy(desc(activity.createdAt)).all();
}

/** Recent entries of one kind, newest first. Feeds the Activity view's request list. */
export function activityOfKind(kind: ActivityKind, sinceMs: number, limit = 200): ActivityRow[] {
  return getDb().select().from(activity)
    .where(and(eq(activity.kind, kind), gte(activity.createdAt, sinceMs)))
    .orderBy(desc(activity.createdAt)).limit(limit).all();
}
