import { db } from "@/db/client";
import { sendNotificationEmail } from "@/lib/email";
import { requireEnv } from "@/lib/env";
import { runOrderCheck } from "@/lib/orders/service";

export const runtime = "nodejs";

// Hourly order check (see runOrderCheck): an urgent alert + [URGENT] email
// for orders placed 24h+ ago whose New Order email isn't marked sent, and
// a normal alert + email for orders sent 72h+ ago with stock not yet
// confirmed. One email per alert. NOT yet scheduled in vercel.json: add
// { "path": "/api/cron/order-check", "schedule": "0 * * * *" } there once
// RESEND_API_KEY / ORDER_NOTIFY_TO / ORDER_NOTIFY_FROM are set in Vercel.
export async function GET(request: Request) {
  const { CRON_SECRET, APP_BASE_URL } = requireEnv("CRON_SECRET", "APP_BASE_URL");
  if (request.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await runOrderCheck(db, sendNotificationEmail, APP_BASE_URL);
  return Response.json(result, { status: result.emailErrors.length > 0 ? 500 : 200 });
}
