import { db } from "@/db/client";
import { sendNotificationEmail } from "@/lib/email";
import { requireEnv } from "@/lib/env";
import { ingestPaidOrder, newOrderEmail } from "@/lib/orders/service";
import { handleOrdersPaid } from "@/lib/orders/webhook-handler";

export const runtime = "nodejs";

// Shopify `orders/paid` webhook. Not behind the login session (Shopify
// can't hold one); authenticated by the HMAC signature instead — see
// middleware.ts and handleOrdersPaid. This only stores the order and
// emails Brendan; it never emails a manufacturer.
export async function POST(request: Request) {
  const { APP_BASE_URL } = requireEnv("APP_BASE_URL");
  return handleOrdersPaid(request, {
    // SHOPIFY_WEBHOOK_SECRET: the key shown in Shopify admin under
    // Settings → Notifications → Webhooks, if the webhook was created
    // there. SHOPIFY_CLIENT_SECRET: signs webhooks registered by the app.
    secrets: [process.env.SHOPIFY_WEBHOOK_SECRET ?? "", process.env.SHOPIFY_CLIENT_SECRET ?? ""],
    ingest: (payload, paidAt) => ingestPaidOrder(db, payload, paidAt),
    buildEmail: (result) => newOrderEmail(result, APP_BASE_URL),
    notify: sendNotificationEmail,
  });
}
