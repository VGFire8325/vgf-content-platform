import { db } from "@/db/client";
import { requireEnv } from "@/lib/env";
import { ingestPostStats, isAuthorizedStatsIngestRequest } from "@/lib/post-stats";

export const runtime = "nodejs";

// Accepts a JSON array of per-post metric snapshots from the separate
// Chrome-based capture routine and upserts them into post_stats (see
// src/lib/post-stats.ts for validation and upsert-on-(publish_target_id,
// captured_on) behavior). Never logs the request body's token or
// echoes the Authorization header back.
export async function POST(request: Request) {
  const { STATS_INGEST_TOKEN } = requireEnv("STATS_INGEST_TOKEN");
  if (!isAuthorizedStatsIngestRequest(request, STATS_INGEST_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const result = await ingestPostStats(db, body);
  return Response.json(result);
}
