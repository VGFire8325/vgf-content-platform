import { eq, sql } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { jobs, type jobTypeEnum } from "@/db/schema";

type JobType = (typeof jobTypeEnum.enumValues)[number];
type JobRow = typeof jobs.$inferSelect;

export async function enqueueJob(
  db: typeof DbClient,
  jobType: JobType,
  payload: Record<string, unknown>,
  runAt: Date = new Date(),
) {
  const [row] = await db
    .insert(jobs)
    .values({ jobType, payload, runAt })
    .returning();
  return row;
}

// Retry policy per docs/PHASE_0_PLAN.md §5. Each entry in `backoffMs` is
// the delay before the next attempt; array length = number of retries
// after the initial attempt, so total attempts = backoffMs.length + 1.
export const RETRY_POLICY: Record<JobType, { backoffMs: number[] }> = {
  extract_article: { backoffMs: [30_000, 120_000, 480_000] }, // 30s, 2min, 8min
  generate_content: { backoffMs: [30_000, 120_000, 480_000] },
  render_image: { backoffMs: [30_000, 120_000, 480_000] },
  publish_post: { backoffMs: [60_000, 300_000, 900_000, 1_800_000, 3_600_000] }, // 1,5,15,30,60min
  refresh_token: { backoffMs: [] }, // exactly one attempt — see §5 auth-renewal policy
};

// db.execute() runs raw SQL outside drizzle's schema-aware query
// builder, so the driver hands back Postgres's actual column names
// (job_type, attempt_count, ...) — this maps them back to the camelCase
// shape the rest of the app expects, matching jobs.$inferSelect.
function mapRawJobRow(raw: Record<string, unknown>): JobRow {
  return {
    id: raw.id as string,
    jobType: raw.job_type as JobRow["jobType"],
    payload: raw.payload,
    runAt: new Date(raw.run_at as string),
    status: raw.status as JobRow["status"],
    attemptCount: raw.attempt_count as number,
    lastError: raw.last_error as string | null,
    createdAt: new Date(raw.created_at as string),
    updatedAt: new Date(raw.updated_at as string),
  };
}

// Atomically claims up to `limit` due jobs using SKIP LOCKED, so
// overlapping cron invocations never double-process a row. This has to
// stay one raw SQL statement (not a separate SELECT ... FOR UPDATE
// followed by an UPDATE) — split across two statements without an
// explicit transaction, the row lock from FOR UPDATE would be released
// before the UPDATE runs, and two overlapping cron calls could both
// claim the same job.
export async function claimDueJobs(db: typeof DbClient, limit = 5): Promise<JobRow[]> {
  const result = await db.execute(sql`
    UPDATE jobs
    SET status = 'running', updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `);
  return (result as unknown as Record<string, unknown>[]).map(mapRawJobRow);
}

export async function markJobSucceeded(db: typeof DbClient, jobId: string) {
  await db.update(jobs).set({ status: "succeeded", updatedAt: new Date() }).where(eq(jobs.id, jobId));
}

// Applies the backoff schedule: reschedules as `pending` if attempts
// remain, otherwise marks `failed_final`. `nonRetryable` skips straight
// to failed_final regardless of attempts remaining (e.g. a model
// content-policy refusal — retrying won't change the outcome).
export async function markJobFailed(
  db: typeof DbClient,
  job: { id: string; jobType: JobType; attemptCount: number },
  error: string,
  nonRetryable = false,
) {
  const policy = RETRY_POLICY[job.jobType];
  const nextAttempt = job.attemptCount + 1;
  const retriesExhausted = nextAttempt > policy.backoffMs.length;

  if (nonRetryable || retriesExhausted) {
    await db
      .update(jobs)
      .set({ status: "failed_final", attemptCount: nextAttempt, lastError: error, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return "failed_final" as const;
  }

  const delayMs = policy.backoffMs[job.attemptCount] ?? 0;
  await db
    .update(jobs)
    .set({
      status: "pending",
      attemptCount: nextAttempt,
      lastError: error,
      runAt: new Date(Date.now() + delayMs),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));
  return "failed_retryable" as const;
}
