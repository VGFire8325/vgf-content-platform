// Database-backed tests for the order-fulfillment helper: webhook
// idempotency against the real unique constraint, supplier routing on
// insert, and the 24-hour alert opening, emailing once, and resolving.
//
// Needs a throwaway Postgres; skipped unless ORDERS_TEST_DATABASE_URL is
// set (the rest of `npm test` stays credential-free). The database is
// migrated with the real drizzle/ migrations, then every table this file
// touches is truncated before each test. See README "Order fulfillment".
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const TEST_DB = process.env.ORDERS_TEST_DATABASE_URL;

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
    eq: typeof import("drizzle-orm").eq;
  };
  let closeClient: () => Promise<void>;

  before(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const migrationClient = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(migrationClient), { migrationsFolder: `${process.cwd()}/drizzle` });
    await migrationClient.end();

    const { db } = await import("@/db/client");
    const { sql, eq } = await import("drizzle-orm");
    mod = {
      db,
      schema: await import("@/db/schema"),
      service: await import("./service"),
      alerts: await import("@/lib/alerts"),
      handler: await import("./webhook-handler"),
      sql,
      eq,
    };
    closeClient = async () => {
      await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    };
  });

  after(async () => {
    await closeClient?.();
  });

  beforeEach(async () => {
    await mod.db.execute(mod.sql`truncate table order_items, orders, alerts`);
  });

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      id: 7001,
      name: "#1322",
      order_number: 1322,
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

  const PAID = new Date("2026-11-27T15:00:00Z");

  test("a paid order is stored once; a Shopify retry is a no-op", async () => {
    const first = await mod.service.ingestPaidOrder(mod.db, payload(), PAID);
    assert.equal(first.created, true);
    const retry = await mod.service.ingestPaidOrder(mod.db, payload(), PAID);
    assert.equal(retry.created, false);

    const rows = await mod.db.select().from(mod.schema.orders);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "draft_ready");
    assert.equal(rows[0]!.supplierId, "modern_flames");
    assert.equal(rows[0]!.orderNumber, "1322");
    // Payment fields are stripped from the stored payload.
    assert.equal(JSON.stringify(rows[0]!.rawPayload).includes("payment"), false);
    const items = await mod.db.select().from(mod.schema.orderItems);
    assert.equal(items.length, 1);
  });

  test("webhook end to end: signed delivery notifies once, retry does not notify again", async () => {
    const secret = "test-secret";
    const sent: string[] = [];
    const deps = {
      secrets: [secret],
      ingest: (p: Parameters<typeof mod.service.ingestPaidOrder>[1], paidAt: Date) => mod.service.ingestPaidOrder(mod.db, p, paidAt),
      buildEmail: (r: Parameters<typeof mod.service.newOrderEmail>[0]) => mod.service.newOrderEmail(r, "https://app.example"),
      notify: async (e: { subject: string }) => {
        sent.push(e.subject);
      },
    };
    const body = JSON.stringify(payload());
    const request = () =>
      new Request("https://app.example/api/webhooks/shopify/orders-paid", {
        method: "POST",
        body,
        headers: {
          "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
          "x-shopify-topic": "orders/paid",
        },
      });
    assert.equal((await mod.handler.handleOrdersPaid(request(), deps)).status, 200);
    const retry = await mod.handler.handleOrdersPaid(request(), deps);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { created: false, reason: "duplicate", shopifyOrderId: "7001" });
    assert.deepEqual(sent, ["Order #1322 is ready to send to Modern Flames"]);
  });

  test("items from two suppliers get split; Extend add-on is ignored; unknown vendor needs attention", async () => {
    const result = await mod.service.ingestPaidOrder(
      mod.db,
      payload({
        line_items: [
          { sku: "LPM-12016", name: "Landscape Pro", quantity: 1, vendor: "Modern Flames", requires_shipping: true },
          { sku: "80044", name: "Sideline Elite 100", quantity: 1, vendor: "Touchstone", requires_shipping: true },
          { sku: "Extend-Plan", name: "Extend Protection Plan", quantity: 1, vendor: "Extend", requires_shipping: false },
          { sku: "FAB-1", name: "Faber thing", quantity: 1, vendor: "Faber", requires_shipping: true },
        ],
      }),
      PAID,
    );
    assert.ok(result.created);
    assert.equal(result.order.status, "needs_attention");
    assert.equal(result.order.supplierId, null);
    assert.deepEqual(result.supplierNames.sort(), ["Modern Flames", "Touchstone"]);
    assert.deepEqual(result.unmatchedVendors, ["Faber"]);
    const email = mod.service.newOrderEmail(result, "https://app.example");
    assert.equal(email.subject, "Order #1322 needs attention");
    assert.match(email.text, /"Faber"/);

    const items = await mod.db.select().from(mod.schema.orderItems);
    assert.equal(items.length, 3); // Extend excluded

    // Assigning the Faber item clears needs_attention.
    const faber = items.find((i) => i.vendor === "Faber")!;
    const updated = await mod.service.assignItemSupplier(mod.db, faber.id, "dimplex");
    assert.equal(updated.status, "draft_ready");

    // Sending to one supplier isn't enough; all three groups must be sent.
    const orderId = result.order.id;
    let order = await mod.service.markSupplierSent(mod.db, orderId, "modern_flames");
    assert.equal(order.status, "draft_ready");
    assert.equal(order.sentAt, null);
    await mod.service.markSupplierSent(mod.db, orderId, "touchstone");
    order = await mod.service.markSupplierSent(mod.db, orderId, "dimplex");
    assert.equal(order.status, "sent");
    assert.ok(order.sentAt);
  });

  test("an order with only an Extend protection plan isn't stored or alerted on", async () => {
    const result = await mod.service.ingestPaidOrder(
      mod.db,
      payload({ line_items: [{ sku: "Extend-Protection-Plan-259.00", name: "Extend Protection Plan", quantity: 1, vendor: "Extend", requires_shipping: false }] }),
      PAID,
    );
    assert.deepEqual(result, { created: false, shopifyOrderId: "7001", reason: "nothing_to_fulfill" });
    assert.equal((await mod.db.select().from(mod.schema.orders)).length, 0);
  });

  test("24-hour check opens an urgent alert, emails once, and marking sent resolves it", async () => {
    const result = await mod.service.ingestPaidOrder(mod.db, payload(), PAID);
    assert.ok(result.created);
    const emails: { subject: string; text: string }[] = [];
    const send = async (e: { subject: string; text: string }) => {
      emails.push(e);
    };

    // 23 hours after payment: nothing yet.
    let check = await mod.service.runOrderCheck(mod.db, send, "https://app.example", new Date(PAID.getTime() + 23 * 3_600_000));
    assert.equal(check.overdue, 0);
    assert.equal(emails.length, 0);

    // 25 hours: alert opens and the [URGENT] email goes out.
    check = await mod.service.runOrderCheck(mod.db, send, "https://app.example", new Date(PAID.getTime() + 25 * 3_600_000));
    assert.equal(check.alertsOpened, 1);
    assert.equal(emails.length, 1);
    assert.equal(emails[0]!.subject, "[URGENT] Order #1322 not sent after 24 hours");
    assert.match(emails[0]!.text, /https:\/\/app\.example\/review\/orders#order-1322/);

    let open = await mod.alerts.listOpenAlerts(mod.db);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.key, "order_unsent_1322");
    assert.equal(open[0]!.severity, "urgent");
    assert.ok(open[0]!.emailedAt);

    // Next hour: same alert, refreshed, no second email.
    check = await mod.service.runOrderCheck(mod.db, send, "https://app.example", new Date(PAID.getTime() + 26 * 3_600_000));
    assert.equal(check.alertsOpened, 0);
    assert.equal(emails.length, 1);
    open = await mod.alerts.listOpenAlerts(mod.db);
    assert.equal(open.length, 1);

    // Marking it sent resolves the alert.
    await mod.service.markSupplierSent(mod.db, result.order.id, "modern_flames", new Date(PAID.getTime() + 27 * 3_600_000));
    assert.equal((await mod.alerts.listOpenAlerts(mod.db)).length, 0);
    check = await mod.service.runOrderCheck(mod.db, send, "https://app.example", new Date(PAID.getTime() + 28 * 3_600_000));
    assert.equal(check.overdue, 0);
    assert.equal(emails.length, 1);
  });

  test("a failed urgent email is retried on the next run", async () => {
    await mod.service.ingestPaidOrder(mod.db, payload(), PAID);
    let fail = true;
    const sent: string[] = [];
    const send = async (e: { subject: string }) => {
      if (fail) throw new Error("Resend down");
      sent.push(e.subject);
    };
    const r1 = await mod.service.runOrderCheck(mod.db, send, "https://app.example", new Date(PAID.getTime() + 25 * 3_600_000));
    assert.equal(r1.emailErrors.length, 1);
    fail = false;
    const r2 = await mod.service.runOrderCheck(mod.db, send, "https://app.example", new Date(PAID.getTime() + 26 * 3_600_000));
    assert.equal(r2.emailsSent, 1);
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
