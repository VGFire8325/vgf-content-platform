import { sql } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { jobs, type jobTypeEnum } from "@/db/schema";

type JobType = (typeof jobTypeEnum.enumValues)[number];

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

// Atomically claims up to `limit` due jobs using SKIP LOCKED, so
// overlapping cron invocations never double-process a row.
export async function claimDueJobs(db: typeof DbClient, limit = 5) {
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
  return result as unknown as (typeof jobs.$inferSelect)[];
}

export async function markJobSucceeded(db: typeof DbClient, jobId: string) {
  await db.update(jobs).set({ status: "succeeded", updatedAt: new Date() }).where(sql`id = ${jobId}`);
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
      .where(sql`id = ${job.id}`);
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
    .where(sql`id = ${job.id}`);
  return "failed_retryable" as const;
}
