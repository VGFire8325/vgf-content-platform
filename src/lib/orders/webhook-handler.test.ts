import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { NotificationEmail } from "@/lib/email";
import { handleOrderWebhook, type OrderWebhookDeps, type ShopifyOrderTopic } from "./webhook-handler";

const SECRET = "app-secret";
const BODY = JSON.stringify({ id: 7001, order_number: 1322, line_items: [] });

function request(topic: ShopifyOrderTopic | string = "orders/create", { body = BODY, secret = SECRET, headers = {} as Record<string, string> } = {}) {
  return new Request("https://x/api/webhooks/shopify/orders-create", {
    method: "POST",
    body,
    headers: { "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"), "x-shopify-topic": topic, ...headers },
  });
}

// In-memory stand-in for processOrderCreated with the same idempotency
// rule (the real unique constraint is covered in orders-db.test.ts).
function fakeDeps(overrides: Partial<OrderWebhookDeps> = {}) {
  const seen = new Set<string>();
  const notified: NotificationEmail[] = [];
  const eventAts: Date[] = [];
  const deps: OrderWebhookDeps = {
    topic: "orders/create",
    secrets: [SECRET],
    process: async (payload, eventAt) => {
      eventAts.push(eventAt);
      const id = String(payload.id);
      if (seen.has(id)) return { body: { created: false, reason: "duplicate" }, email: null };
      seen.add(id);
      return { body: { created: true }, email: { subject: `Order #${payload.order_number} placed`, text: "" } };
    },
    notify: async (e) => {
      notified.push(e);
    },
    ...overrides,
  };
  return { deps, notified, eventAts };
}

test("rejects an unsigned or wrongly signed delivery with 401 and processes nothing", async () => {
  const { deps, notified, eventAts } = fakeDeps();
  assert.equal((await handleOrderWebhook(request("orders/create", { secret: "wrong" }), deps)).status, 401);
  assert.equal((await handleOrderWebhook(new Request("https://x", { method: "POST", body: BODY }), deps)).status, 401);
  assert.equal(eventAts.length, 0);
  assert.equal(notified.length, 0);
});

test("a Shopify retry of the same order returns 200 and sends no second notification", async () => {
  const { deps, notified } = fakeDeps();
  const first = await handleOrderWebhook(request(), deps);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { created: true, notified: true });
  const retry = await handleOrderWebhook(request(), deps);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { created: false, reason: "duplicate" });
  assert.equal(notified.length, 1);
});

test("a failed notification email still returns 200 so Shopify doesn't retry", async () => {
  const { deps } = fakeDeps({
    notify: async () => {
      throw new Error("Resend down");
    },
  });
  const res = await handleOrderWebhook(request(), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).notified, false);
});

test("passes Shopify's triggered-at time through as the event time", async () => {
  const { deps, eventAts } = fakeDeps();
  await handleOrderWebhook(request("orders/create", { headers: { "x-shopify-triggered-at": "2026-11-27T15:00:00.000Z" } }), deps);
  assert.equal(eventAts[0]!.toISOString(), "2026-11-27T15:00:00.000Z");
});

test("each route only acts on its own topic", async () => {
  for (const topic of ["orders/create", "orders/paid", "orders/cancelled"] as const) {
    const { deps, eventAts } = fakeDeps({ topic });
    for (const other of ["orders/create", "orders/paid", "orders/cancelled", "orders/updated"]) {
      const res = await handleOrderWebhook(request(other), deps);
      assert.equal(res.status, 200);
    }
    assert.equal(eventAts.length, 1, topic);
  }
});

test("missing secret is a 500; invalid JSON with a valid signature is a 400", async () => {
  const { deps } = fakeDeps();
  assert.equal((await handleOrderWebhook(request(), { ...deps, secrets: ["", ""] })).status, 500);
  assert.equal((await handleOrderWebhook(request("orders/create", { body: "{not json" }), deps)).status, 400);
});
