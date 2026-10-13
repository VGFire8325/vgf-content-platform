import { db } from "@/db/client";
import { sendNotificationEmail } from "@/lib/email";
import { requireEnv } from "@/lib/env";
import { processOrderPaid, supplierMailerFromEnv } from "@/lib/orders/service";
import { handleOrderWebhook, webhookSecrets } from "@/lib/orders/webhook-handler";

export const runtime = "nodejs";

// Shopify orders/paid: Brendan charged the card in Shopify. Records paid_at,
// financial_status and the charged flag (and stores the order if this
// arrives before orders/create).
//
// Not behind the login session (Shopify can't hold one); authenticated by
// the HMAC signature instead (see middleware.ts). Emails the supplier(s)
// through dispatchSupplierEmails, which reaches a real supplier only when
// SUPPLIER_EMAIL_MODE=live (otherwise Brendan only), plus one internal
// email to Brendan. Never emails a customer.
export async function POST(request: Request) {
  const { APP_BASE_URL } = requireEnv("APP_BASE_URL");
  return handleOrderWebhook(request, {
    topic: "orders/paid",
    secrets: webhookSecrets(),
    process: (payload, eventAt) => processOrderPaid(db, payload, eventAt, APP_BASE_URL, supplierMailerFromEnv()),
    notify: sendNotificationEmail,
  });
}
