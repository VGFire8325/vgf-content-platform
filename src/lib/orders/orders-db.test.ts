// Database-backed tests for the order-fulfillment helper: webhook
// idempotency against the real unique constraint, create/paid/cancelled
// in any arrival order, supplier routing, automatic supplier emails (sent
// exactly once across retries and concurrent deliveries, test mode, and
// the portal / unmatched / inactive / first-order paths), and both order
// alerts (24h unsent, 72h stock confirmation) opening, emailing once, and
// resolving. No real email is sent: the supplier mailer is a fake that
// records what the real one would have sent where.
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
    email: typeof import("@/lib/email");
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
      email: await import("@/lib/email"),
      sql,
    };
  });

  after(async () => {
    await (mod?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end();
  });

  beforeEach(async () => {
    await mod.db.execute(mod.sql`truncate table supplier_emails, order_items, orders, alerts`);
    await mod.db.execute(mod.sql`update suppliers set ordered_before = (id <> 'litedeer')`);
    mail = fakeMailer("test");
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

  // Records every supplier email instead of sending it, computing the
  // recipients with the real buildSupplierEmailBody so test-mode redirects
  // are exercised. fail(...) makes the next send throw that error.
  type Sent = { supplierId: string; to: string[]; subject: string; text: string; key: string };
  function fakeMailer(mode: "test" | "live") {
    const sent: Sent[] = [];
    let nextError: Error | null = null;
    const config = {
      mode,
      from: "Very Good Fireplaces <orders@verygoodfireplaces.com>",
      replyTo: "Brendan@verygoodfireplaces.com",
      bcc: ["Brendan@verygoodfireplaces.com"],
      notifyTo: ["brendan@example.com"],
    };
    const mailer = {
      mode,
      replyTo: "Brendan@verygoodfireplaces.com",
      send: async (e: Parameters<typeof mod.email.sendSupplierEmail>[0]) => {
        const body = mod.email.buildSupplierEmailBody(e, config);
        if (nextError) {
          const err = nextError;
          nextError = null;
          throw err;
        }
        await new Promise((r) => setTimeout(r, 5)); // let concurrent callers overlap
        sent.push({ supplierId: e.supplier.id, to: body.to, subject: body.subject, text: e.text, key: e.idempotencyKey });
        return { mode, to: body.to, subject: body.subject, messageId: `msg_${sent.length}` };
      },
    };
    return { mailer, sent, fail: (err: Error) => void (nextError = err) };
  }
  let mail: ReturnType<typeof fakeMailer>;

  const at = (hours: number) => new Date(CREATED.getTime() + hours * HOUR);
  const created = (p = payload(), t = at(0), m = mail) => mod.service.processOrderCreated(mod.db, p, t, BASE, m.mailer, t);
  const paid = (p = payload({ financial_status: "paid" }), t = at(48), m = mail) => mod.service.processOrderPaid(mod.db, p, t, BASE, m.mailer, t);
  const supplierEmailRows = () => mod.db.select().from(mod.schema.supplierEmails);
  const openAlertKeys = async () => (await mod.alerts.listOpenAlerts(mod.db)).map((a) => [a.key, a.severity]).sort();
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
    assert.equal(first.email?.subject, "Order #1322 placed: TEST supplier email for Modern Flames sent to you only (card not charged yet)");
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
      process: (p: Parameters<typeof mod.service.processOrderCreated>[1], t: Date) =>
        mod.service.processOrderCreated(mod.db, p, t, BASE, mail.mailer, t),
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
    assert.deepEqual(sent, ["Order #1322 placed: TEST supplier email for Modern Flames sent to you only (card not charged yet)"]);
    assert.equal(mail.sent.length, 1); // one test-mode supplier email, none on the retry
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
    assert.equal(first.email?.subject, "Order #1322 placed: TEST supplier email for Modern Flames sent to you only (card already charged)");
    assert.equal(mail.sent.length, 1);
    const late = await created();
    assert.equal(late.email, null);
    assert.equal(mail.sent.length, 1); // the late create finds the email already sent
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
    assert.match(result.email!.text, /Unmatched vendor Faber on order #1322/);
    assert.match(result.email!.text, /Touchstone: Place order #1322 in the Touchstone dealer portal\./);
    assert.match(result.email!.text, /Modern Flames: TEST MODE/);
    assert.deepEqual(mail.sent.map((m) => m.supplierId), ["modern_flames"]);

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

  // ---- automatic supplier emails --------------------------------------

  test("live: one email to the supplier's address; order marked sent; logged in supplier_emails", async () => {
    mail = fakeMailer("live");
    const result = await created();
    assert.equal(result.email?.subject, "Order #1322 placed: emailed to Modern Flames (card not charged yet)");
    assert.match(result.email!.text, /Modern Flames: supplier email sent to orders@modernflames.com/);
    assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]), [[["orders@modernflames.com"], "New Order [#1322] from Very Good Fireplaces"]]);
    assert.match(mail.sent[0]!.text, /^Hello,\n\nWe have a new order to place with you\./);

    const order = await oneOrder();
    assert.equal(order.status, "sent");
    assert.equal(order.sentAt?.toISOString(), at(0).toISOString());
    assert.ok((await mod.db.select().from(mod.schema.orderItems)).every((i) => i.sentAt !== null));
    const [row] = await supplierEmailRows();
    assert.deepEqual(
      [row!.supplierId, row!.mode, row!.status, row!.toAddresses, row!.resendMessageId, row!.sentAt?.toISOString()],
      ["modern_flames", "live", "sent", ["orders@modernflames.com"], "msg_1", at(0).toISOString()],
    );
    assert.deepEqual(await openAlertKeys(), []);
  });

  test("retry: replaying the same orders/create webhook never sends the supplier email again", async () => {
    mail = fakeMailer("live");
    await created();
    for (let i = 0; i < 3; i++) {
      const retry = await created(undefined, at(0.1 * (i + 1)));
      assert.equal(retry.body.reason, "duplicate");
      assert.equal(retry.email, null);
    }
    // ...nor does the hourly safety net.
    const check = await mod.service.runOrderCheck(mod.db, async () => {}, BASE, at(1), mail.mailer);
    assert.equal(check.supplierEmailsSent, 0);
    assert.equal(mail.sent.length, 1);
    assert.equal((await supplierEmailRows()).length, 1);
  });

  test("concurrent duplicate deliveries send exactly one supplier email", async () => {
    mail = fakeMailer("live");
    await Promise.all(Array.from({ length: 6 }, () => created()));
    assert.equal(mail.sent.length, 1);
    assert.equal((await allOrders()).length, 1);
    assert.equal((await oneOrder()).status, "sent");
  });

  test("a definite send failure is recorded and alerted, and the next retry sends it once with a new key", async () => {
    mail = fakeMailer("live");
    mail.fail(new mod.email.SupplierEmailNotSentError("Resend error (HTTP 422): invalid to"));
    const first = await created();
    assert.equal(first.email?.subject, "Order #1322 placed: needs attention (card not charged yet)");
    assert.match(first.email!.text, /Modern Flames: the supplier email FAILED \(Resend error \(HTTP 422\): invalid to\)/);
    assert.equal((await supplierEmailRows())[0]!.status, "failed");
    assert.equal((await oneOrder()).status, "draft_ready");
    assert.deepEqual(await openAlertKeys(), [["supplier_email_failed_1322", "urgent"]]);

    const retry = await created(undefined, at(0.2));
    assert.equal(retry.email?.subject, "Order #1322 supplier email update: emailed to Modern Flames");
    assert.deepEqual(mail.sent.map((m) => m.key), [`vgf-supplier-order/${(await oneOrder()).id}/modern_flames/2`]);
    assert.equal((await oneOrder()).status, "sent");
    assert.deepEqual(await openAlertKeys(), []);
    assert.equal((await created(undefined, at(0.3))).email, null);
    assert.equal(mail.sent.length, 1);
  });

  test("an uncertain failure (network) is not re-sent right away; after 10 minutes it's retried with the same key", async () => {
    mail = fakeMailer("live");
    mail.fail(new Error("fetch failed"));
    await created();
    const orderId = (await oneOrder()).id;
    assert.equal((await supplierEmailRows())[0]!.status, "sending");

    await created(undefined, at(0.05)); // 3 minutes later: still claimed
    assert.equal(mail.sent.length, 0);

    const check = await mod.service.runOrderCheck(mod.db, async () => {}, BASE, at(0.25), mail.mailer);
    assert.equal(check.supplierEmailsSent, 1);
    assert.deepEqual(mail.sent.map((m) => m.key), [`vgf-supplier-order/${orderId}/modern_flames/1`]);
  });

  test("test mode: goes to Brendan only, order stays unsent, and switching to live later doesn't re-send it", async () => {
    await created();
    assert.deepEqual(mail.sent.map((m) => [m.to, m.subject]), [
      [["brendan@example.com"], "[TEST - would go to orders@modernflames.com] New Order [#1322] from Very Good Fireplaces"],
    ]);
    const order = await oneOrder();
    assert.equal(order.status, "draft_ready");
    assert.equal(order.sentAt, null);
    assert.equal((await supplierEmailRows())[0]!.mode, "test");

    const live = fakeMailer("live");
    await created(undefined, at(0.5), live);
    await mod.service.runOrderCheck(mod.db, async () => {}, BASE, at(1), live.mailer);
    assert.equal(live.sent.length, 0);
  });

  test("Touchstone (portal): no supplier email, a warning alert and the portal line for Brendan", async () => {
    mail = fakeMailer("live");
    const result = await created(payload({ line_items: [{ sku: "80044", name: "Sideline Elite 100", quantity: 1, vendor: "Touchstone", requires_shipping: true }] }));
    assert.equal(mail.sent.length, 0);
    assert.match(result.email!.text, /Touchstone: Place order #1322 in the Touchstone dealer portal\./);
    const [alert] = await mod.alerts.listOpenAlerts(mod.db);
    assert.deepEqual([alert!.key, alert!.severity, alert!.message], ["order_attention_1322", "warning", "Place order #1322 in the Touchstone dealer portal."]);

    // Brendan places it in the portal and marks it sent: the alert resolves.
    await mod.service.markSupplierSent(mod.db, (await oneOrder()).id, "touchstone", at(2));
    assert.deepEqual(await openAlertKeys(), []);
  });

  test("unmatched vendor and inactive Evolution Fires: alert only, never emailed", async () => {
    mail = fakeMailer("live");
    const result = await created(
      payload({
        line_items: [
          { sku: "EVO-1", name: "Evolution 50", quantity: 1, vendor: "Evolution Fires", requires_shipping: true },
          { sku: "FAB-1", name: "Faber thing", quantity: 1, vendor: "Faber", requires_shipping: true },
        ],
      }),
    );
    assert.equal(mail.sent.length, 0);
    assert.equal((await supplierEmailRows()).length, 0);
    assert.ok((await mod.db.select().from(mod.schema.orderItems)).every((i) => i.supplierId === null));
    assert.equal((await oneOrder()).status, "needs_attention");
    const [alert] = await mod.alerts.listOpenAlerts(mod.db);
    assert.match(alert!.message, /Unmatched vendor Evolution Fires on order #1322 \(Evolution Fires is no longer an active supplier/);
    assert.match(alert!.message, /Unmatched vendor Faber on order #1322\./);
    assert.match(result.email!.text, /Unmatched vendor Faber/);
  });

  test("Litedeer's first live order is sent and flagged as the first order to that address", async () => {
    mail = fakeMailer("live");
    const result = await created(payload({ line_items: [{ sku: "LD-1", name: "WarmCastle", quantity: 1, vendor: "Litedeer Homes", requires_shipping: true }] }));
    assert.deepEqual(mail.sent.map((m) => m.to), [["litedeerhomes@gmail.com"]]);
    assert.match(result.email!.text, /This is the first order to litedeerhomes@gmail.com/);
    const [litedeer] = await mod.db.select().from(mod.schema.suppliers).where(mod.sql`id = 'litedeer'`);
    assert.equal(litedeer!.orderedBefore, true);
  });

  test("mixed suppliers: one email each; the order is sent only once the portal part is done too", async () => {
    mail = fakeMailer("live");
    const result = await created(
      payload({
        line_items: [
          { sku: "LPM-12016", name: "Landscape Pro", quantity: 1, vendor: "Modern Flames", requires_shipping: true },
          { sku: "E-FX-60", name: "E-FX 60", quantity: 1, vendor: "Sustainable Hearth", requires_shipping: true },
          { sku: "LPM-TRIM", name: "Landscape trim", quantity: 2, vendor: "MODERN FLAMES", requires_shipping: true },
          { sku: "80044", name: "Sideline Elite 100", quantity: 1, vendor: "Touchstone", requires_shipping: true },
        ],
      }),
    );
    assert.deepEqual(mail.sent.map((m) => [m.supplierId, m.to[0]]).sort(), [
      ["modern_flames", "orders@modernflames.com"],
      ["sustainable_hearth", "inside.sales@sustainablehearth.com"],
    ]);
    const mf = mail.sent.find((m) => m.supplierId === "modern_flames")!;
    assert.match(mf.text, /- Qty 1: Landscape Pro \(SKU LPM-12016\)\n- Qty 2: Landscape trim \(SKU LPM-TRIM\)/);
    const sh = mail.sent.find((m) => m.supplierId === "sustainable_hearth")!;
    assert.match(sh.text, /^Hi Holly,/);
    assert.match(sh.text, /Please ship to the address below\. Include shipping on the invoice\./);
    assert.equal(result.email?.subject, "Order #1322 placed: needs attention (card not charged yet)");

    let order = await oneOrder();
    assert.equal(order.status, "draft_ready");
    assert.equal(order.sentAt, null);
    order = await mod.service.markSupplierSent(mod.db, order.id, "touchstone", at(3));
    assert.equal(order.status, "sent");
  });

  test("orders stored before this feature, and cancelled orders, are never emailed", async () => {
    mail = fakeMailer("live");
    await mod.service.processOrderCancelled(mod.db, payload({ cancelled_at: at(0).toISOString() }), at(0), BASE);
    await created();
    assert.equal(mail.sent.length, 0);

    await mod.db.execute(mod.sql`truncate table supplier_emails, order_items, orders, alerts`);
    const quiet = fakeMailer("test");
    await created(undefined, at(0), quiet);
    await mod.db.execute(mod.sql`update orders set auto_supplier_email = false`);
    await mod.db.execute(mod.sql`delete from supplier_emails`);
    await created(undefined, at(0.5));
    await mod.service.runOrderCheck(mod.db, async () => {}, BASE, at(1), mail.mailer);
    assert.equal(mail.sent.length, 0);
  });

  test("the alert emails are marked emailed once Brendan's notification goes out", async () => {
    mail = fakeMailer("live");
    const result = await created(payload({ line_items: [{ sku: "80044", name: "Sideline", quantity: 1, vendor: "Touchstone", requires_shipping: true }] }));
    assert.equal((await mod.alerts.listOpenAlerts(mod.db))[0]!.emailedAt, null);
    await result.onNotified?.();
    assert.ok((await mod.alerts.listOpenAlerts(mod.db))[0]!.emailedAt);
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
