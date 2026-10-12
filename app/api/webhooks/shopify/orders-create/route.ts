import { db } from "@/db/client";
import { sendNotificationEmail } from "@/lib/email";
import { requireEnv } from "@/lib/env";
import { processOrderCreated } from "@/lib/orders/service";
import { handleOrderWebhook, webhookSecrets } from "@/lib/orders/webhook-handler";

export const runtime = "nodejs";

// Shopify orders/create: the main trigger. Brendan emails the manufacturer when an order is
// PLACED, before charging the card, so this is where the draft is made.
//
// Not behind the login session (Shopify can't hold one); authenticated by
// the HMAC signature instead (see middleware.ts). Only ever emails Brendan,
// never a manufacturer.
export async function POST(request: Request) {
  const { APP_BASE_URL } = requireEnv("APP_BASE_URL");
  return handleOrderWebhook(request, {
    topic: "orders/create",
    secrets: webhookSecrets(),
    process: (payload, eventAt) => processOrderCreated(db, payload, eventAt, APP_BASE_URL),
    notify: sendNotificationEmail,
  });
}
