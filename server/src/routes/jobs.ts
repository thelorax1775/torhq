import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { previewIntake, type IntakePayload } from "../queue/intake.js";
import { enqueue, listJobs, getJob, retryJob } from "../queue/queue.js";
import { jobActivity } from "../lib/activity.js";
import { PathValidationError } from "../security/paths.js";
import type { AppContext } from "../lib/context.js";

/** Job statuses the queue actually uses; anything else is a typo, not a filter. */
const JOB_STATUSES = ["queued", "running", "completed", "failed", "dead"] as const;

const JobListQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
});

const IdParam = z.object({ id: z.string().min(1).max(64) });

const IntakeInput = z.object({
  libraryKey: z.string().min(1),
  sourcePath: z.string().min(1),
  targetName: z.string().max(255).optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export function jobRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guard = { preHandler: [app.requireAuth, app.requireAdmin, app.requireCsrf] };

  // Dry-run preview before committing an intake.
  app.post("/api/intake/preview", guard, async (req, reply) => {
    const body = IntakeInput.parse(req.body);
    try {
      const preview = await previewIntake(body as IntakePayload, ctx.env.approvedRoots);
      return preview;
    } catch (e) {
      const code = e instanceof PathValidationError ? 400 : 422;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });

  // Enqueue the intake job (durable + idempotent).
  app.post("/api/intake", guard, async (req, reply) => {
    const body = IntakeInput.parse(req.body);
    try {
      // Validate up front so obviously-bad requests fail fast (not just in worker).
      await previewIntake(body as IntakePayload, ctx.env.approvedRoots);
    } catch (e) {
      const code = e instanceof PathValidationError ? 400 : 422;
      return reply.code(code).send({ error: (e as Error).message });
    }
    const job = enqueue({
      type: "manual_intake",
      payload: { libraryKey: body.libraryKey, sourcePath: body.sourcePath, targetName: body.targetName },
      idempotencyKey: body.idempotencyKey,
    });
    return { ok: true, jobId: job.id, status: job.status };
  });

  app.get("/api/jobs", { preHandler: app.requireAuth }, async (req) => {
    const { status } = JobListQuery.parse(req.query ?? {});
    return { jobs: listJobs(status) };
  });

  app.get("/api/jobs/:id", { preHandler: app.requireAuth }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const job = getJob(id);
    if (!job) return reply.code(404).send({ error: "not found" });
    return { job, activity: jobActivity(id) };
  });

  app.post("/api/jobs/:id/retry", guard, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const job = retryJob(id);
    if (!job) return reply.code(404).send({ error: "not found" });
    return { ok: true, job };
  });
}
