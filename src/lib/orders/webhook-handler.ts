import type { NotificationEmail } from "@/lib/email";
import type { IngestResult } from "./service";
import { verifyShopifyWebhook, type ShopifyOrderPayload } from "./shopify-webhook";

export interface OrdersPaidDeps {
  secrets: string[];
  ingest: (payload: ShopifyOrderPayload, paidAt: Date) => Promise<IngestResult>;
  buildEmail: (result: Extract<IngestResult, { created: true }>) => NotificationEmail;
  notify: (email: NotificationEmail) => Promise<void>;
  now?: () => Date;
}

// Request → Response logic for /api/webhooks/shopify/orders-paid, with its
// collaborators injected so signature checks and retry handling are
// unit-testable without a database or network.
//
// Status codes matter to Shopify: anything non-2xx is retried (up to 8
// times over 4 hours), so a duplicate delivery gets a 200, and a
// notification-email failure still gets a 200 (the order is safely
// stored; the hourly 24-hour check is the backstop).
export async function handleOrdersPaid(request: Request, deps: OrdersPaidDeps): Promise<Response> {
  const secrets = deps.secrets.filter(Boolean);
  if (secrets.length === 0) {
    console.error("orders-paid webhook: no signing secret configured (SHOPIFY_WEBHOOK_SECRET / SHOPIFY_CLIENT_SECRET)");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const rawBody = await request.text();
  if (!verifyShopifyWebhook(rawBody, request.headers.get("x-shopify-hmac-sha256"), secrets)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const topic = request.headers.get("x-shopify-topic");
  if (topic && topic !== "orders/paid") {
    return Response.json({ ignored: true, topic });
  }

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Shopify's own event time survives retries; fall back to the order's
  // processed_at, then to now.
  const triggeredAt = request.headers.get("x-shopify-triggered-at") ?? payload.processed_at;
  const parsedTime = triggeredAt ? new Date(triggeredAt) : null;
  const paidAt = parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime : (deps.now?.() ?? new Date());

  const result = await deps.ingest(payload, paidAt);
  if (!result.created) {
    return Response.json({ created: false, reason: result.reason, shopifyOrderId: result.shopifyOrderId });
  }

  let notified = true;
  try {
    await deps.notify(deps.buildEmail(result));
  } catch (err) {
    notified = false;
    console.error(`orders-paid webhook: notification email failed for order #${result.order.orderNumber}:`, err);
  }
  return Response.json({ created: true, orderNumber: result.order.orderNumber, status: result.order.status, notified });
}
