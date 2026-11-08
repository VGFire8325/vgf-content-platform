import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { db as DbClient } from "@/db/client";
import { contentItems, platformEnum, postStats, publishTargets } from "@/db/schema";

type DB = typeof DbClient;
type Platform = (typeof platformEnum.enumValues)[number];

// === GET /api/post-stats/pending ===

export interface PendingPostStat {
  publishTargetId: string;
  platform: Platform;
  externalPostUrl: string | null;
  publishedAt: Date;
  lastCapturedOn: string | null;
}

const PENDING_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const RECENT_CAPTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Published posts the capture routine should (re-)fetch stats for:
// old enough that a platform's analytics have settled (>3 days since
// publish) and not captured again too soon (skip anything captured
// within the last 7 days, including a post never captured at all —
// that one has no lastCapturedOn, so it's always included).
export async function listPendingPostStats(db: DB, opts: { platform?: Platform | null; now?: Date } = {}): Promise<PendingPostStat[]> {
  const now = opts.now ?? new Date();
  const publishedBefore = new Date(now.getTime() - PENDING_MIN_AGE_MS);
  const recentCaptureCutoff = dateOnly(new Date(now.getTime() - RECENT_CAPTURE_WINDOW_MS));

  const rows = await db
    .select({
      publishTargetId: publishTargets.id,
      platform: contentItems.platform,
      externalPostUrl: publishTargets.externalPostUrl,
      publishedAt: publishTargets.publishedAt,
    })
    .from(publishTargets)
    .innerJoin(contentItems, eq(publishTargets.contentItemId, contentItems.id))
    .where(
      and(
        eq(publishTargets.status, "published"),
        lt(publishTargets.publishedAt, publishedBefore),
        opts.platform ? eq(contentItems.platform, opts.platform) : undefined,
      ),
    );

  if (rows.length === 0) return [];

  const latestCaptures = await db
    .select({ publishTargetId: postStats.publishTargetId, capturedOn: postStats.capturedOn })
    .from(postStats)
    .where(inArray(postStats.publishTargetId, rows.map((r) => r.publishTargetId)));

  const lastCapturedByTarget = new Map<string, string>();
  for (const row of latestCaptures) {
    const existing = lastCapturedByTarget.get(row.publishTargetId);
    if (!existing || row.capturedOn > existing) {
      lastCapturedByTarget.set(row.publishTargetId, row.capturedOn);
    }
  }

  return rows
    .map((row) => ({
      publishTargetId: row.publishTargetId,
      platform: row.platform,
      externalPostUrl: row.externalPostUrl,
      publishedAt: row.publishedAt!,
      lastCapturedOn: lastCapturedByTarget.get(row.publishTargetId) ?? null,
    }))
    .filter((row) => row.lastCapturedOn === null || row.lastCapturedOn < recentCaptureCutoff);
}

// === POST /api/post-stats ===

const nonNegativeIntOrNull = z.number().int().nonnegative().nullable().optional();

export const postStatIngestRowSchema = z
  .object({
    publish_target_id: z.string().uuid().optional(),
    external_post_url: z.string().min(1).optional(),
    impressions: nonNegativeIntOrNull,
    saves: nonNegativeIntOrNull,
    clicks: nonNegativeIntOrNull,
    outbound_clicks: nonNegativeIntOrNull,
    reactions: nonNegativeIntOrNull,
    comments: nonNegativeIntOrNull,
    reposts: nonNegativeIntOrNull,
    engagements: nonNegativeIntOrNull,
    captured_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "captured_on must be YYYY-MM-DD")
      .optional(),
  })
  .refine((row) => Boolean(row.publish_target_id || row.external_post_url), {
    message: "one of publish_target_id or external_post_url is required",
  });

export type PostStatIngestRow = z.infer<typeof postStatIngestRowSchema>;

export interface IngestResult {
  inserted: number;
  updated: number;
  rejected: { row: unknown; reason: string }[];
}

// Upserts on (publish_target_id, captured_on) — the unique index added
// in migration 0014 — so a re-run of the same day's capture (the
// Chrome routine retried, or someone reran it by hand) corrects that
// day's numbers in place rather than piling up duplicate snapshots.
// Processes rows one at a time (not a single bulk statement) so each
// row can be individually validated/rejected and counted as inserted
// vs. updated, which a single ON CONFLICT statement can't distinguish.
export async function ingestPostStats(db: DB, body: unknown): Promise<IngestResult> {
  const result: IngestResult = { inserted: 0, updated: 0, rejected: [] };

  const arraySchema = z.array(z.unknown());
  const arrayParsed = arraySchema.safeParse(body);
  if (!arrayParsed.success) {
    result.rejected.push({ row: body, reason: "request body must be a JSON array" });
    return result;
  }

  for (const rawRow of arrayParsed.data) {
    const parsed = postStatIngestRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      result.rejected.push({ row: rawRow, reason: parsed.error.issues.map((i) => i.message).join("; ") });
      continue;
    }
    const row = parsed.data;

    const lookupCondition = row.publish_target_id
      ? eq(publishTargets.id, row.publish_target_id)
      : eq(publishTargets.externalPostUrl, row.external_post_url!);

    const [target] = await db
      .select({ id: publishTargets.id, platform: contentItems.platform, externalPostId: publishTargets.externalPostId })
      .from(publishTargets)
      .innerJoin(contentItems, eq(publishTargets.contentItemId, contentItems.id))
      .where(lookupCondition)
      .limit(1);
    if (!target) {
      const identifier = row.publish_target_id ? `publish_target_id ${row.publish_target_id}` : `external_post_url ${row.external_post_url}`;
      result.rejected.push({ row: rawRow, reason: `no publish_target found for ${identifier}` });
      continue;
    }

    const capturedOn = row.captured_on ?? dateOnly(new Date());
    const values = {
      publishTargetId: target.id,
      platform: target.platform,
      externalPostId: target.externalPostId ?? "",
      impressions: row.impressions ?? null,
      saves: row.saves ?? null,
      clicks: row.clicks ?? null,
      outboundClicks: row.outbound_clicks ?? null,
      reactions: row.reactions ?? null,
      comments: row.comments ?? null,
      reposts: row.reposts ?? null,
      engagements: row.engagements ?? null,
      capturedOn,
      fetchedAt: new Date(),
    };

    const [existing] = await db
      .select({ id: postStats.id })
      .from(postStats)
      .where(and(eq(postStats.publishTargetId, target.id), eq(postStats.capturedOn, capturedOn)))
      .limit(1);

    if (existing) {
      await db.update(postStats).set(values).where(eq(postStats.id, existing.id));
      result.updated += 1;
    } else {
      await db.insert(postStats).values(values);
      result.inserted += 1;
    }
  }

  return result;
}

// Shared bearer-token check for both post-stats endpoints — a plain
// equality check against STATS_INGEST_TOKEN, never logged. Returns
// true/false rather than throwing so a route can return its own 401
// Response without this helper constructing one (keeps Response
// construction, and thus any accidental echoing of the header, out of
// this shared, more-widely-reviewed function).
export function isAuthorizedStatsIngestRequest(request: Request, token: string): boolean {
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${token}`;
}
