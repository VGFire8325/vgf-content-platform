import { and, count, desc, eq, gte, inArray, min } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { appHeartbeat, contentItems, platformConnections, publishTargets } from "@/db/schema";
import { REVIEW_QUEUE_STATUSES } from "@/lib/review";

export const HEARTBEAT_APP_ID = "content_flywheel";

// Only Pinterest/LinkedIn count toward this heartbeat — Facebook/
// Instagram generation has been paused since before this existed (see
// GENERATION_ENABLED_PLATFORMS in app/api/cron/run-jobs/route.ts), and
// the question this heartbeat answers is specifically "is Pinterest/
// LinkedIn posting healthy."
const HEARTBEAT_PLATFORMS: ("pinterest" | "linkedin")[] = ["pinterest", "linkedin"];

export interface HeartbeatSnapshot {
  lastPostAt: Date | null;
  postsLast7d: number;
  queuePending: number;
  queueOldestPendingAt: Date | null;
}

// Three small aggregate queries — "successful post" is exactly what
// finalizePublished (app/api/cron/run-jobs/route.ts) writes: a
// publish_targets row with status 'published' and publishedAt set, so
// that's what this reads rather than content_items.status (which also
// turns 'published' at the same time, but publish_targets is the
// authoritative publish record — externalPostId/Url live there).
// queue_pending/queue_oldest_pending_at mirror the Review Queue exactly
// (REVIEW_QUEUE_STATUSES, src/lib/review.ts) — "oldest" is by
// updatedAt, not createdAt, since an edit reverts an approved/scheduled
// item back to in_review (nextStatusAfterEdit) and bumps updatedAt,
// which is when it actually re-entered the queue; for an item that's
// never been touched, updatedAt equals createdAt anyway.
export async function computeHeartbeatSnapshot(
  db: typeof DbClient,
  now: Date = new Date(),
): Promise<HeartbeatSnapshot> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [lastPostRow] = await db
    .select({ publishedAt: publishTargets.publishedAt })
    .from(publishTargets)
    .innerJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .where(and(inArray(platformConnections.platform, HEARTBEAT_PLATFORMS), eq(publishTargets.status, "published")))
    .orderBy(desc(publishTargets.publishedAt))
    .limit(1);

  const [postsLast7dRow] = await db
    .select({ n: count() })
    .from(publishTargets)
    .innerJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .where(
      and(
        inArray(platformConnections.platform, HEARTBEAT_PLATFORMS),
        eq(publishTargets.status, "published"),
        gte(publishTargets.publishedAt, sevenDaysAgo),
      ),
    );

  const [queueRow] = await db
    .select({ n: count(), oldest: min(contentItems.updatedAt) })
    .from(contentItems)
    .where(inArray(contentItems.status, REVIEW_QUEUE_STATUSES));

  return {
    lastPostAt: lastPostRow?.publishedAt ?? null,
    postsLast7d: postsLast7dRow?.n ?? 0,
    queuePending: queueRow?.n ?? 0,
    queueOldestPendingAt: queueRow?.oldest ?? null,
  };
}

// Upserts the single app_heartbeat row. Called once at the end of
// every scheduled run of the job queue (app/api/cron/run-jobs/route.ts's
// GET handler), unconditionally — including an empty run that claimed
// nothing, since "the cron is still firing" is itself the main signal
// an external monitor needs. That same call site also covers "after
// every successful post": posting only ever happens from inside that
// run (approving an item only schedules a publish_post job — see
// scheduleApprovedItem in src/lib/publish-scheduling.ts — nothing
// publishes outside this cron), and the snapshot is computed fresh
// from the database each time, so a post that just succeeded is
// already reflected by the time this runs; a second call right after
// the publish itself would just recompute the same numbers again.
//
// Never throws: a heartbeat write failing must never block or fail a
// post (acceptance criterion) — logged and swallowed instead. This is
// also the "dry-run" entry point — it never posts anything itself, so
// calling it on its own (see scripts/heartbeat-check.ts) safely writes
// the row without touching Pinterest/LinkedIn or the job queue at all.
export async function writeHeartbeat(db: typeof DbClient, now: Date = new Date()): Promise<void> {
  try {
    const snapshot = await computeHeartbeatSnapshot(db, now);
    const values = {
      app: HEARTBEAT_APP_ID,
      lastRunAt: now,
      lastPostAt: snapshot.lastPostAt,
      postsLast7d: snapshot.postsLast7d,
      queuePending: snapshot.queuePending,
      queueOldestPendingAt: snapshot.queueOldestPendingAt,
      updatedAt: now,
    };
    await db.insert(appHeartbeat).values(values).onConflictDoUpdate({ target: appHeartbeat.app, set: values });
  } catch (err) {
    console.error("writeHeartbeat failed (posting continues regardless):", err);
  }
}
