import { db } from "@/db/client";
import { enqueueDueRefreshJobs } from "@/lib/connection-refresh";
import { requireEnv } from "@/lib/env";

export const runtime = "nodejs";

// Daily proactive token-renewal sweep: enqueues a refresh_token job
// (consumed by the normal 5-minute run-jobs cron) for every connection
// whose access token is within 7 days of expiry or already past it, so
// renewal happens independent of a publish ever failing first. Pinterest
// tokens last ~30 days; a daily sweep gives several chances to retry a
// transient refresh failure well before the token actually expires.
export async function GET(request: Request) {
  const { CRON_SECRET } = requireEnv("CRON_SECRET");
  if (request.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await enqueueDueRefreshJobs(db);
  return Response.json(result);
}
