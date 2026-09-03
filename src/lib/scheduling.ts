import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { contentItems, platformConnections, publishTargets } from "@/db/schema";

// Deliberately boring per docs/PHASE_0_PLAN.md §1/§4: "spread pins out
// over time" becomes a fixed daily cap and spacing, not a smart
// scheduler.
export const PINTEREST_MAX_PER_DAY = 2;
export const PINTEREST_SPACING_HOURS = 6;
export const PINTEREST_SCHEDULE_START_HOUR_UTC = 14; // ~10am US Eastern

// Pure: given how many Pinterest pins are already scheduled per date
// (YYYY-MM-DD keys, UTC) starting from `startDate`, finds the first day
// under the cap and returns a slot time offset by how many are already
// on that day, so same-day pins don't all land simultaneously.
export function pickPinterestSlot(
  existingCountsByDate: Record<string, number>,
  startDate: Date,
  maxPerDay: number = PINTEREST_MAX_PER_DAY,
): Date {
  const day = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const MAX_DAYS_AHEAD = 14; // hard cap so this can't loop forever
  for (let i = 0; i < MAX_DAYS_AHEAD; i++) {
    const dateKey = day.toISOString().slice(0, 10);
    const countSoFar = existingCountsByDate[dateKey] ?? 0;
    if (countSoFar < maxPerDay) {
      const slot = new Date(day);
      slot.setUTCHours(PINTEREST_SCHEDULE_START_HOUR_UTC + countSoFar * PINTEREST_SPACING_HOURS, 0, 0, 0);
      return slot;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  throw new Error(`Could not find a Pinterest schedule slot within ${MAX_DAYS_AHEAD} days`);
}

export async function nextPinterestSlot(db: typeof DbClient): Promise<Date> {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ scheduledAt: publishTargets.scheduledAt })
    .from(publishTargets)
    .innerJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .where(and(eq(platformConnections.platform, "pinterest"), inArray(publishTargets.status, ["scheduled", "publishing"])));

  const countsByDate: Record<string, number> = {};
  for (const row of rows) {
    const key = row.scheduledAt.toISOString().slice(0, 10);
    countsByDate[key] = (countsByDate[key] ?? 0) + 1;
  }
  return pickPinterestSlot(countsByDate, tomorrow);
}

// Shared "roughly weekly, boring by design" cadence — Facebook per the
// brief's light-touch scope, LinkedIn as a reasonable default company-
// page posting frequency (no brief guidance either way; easy to change
// here if that's wrong). Pure: next slot is 7 days after the last
// scheduled post, or ~1 hour from now if there isn't one yet; never
// lands in the past if there's been a long gap since the last post.
function pickWeeklySlot(lastScheduledAt: Date | null, now: Date): Date {
  if (!lastScheduledAt) {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }
  const weekLater = new Date(lastScheduledAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  return weekLater.getTime() < now.getTime() ? new Date(now.getTime() + 60 * 60 * 1000) : weekLater;
}

// Excludes campaign-tagged content items (isNull(contentItems.campaign))
// so a one-off campaign's own dense schedule (see
// nextLinkedInCampaignSlot below) never counts as "the latest post" for
// the normal weekly cadence — the two are meant to run as independent
// streams, not push each other around.
async function nextWeeklySlot(db: typeof DbClient, platform: "facebook" | "linkedin"): Promise<Date> {
  const [latest] = await db
    .select({ scheduledAt: publishTargets.scheduledAt })
    .from(publishTargets)
    .innerJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .innerJoin(contentItems, eq(publishTargets.contentItemId, contentItems.id))
    .where(
      and(
        eq(platformConnections.platform, platform),
        isNull(contentItems.campaign),
        inArray(publishTargets.status, ["scheduled", "publishing", "published"]),
      ),
    )
    .orderBy(desc(publishTargets.scheduledAt))
    .limit(1);
  return pickWeeklySlot(latest?.scheduledAt ?? null, new Date());
}

export function pickFacebookSlot(lastScheduledAt: Date | null, now: Date): Date {
  return pickWeeklySlot(lastScheduledAt, now);
}

export function nextFacebookSlot(db: typeof DbClient): Promise<Date> {
  return nextWeeklySlot(db, "facebook");
}

export function pickLinkedInSlot(lastScheduledAt: Date | null, now: Date): Date {
  return pickWeeklySlot(lastScheduledAt, now);
}

export function nextLinkedInSlot(db: typeof DbClient): Promise<Date> {
  return nextWeeklySlot(db, "linkedin");
}

// One-off campaign cadence (the evergreen-content "blitz" being the
// first use): daily instead of weekly, scoped to posts tagged with the
// given campaign so it can run at its own pace without touching — or
// being touched by — the normal weekly cadence above. First slot is
// tomorrow (not "~1 hour from now" like the weekly cadence), since a
// same-day post isn't the point of a paced daily backlog release.
export function pickCampaignDailySlot(lastScheduledAt: Date | null, now: Date): Date {
  if (!lastScheduledAt) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return tomorrow;
  }
  const dayLater = new Date(lastScheduledAt.getTime() + 24 * 60 * 60 * 1000);
  return dayLater.getTime() < now.getTime() ? new Date(now.getTime() + 60 * 60 * 1000) : dayLater;
}

export async function nextLinkedInCampaignSlot(db: typeof DbClient, campaign: string): Promise<Date> {
  const [latest] = await db
    .select({ scheduledAt: publishTargets.scheduledAt })
    .from(publishTargets)
    .innerJoin(platformConnections, eq(publishTargets.platformConnectionId, platformConnections.id))
    .innerJoin(contentItems, eq(publishTargets.contentItemId, contentItems.id))
    .where(
      and(
        eq(platformConnections.platform, "linkedin"),
        eq(contentItems.campaign, campaign),
        inArray(publishTargets.status, ["scheduled", "publishing", "published"]),
      ),
    )
    .orderBy(desc(publishTargets.scheduledAt))
    .limit(1);
  return pickCampaignDailySlot(latest?.scheduledAt ?? null, new Date());
}
