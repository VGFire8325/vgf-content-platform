import type { NotificationEmail } from "@/lib/email";
import { verifyShopifyWebhook, type ShopifyOrderPayload } from "./shopify-webhook";

export type ShopifyOrderTopic = "orders/create" | "orders/paid" | "orders/cancelled";

export interface OrderWebhookDeps {
  topic: ShopifyOrderTopic;
  secrets: string[];
  // Does the DB work; returns the JSON for Shopify and at most one email
  // for Brendan (e.g. processOrderCreated in ./service).
  process: (payload: ShopifyOrderPayload, eventAt: Date) => Promise<{ body: Record<string, unknown>; email: NotificationEmail | null }>;
  notify: (email: NotificationEmail) => Promise<void>;
  now?: () => Date;
}

// Request → Response logic shared by the three Shopify order webhook
// routes (orders-create, orders-paid, orders-cancelled), with collaborators
// injected so signature checks and retry handling are unit-testable
// without a database or network.
//
// Status codes matter to Shopify: anything non-2xx is retried (up to 8
// times over 4 hours), so a duplicate delivery gets a 200, and a failed
// email to Brendan still gets a 200 (the order is safely stored; the
// hourly check is the backstop).
export async function handleOrderWebhook(request: Request, deps: OrderWebhookDeps): Promise<Response> {
  const secrets = deps.secrets.filter(Boolean);
  if (secrets.length === 0) {
    console.error(`${deps.topic} webhook: no signing secret configured (SHOPIFY_WEBHOOK_SECRET / SHOPIFY_CLIENT_SECRET)`);
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const rawBody = await request.text();
  if (!verifyShopifyWebhook(rawBody, request.headers.get("x-shopify-hmac-sha256"), secrets)) {
    return new Response("Invalid signature", { status: 401 });
  }

  // A webhook registered against the wrong route is acknowledged but
  // ignored, rather than being treated as a different event.
  const topic = request.headers.get("x-shopify-topic");
  if (topic && topic !== deps.topic) {
    return Response.json({ ignored: true, topic, expected: deps.topic });
  }

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Shopify's own event time survives retries; fall back to now.
  const triggeredAt = request.headers.get("x-shopify-triggered-at");
  const parsedTime = triggeredAt ? new Date(triggeredAt) : null;
  const eventAt = parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime : (deps.now?.() ?? new Date());

  const { body, email } = await deps.process(payload, eventAt);

  if (email) {
    try {
      await deps.notify(email);
      body.notified = true;
    } catch (err) {
      body.notified = false;
      console.error(`${deps.topic} webhook: notification email failed (${email.subject}):`, err);
    }
  }
  return Response.json(body);
}

// SHOPIFY_WEBHOOK_SECRET: the key shown in Shopify admin under Settings →
// Notifications → Webhooks (the same key signs every admin-created
// webhook, so all three routes share it). SHOPIFY_CLIENT_SECRET: signs
// webhooks registered by the app itself.
export function webhookSecrets(): string[] {
  return [process.env.SHOPIFY_WEBHOOK_SECRET ?? "", process.env.SHOPIFY_CLIENT_SECRET ?? ""];
}
