import { db } from "@/db/client";
import { sendNotificationEmail } from "@/lib/email";
import { requireEnv } from "@/lib/env";
import { processOrderCreated, supplierMailerFromEnv } from "@/lib/orders/service";
import { handleOrderWebhook, webhookSecrets } from "@/lib/orders/webhook-handler";

export const runtime = "nodejs";

// Shopify orders/create: the main trigger. The supplier is emailed when an
// order is PLACED (card only authorized), before Brendan charges the card.
//
// Not behind the login session (Shopify can't hold one); authenticated by
// the HMAC signature instead (see middleware.ts). Emails the supplier(s)
// through dispatchSupplierEmails, which reaches a real supplier only when
// SUPPLIER_EMAIL_MODE=live (otherwise Brendan only), plus one internal
// email to Brendan. Never emails a customer.
export async function POST(request: Request) {
  const { APP_BASE_URL } = requireEnv("APP_BASE_URL");
  return handleOrderWebhook(request, {
    topic: "orders/create",
    secrets: webhookSecrets(),
    process: (payload, eventAt) => processOrderCreated(db, payload, eventAt, APP_BASE_URL, supplierMailerFromEnv()),
    notify: sendNotificationEmail,
  });
}
