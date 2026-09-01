import { and, eq } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { contentItems, platformConnections, publishTargets } from "@/db/schema";
import { enqueueJob } from "@/lib/jobs";
import { nextFacebookSlot, nextLinkedInSlot, nextPinterestSlot } from "@/lib/scheduling";

type ContentItemRow = typeof contentItems.$inferSelect;
type AutoSchedulePlatform = "pinterest" | "facebook" | "linkedin";

function isAutoSchedulePlatform(platform: ContentItemRow["platform"]): platform is AutoSchedulePlatform {
  return platform === "pinterest" || platform === "facebook" || platform === "linkedin";
}

// Only platforms with a live connection AND a publish client get
// scheduled automatically — everything else stays 'approved' until both
// exist (Instagram until its image template exists; Pinterest/
// Facebook/LinkedIn until Brendan connects them). LinkedIn moved off
// the "deferred out of V1" list in §2 once Community Management API
// access was applied for and the client got built — see
// src/lib/platforms/linkedin.ts.
//
// Shared with the OAuth callbacks (not just app/review/actions.ts)
// because approving an item runs this exactly once, at approve time —
// approving before the platform is connected leaves the item stuck in
// 'approved' with no publish_targets row forever, since nothing else
// ever calls this again for it. scheduleUnscheduledApprovedItems below
// is the fix: each OAuth callback sweeps for exactly that gap the
// moment its connection goes live.
export async function scheduleApprovedItem(db: typeof DbClient, item: ContentItemRow) {
  if (!isAutoSchedulePlatform(item.platform)) {
    return;
  }
  const [connection] = await db
    .select()
    .from(platformConnections)
    .where(and(eq(platformConnections.platform, item.platform), eq(platformConnections.status, "connected")))
    .limit(1);
  if (!connection) {
    return;
  }

  const scheduledAt =
    item.platform === "pinterest"
      ? await nextPinterestSlot(db)
      : item.platform === "facebook"
        ? await nextFacebookSlot(db)
        : await nextLinkedInSlot(db);
  const [target] = await db
    .insert(publishTargets)
    .values({ contentItemId: item.id, platformConnectionId: connection.id, scheduledAt, status: "scheduled" })
    .returning();
  if (!target) {
    throw new Error("Insert into publish_targets returned no row");
  }

  await db.update(contentItems).set({ status: "scheduled" }).where(eq(contentItems.id, item.id));
  // run_at = scheduledAt, so the cron runner won't claim this until the
  // actual scheduled time — this is how "spread posts out over time"
  // (§4) actually happens, not a separate scheduler process.
  await enqueueJob(db, "publish_post", { publishTargetId: target.id }, scheduledAt);
}

// Catches up any content_items already approved before this platform
// had a connection (or while its connection was expired) — call this
// right after an OAuth callback marks a connection 'connected'. Scoped
// to items with zero publish_targets rows so it can never double-
// schedule an item scheduleApprovedItem already handled; sequential,
// not Promise.all, for the same reason approveAllInReview is
// sequential — nextXSlot reads existing publish_targets to place the
// next slot, so scheduling two of these in parallel could both compute
// the same slot.
export async function scheduleUnscheduledApprovedItems(db: typeof DbClient, platform: AutoSchedulePlatform) {
  const rows = await db
    .select({ item: contentItems, publishTargetId: publishTargets.id })
    .from(contentItems)
    .leftJoin(publishTargets, eq(publishTargets.contentItemId, contentItems.id))
    .where(and(eq(contentItems.platform, platform), eq(contentItems.status, "approved")));

  const unscheduled = rows
    .filter((row) => row.publishTargetId === null)
    .map((row) => row.item)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

  for (const item of unscheduled) {
    await scheduleApprovedItem(db, item);
  }
}
