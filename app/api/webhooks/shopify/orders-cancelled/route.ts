import { db } from "@/db/client";
import { sendNotificationEmail } from "@/lib/email";
import { requireEnv } from "@/lib/env";
import { processOrderCancelled } from "@/lib/orders/service";
import { handleOrderWebhook, webhookSecrets } from "@/lib/orders/webhook-handler";

export const runtime = "nodejs";

// Shopify orders/cancelled: marks the order cancelled, resolves its alerts, and
// tells Brendan whether the New Order email had already gone out.
//
// Not behind the login session (Shopify can't hold one); authenticated by
// the HMAC signature instead (see middleware.ts). Only ever emails Brendan,
// never a manufacturer.
export async function POST(request: Request) {
  const { APP_BASE_URL } = requireEnv("APP_BASE_URL");
  return handleOrderWebhook(request, {
    topic: "orders/cancelled",
    secrets: webhookSecrets(),
    process: (payload, eventAt) => processOrderCancelled(db, payload, eventAt, APP_BASE_URL),
    notify: sendNotificationEmail,
  });
}
