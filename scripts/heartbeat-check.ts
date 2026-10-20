// Dry-run / test mode for the app_heartbeat row: computes the current
// snapshot and upserts it, without posting anything or touching the
// job queue — writeHeartbeat (src/lib/heartbeat.ts) never calls
// Pinterest, LinkedIn, or Anthropic. Safe to run anytime to verify the
// heartbeat mechanism itself, independent of a real cron tick.
//
// Run with:
//   DATABASE_URL=... npx tsx scripts/heartbeat-check.ts
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { appHeartbeat } from "../src/db/schema";
import { HEARTBEAT_APP_ID, writeHeartbeat } from "../src/lib/heartbeat";

async function main() {
  await writeHeartbeat(db);
  const [row] = await db.select().from(appHeartbeat).where(eq(appHeartbeat.app, HEARTBEAT_APP_ID)).limit(1);
  if (!row) {
    throw new Error(`writeHeartbeat ran but no '${HEARTBEAT_APP_ID}' row exists — check for a logged write failure above`);
  }
  console.log(row);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
