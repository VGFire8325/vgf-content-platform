import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { NotificationEmail } from "@/lib/email";
import type { IngestResult } from "./service";
import { handleOrdersPaid, type OrdersPaidDeps } from "./webhook-handler";

const SECRET = "app-secret";
const BODY = JSON.stringify({ id: 7001, order_number: 1322, line_items: [] });

function request(body = BODY, { secret = SECRET, topic = "orders/paid", headers = {} as Record<string, string> } = {}) {
  return new Request("https://x/api/webhooks/shopify/orders-paid", {
    method: "POST",
    body,
    headers: { "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"), "x-shopify-topic": topic, ...headers },
  });
}

// In-memory stand-in for ingestPaidOrder with the same idempotency rule
// (the real unique constraint is covered in orders-db.test.ts).
function fakeDeps(overrides: Partial<OrdersPaidDeps> = {}) {
  const seen = new Set<string>();
  const notified: NotificationEmail[] = [];
  const paidAts: Date[] = [];
  const deps: OrdersPaidDeps = {
    secrets: [SECRET],
    ingest: async (payload, paidAt): Promise<IngestResult> => {
      paidAts.push(paidAt);
      const id = String(payload.id);
      if (seen.has(id)) return { created: false, shopifyOrderId: id, reason: "duplicate" };
      seen.add(id);
      return {
        created: true,
        order: { orderNumber: String(payload.order_number), status: "draft_ready", customerName: "X" } as never,
        supplierNames: ["Modern Flames"],
        unmatchedVendors: [],
      };
    },
    buildEmail: (r) => ({ subject: `Order #${r.order.orderNumber} is ready`, text: "" }),
    notify: async (e) => {
      notified.push(e);
    },
    ...overrides,
  };
  return { deps, notified, paidAts };
}

test("rejects an unsigned or wrongly signed delivery with 401 and stores nothing", async () => {
  const { deps, notified, paidAts } = fakeDeps();
  assert.equal((await handleOrdersPaid(request(BODY, { secret: "wrong" }), deps)).status, 401);
  const unsigned = new Request("https://x", { method: "POST", body: BODY });
  assert.equal((await handleOrdersPaid(unsigned, deps)).status, 401);
  assert.equal(paidAts.length, 0);
  assert.equal(notified.length, 0);
});

test("a Shopify retry of the same order returns 200 and sends no second notification", async () => {
  const { deps, notified } = fakeDeps();
  const first = await handleOrdersPaid(request(), deps);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).created, true);
  const retry = await handleOrdersPaid(request(), deps);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { created: false, reason: "duplicate", shopifyOrderId: "7001" });
  assert.equal(notified.length, 1);
});

test("a failed notification email still returns 200 so Shopify doesn't retry", async () => {
  const { deps } = fakeDeps({
    notify: async () => {
      throw new Error("Resend down");
    },
  });
  const res = await handleOrdersPaid(request(), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).notified, false);
});

test("uses Shopify's triggered-at time as paid_at (stable across retries)", async () => {
  const { deps, paidAts } = fakeDeps();
  await handleOrdersPaid(request(BODY, { headers: { "x-shopify-triggered-at": "2026-11-27T15:00:00.000Z" } }), deps);
  assert.equal(paidAts[0]!.toISOString(), "2026-11-27T15:00:00.000Z");
});

test("other topics are acknowledged and ignored; missing secret is a 500", async () => {
  const { deps, paidAts } = fakeDeps();
  const res = await handleOrdersPaid(request(BODY, { topic: "orders/create" }), deps);
  assert.equal(res.status, 200);
  assert.equal(paidAts.length, 0);
  assert.equal((await handleOrdersPaid(request(), { ...deps, secrets: ["", ""] })).status, 500);
});
