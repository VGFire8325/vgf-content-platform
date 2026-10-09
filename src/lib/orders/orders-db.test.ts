// Database-backed tests for the order-fulfillment helper: webhook
// idempotency against the real unique constraint, create/paid/cancelled
// in any arrival order, supplier routing, and both order alerts (24h
// unsent, 72h stock confirmation) opening, emailing once, and resolving.
//
// Needs a throwaway Postgres; skipped unless ORDERS_TEST_DATABASE_URL is
// set (the rest of `npm test` stays credential-free). The database is
// migrated with the real drizzle/ migrations, then the order tables are
// truncated before each test. See README "Order fulfillment helper".
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const TEST_DB = process.env.ORDERS_TEST_DATABASE_URL;
const BASE = "https://app.example";
const HOUR = 3_600_000;

describe("order fulfillment (database)", { skip: TEST_DB ? false : "set ORDERS_TEST_DATABASE_URL to run" }, () => {
  // Imported lazily so DATABASE_URL points at the test DB before the
  // client is first used.
  let mod: {
    db: typeof import("@/db/client").db;
    schema: typeof import("@/db/schema");
    service: typeof import("./service");
    alerts: typeof import("@/lib/alerts");
    handler: typeof import("./webhook-handler");
    sql: typeof import("drizzle-orm").sql;
  };

  before(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const migrationClient = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(migrationClient), { migrationsFolder: `${process.cwd()}/drizzle` });
    await migrationClient.end();

    const { db } = await import("@/db/client");
    const { sql } = await import("drizzle-orm");
    mod = {
      db,
      schema: await import("@/db/schema"),
      service: await import("./service"),
      alerts: await import("@/lib/alerts"),
      handler: await import("./webhook-handler"),
      sql,
    };
  });

  after(async () => {
    await (mod?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end();
  });

  beforeEach(async () => {
    await mod.db.execute(mod.sql`truncate table order_items, orders, alerts`);
  });

  const CREATED = new Date("2026-11-27T15:00:00Z");

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      id: 7001,
      name: "#1322",
      order_number: 1322,
      created_at: CREATED.toISOString(),
      financial_status: "pending",
      email: "customer@example.com",
      payment_gateway_names: ["shopify_payments"],
      shipping_address: {
        name: "Brenda Peek",
        address1: "756 Pegasus Lane",
        city: "League City",
        province_code: "TX",
        zip: "77573",
        country: "United States",
        phone: "+1 702-204-3839",
      },
      line_items: [{ sku: "LPM-12016", name: "Landscape Pro Multi 120''", quantity: 1, vendor: "Modern Flames", requires_shipping: true }],
      ...overrides,
    };
  }

  const at = (hours: number) => new Date(CREATED.getTime() + hours * HOUR);
  const created = (p = payload(), t = at(0)) => mod.service.processOrderCreated(mod.db, p, t, BASE);
  const paid = (p = payload({ financial_status: "paid" }), t = at(48)) => mod.service.processOrderPaid(mod.db, p, t, BASE);
  const cancelled = (p = payload({ cancelled_at: at(30).toISOString() }), t = at(30)) => mod.service.processOrderCancelled(mod.db, p, t, BASE);
  const allOrders = () => mod.db.select().from(mod.schema.orders);
  const oneOrder = async () => {
    const rows = await allOrders();
    assert.equal(rows.length, 1);
    return rows[0]!;
  };

  test("orders/create stores the order once; a retry is a no-op", async () => {
    const first = await created();
    assert.equal(first.body.created, true);
    assert.equal(first.email?.subject, "Order #1322 placed: ready to send to Modern Flames (card not charged yet)");
    const retry = await created();
    assert.deepEqual(retry, { body: { created: false, reason: "duplicate", shopifyOrderId: "7001" }, email: null });

    const order = await oneOrder();
    assert.equal(order.status, "draft_ready");
    assert.equal(order.supplierId, "modern_flames");
    assert.equal(order.createdAtShopify.toISOString(), CREATED.toISOString());
    assert.equal(order.charged, false);
    assert.equal(order.paidAt, null);
    assert.equal(order.financialStatus, "pending");
    // Payment fields are stripped from the stored payload.
    assert.equal(JSON.stringify(order.rawPayload).includes("payment"), false);
    assert.equal((await mod.db.select().from(mod.schema.orderItems)).length, 1);
  });

  test("webhook end to end: signed orders/create notifies once, retry does not notify again", async () => {
    const secret = "test-secret";
    const sent: string[] = [];
    const deps = {
      topic: "orders/create" as const,
      secrets: [secret],
      process: (p: Parameters<typeof mod.service.processOrderCreated>[1], t: Date) => mod.service.processOrderCreated(mod.db, p, t, BASE),
      notify: async (e: { subject: string }) => {
        sent.push(e.subject);
      },
    };
    const body = JSON.stringify(payload());
    const request = () =>
      new Request(`${BASE}/api/webhooks/shopify/orders-create`, {
        method: "POST",
        body,
        headers: { "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"), "x-shopify-topic": "orders/create" },
      });
    assert.equal((await mod.handler.handleOrderWebhook(request(), deps)).status, 200);
    const retry = await mod.handler.handleOrderWebhook(request(), deps);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).reason, "duplicate");
    assert.deepEqual(sent, ["Order #1322 placed: ready to send to Modern Flames (card not charged yet)"]);
  });

  test("create then paid: paid records the charge on the same row and sends no email", async () => {
    await created();
    const result = await paid();
    assert.equal(result.email, null);
    assert.equal(result.body.orderCreated, false);
    const order = await oneOrder();
    assert.equal(order.charged, true);
    assert.equal(order.financialStatus, "paid");
    assert.equal(order.paidAt?.toISOString(), at(48).toISOString());
    assert.equal(order.status, "draft_ready"); // charged, but the draft still isn't sent

    // A retried orders/paid keeps the first paid_at.
    await paid(undefined, at(50));
    assert.equal((await oneOrder()).paidAt?.toISOString(), at(48).toISOString());
  });

  test("paid before create: paid stores the order (one email), the late create is a no-op", async () => {
    const first = await paid(undefined, at(0));
    assert.equal(first.body.orderCreated, true);
    assert.equal(first.email?.subject, "Order #1322 placed: ready to send to Modern Flames (card already charged)");
    const late = await created();
    assert.equal(late.email, null);
    assert.equal(late.body.reason, "duplicate");
    const order = await oneOrder();
    assert.equal(order.charged, true);
    assert.equal(order.paidAt?.toISOString(), at(0).toISOString());
    assert.equal(order.createdAtShopify.toISOString(), CREATED.toISOString());
    assert.equal((await mod.db.select().from(mod.schema.orderItems)).length, 1);
  });

  test("normal flow: draft_ready → sent → stock_confirmed → charged → shipped", async () => {
    const { body } = await created();
    assert.equal(body.status, "draft_ready");
    const orderId = (await oneOrder()).id;
    assert.equal((await mod.service.markSupplierSent(mod.db, orderId, "modern_flames", at(1))).status, "sent");
    assert.equal((await mod.service.markStockConfirmed(mod.db, orderId, true, at(20))).status, "stock_confirmed");
    await mod.service.setManufacturerReply(mod.db, orderId, "Freight quoted at $395", true);
    await paid(undefined, at(22));
    let order = await oneOrder();
    assert.equal(order.status, "charged");
    assert.equal(order.manufacturerReply, "Freight quoted at $395");
    assert.equal(order.needsApproval, true);
    order = await mod.service.setTrackingNumber(mod.db, orderId, "PRO 291-3486569", at(100));
    assert.equal(order.status, "shipped");
  });

  test("items from two suppliers get split; Extend add-on is ignored; unknown vendor needs attention", async () => {
    const result = await created(
      payload({
        line_items: [
          { sku: "LPM-12016", name: "Landscape Pro", quantity: 1, vendor: "Modern Flames", requires_shipping: true },
          { sku: "80044", name: "Sideline Elite 100", quantity: 1, vendor: "Touchstone", requires_shipping: true },
          { sku: "Extend-Plan", name: "Extend Protection Plan", quantity: 1, vendor: "Extend", requires_shipping: false },
          { sku: "FAB-1", name: "Faber thing", quantity: 1, vendor: "Faber", requires_shipping: true },
        ],
      }),
    );
    assert.equal(result.body.status, "needs_attention");
    assert.equal(result.email?.subject, "Order #1322 placed: needs attention (card not charged yet)");
    assert.match(result.email!.text, /"Faber"/);
    assert.match(result.email!.text, /Drafts are ready for: (Modern Flames, Touchstone|Touchstone, Modern Flames)/);

    const items = await mod.db.select().from(mod.schema.orderItems);
    assert.equal(items.length, 3); // Extend excluded
    const orderId = (await oneOrder()).id;
    assert.equal((await mod.service.assignItemSupplier(mod.db, items.find((i) => i.vendor === "Faber")!.id, "dimplex")).status, "draft_ready");

    // Sending to one supplier isn't enough; all three groups must be sent.
    let order = await mod.service.markSupplierSent(mod.db, orderId, "modern_flames", at(1));
    assert.equal(order.status, "draft_ready");
    assert.equal(order.sentAt, null);
    await mod.service.markSupplierSent(mod.db, orderId, "touchstone", at(1));
    order = await mod.service.markSupplierSent(mod.db, orderId, "dimplex", at(2));
    assert.equal(order.status, "sent");
    assert.equal(order.sentAt?.toISOString(), at(2).toISOString());
  });

  test("orders with only Extend or Route lines are skipped by all three webhooks", async () => {
    const addOnsOnly = payload({
      line_items: [
        { sku: "Extend-Protection-Plan-259.00", name: "Extend Protection Plan", quantity: 1, vendor: "Extend", requires_shipping: false },
        { sku: "ROUTEINS72", name: "Shipping Protection by Route", quantity: 1, vendor: "Route", requires_shipping: false },
      ],
    });
    assert.deepEqual(await created(addOnsOnly), { body: { created: false, reason: "nothing_to_fulfill" }, email: null });
    assert.equal((await paid(addOnsOnly)).body.reason, "nothing_to_fulfill");
    assert.equal((await cancelled(addOnsOnly)).body.reason, "nothing_to_fulfill");
    assert.equal((await allOrders()).length, 0);
  });

  test("24-hour check: urgent alert from Shopify creation time, emailed once, resolved when marked sent", async () => {
    await created(undefined, at(0));
    const emails: { subject: string; text: string }[] = [];
    const send = async (e: { subject: string; text: string }) => {
      emails.push(e);
    };
    const check = (h: number) => mod.service.runOrderCheck(mod.db, send, BASE, at(h));

    assert.equal((await check(23)).unsentOverdue, 0);
    assert.equal(emails.length, 0);

    const r = await check(25);
    assert.equal(r.alertsOpened, 1);
    assert.deepEqual(
      emails.map((e) => e.subject),
      ["[URGENT] Order #1322 not sent to the manufacturer after 24 hours"],
    );
    assert.match(emails[0]!.text, /placed 25 hours ago/);
    assert.doesNotMatch(emails[0]!.text, /\bpaid\b/i);
    assert.match(emails[0]!.text, /https:\/\/app\.example\/review\/orders#order-1322/);
    let open = await mod.alerts.listOpenAlerts(mod.db);
    assert.deepEqual(open.map((a) => [a.key, a.severity, Boolean(a.emailedAt)]), [["order_unsent_1322", "urgent", true]]);

    // Next hour: same alert, no second email.
    assert.equal((await check(26)).alertsOpened, 0);
    assert.equal(emails.length, 1);

    await mod.service.markSupplierSent(mod.db, (await oneOrder()).id, "modern_flames", at(27));
    open = await mod.alerts.listOpenAlerts(mod.db);
    assert.equal(open.length, 0);
    assert.equal((await check(28)).unsentOverdue, 0);
    assert.equal(emails.length, 1);
  });

  test("72-hour check: normal alert when sent but stock not confirmed, resolved when confirmed", async () => {
    await created(undefined, at(0));
    const orderId = (await oneOrder()).id;
    await mod.service.markSupplierSent(mod.db, orderId, "modern_flames", at(2));
    const emails: string[] = [];
    const send = async (e: { subject: string }) => {
      emails.push(e.subject);
    };
    const check = (h: number) => mod.service.runOrderCheck(mod.db, send, BASE, at(h));

    // Sent at +2h: nothing until 72h after sending.
    assert.equal((await check(74)).awaitingStockConfirmation, 0);
    const r = await check(75);
    assert.equal(r.awaitingStockConfirmation, 1);
    assert.equal(r.unsentOverdue, 0);
    assert.deepEqual(emails, ["Order #1322: no stock confirmation 72 hours after sending"]);
    let open = await mod.alerts.listOpenAlerts(mod.db);
    assert.deepEqual(open.map((a) => [a.key, a.severity]), [["order_unconfirmed_1322", "normal"]]);

    await check(76);
    assert.equal(emails.length, 1); // emailed once per alert

    await mod.service.markStockConfirmed(mod.db, orderId, true, at(77));
    open = await mod.alerts.listOpenAlerts(mod.db);
    assert.equal(open.length, 0);
    assert.equal((await check(78)).awaitingStockConfirmation, 0);
  });

  test("cancelling resolves the 72-hour alert too", async () => {
    await created(undefined, at(0));
    await mod.service.markSupplierSent(mod.db, (await oneOrder()).id, "modern_flames", at(1));
    await mod.service.runOrderCheck(mod.db, async () => {}, BASE, at(80));
    assert.equal((await mod.alerts.listOpenAlerts(mod.db)).length, 1);
    await cancelled(payload({ cancelled_at: at(81).toISOString() }), at(81));
    assert.equal((await mod.alerts.listOpenAlerts(mod.db)).length, 0);
  });

  test("cancelled before sending: status cancelled, urgent alert resolved, short note to Brendan", async () => {
    await created(undefined, at(0));
    await mod.service.runOrderCheck(mod.db, async () => {}, BASE, at(25));
    assert.equal((await mod.alerts.listOpenAlerts(mod.db)).length, 1);

    const result = await cancelled();
    assert.equal(result.email?.subject, "Order #1322 cancelled");
    assert.match(result.email!.text, /hadn't been marked sent/);
    const order = await oneOrder();
    assert.equal(order.status, "cancelled");
    assert.equal(order.cancelledAt?.toISOString(), at(30).toISOString());
    assert.equal((await mod.alerts.listOpenAlerts(mod.db)).length, 0);

    // A retried cancellation sends nothing; the hourly check stays quiet.
    assert.equal((await cancelled()).email, null);
    const emails: string[] = [];
    const r = await mod.service.runOrderCheck(mod.db, async (e) => void emails.push(e.subject), BASE, at(40));
    assert.equal(r.unsentOverdue, 0);
    assert.equal(emails.length, 0);
  });

  test("cancelled after sending: the note tells Brendan which manufacturer to contact", async () => {
    await created(undefined, at(0));
    await mod.service.markSupplierSent(mod.db, (await oneOrder()).id, "modern_flames", at(1));
    const result = await cancelled();
    assert.match(result.email!.text, /already went to Modern Flames/);
  });

  test("cancelled arriving before create: stored as cancelled, no duplicate, no emails", async () => {
    const first = await cancelled();
    assert.equal(first.email, null);
    assert.equal((await created()).body.reason, "duplicate");
    const order = await oneOrder();
    assert.equal(order.status, "cancelled");
  });

  test("a failed alert email is retried on the next run", async () => {
    await created(undefined, at(0));
    let fail = true;
    const sent: string[] = [];
    const send = async (e: { subject: string }) => {
      if (fail) throw new Error("Resend down");
      sent.push(e.subject);
    };
    assert.equal((await mod.service.runOrderCheck(mod.db, send, BASE, at(25))).emailErrors.length, 1);
    fail = false;
    assert.equal((await mod.service.runOrderCheck(mod.db, send, BASE, at(26))).emailsSent, 1);
    assert.equal(sent.length, 1);
  });

  test("alerts: one open row per key, and a resolved key can reopen as a new row", async () => {
    const a = await mod.alerts.openAlert(mod.db, { key: "k1", severity: "warning", message: "one" });
    const b = await mod.alerts.openAlert(mod.db, { key: "k1", severity: "warning", message: "two" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.alert.id, a.alert.id);
    assert.equal(b.alert.message, "two");
    assert.equal(await mod.alerts.resolveAlert(mod.db, "k1"), 1);
    assert.equal(await mod.alerts.resolveAlert(mod.db, "k1"), 0);
    const c = await mod.alerts.openAlert(mod.db, { key: "k1", severity: "warning", message: "three" });
    assert.equal(c.created, true);
    assert.notEqual(c.alert.id, a.alert.id);
  });
});
