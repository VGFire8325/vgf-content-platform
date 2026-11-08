import { db } from "@/db/client";
import { platformEnum } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { isAuthorizedStatsIngestRequest, listPendingPostStats } from "@/lib/post-stats";

export const runtime = "nodejs";

// Lists published posts the separate Chrome-based capture routine
// should (re-)fetch analytics for. See src/lib/post-stats.ts for the
// exact "older than 3 days, not captured in the last 7 days" rule.
export async function GET(request: Request) {
  const { STATS_INGEST_TOKEN } = requireEnv("STATS_INGEST_TOKEN");
  if (!isAuthorizedStatsIngestRequest(request, STATS_INGEST_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const platformParam = url.searchParams.get("platform");
  if (platformParam && !platformEnum.enumValues.includes(platformParam as (typeof platformEnum.enumValues)[number])) {
    return Response.json({ error: `invalid platform '${platformParam}'` }, { status: 400 });
  }

  const pending = await listPendingPostStats(db, {
    platform: platformParam as (typeof platformEnum.enumValues)[number] | null,
  });
  return Response.json(pending);
}
