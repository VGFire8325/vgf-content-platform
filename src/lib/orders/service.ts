import { and, eq, gt, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { alerts, orderItems, orders, supplierEmails, suppliers } from "@/db/schema";
import { markAlertEmailed, openAlert, resolveAlert, type AlertSeverity } from "@/lib/alerts";
import {
  sendSupplierEmail,
  SupplierEmailNotSentError,
  supplierEmailMode,
  type NotificationEmail,
  type SendNotification,
  type SendSupplierEmail,
  type SupplierEmailMode,
} from "@/lib/email";
import { parseOrderPayload, sanitizeOrderPayload, type ParsedOrder, type ShopifyOrderPayload } from "./shopify-webhook";
import {
  deriveOrderStatus,
  isAwaitingStockConfirmation,
  isOverdueUnsent,
  STOCK_CONFIRMATION_ALERT_AFTER_MS,
  stockConfirmationAlertKey,
  UNSENT_ALERT_AFTER_MS,
  unsentAlertKey,
} from "./status";
import {
  buildSupplierOrderEmail,
  needsAttention,
  outcomeLine,
  planSupplierEmails,
  portalAlertLine,
  unmatchedAlertLine,
  type DispatchOutcome,
} from "./supplier-email";
import { isFulfillableLineItem, matchActiveSupplier, type Supplier } from "./suppliers";

type Db = typeof DbClient;
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

// Shopify financial_status values that mean the card has been charged.
const CHARGED_FINANCIAL_STATUSES = ["paid", "partially_paid"];

// What a webhook route sends back to Shopify, plus at most one email to
// Brendan (sent by the route after the transaction commits). onNotified
// runs once that email has gone, to mark the alerts it covered as emailed.
export interface WebhookOutcome {
  body: Record<string, unknown>;
  email: NotificationEmail | null;
  onNotified?: () => Promise<void>;
}

// How supplier order emails are sent (see dispatchSupplierEmails).
export interface SupplierMailer {
  send: SendSupplierEmail;
  mode: SupplierEmailMode;
  replyTo: string; // shown in the email's sign-off
}

// The real mailer: Resend, from the Very Good Fireplaces address, in
// whatever mode SUPPLIER_EMAIL_MODE says (test unless it's "live").
export function supplierMailerFromEnv(): SupplierMailer {
  return { send: sendSupplierEmail, mode: supplierEmailMode(), replyTo: process.env.SUPPLIER_EMAIL_REPLY_TO?.trim() ?? "" };
}

type EnsureResult = { kind: "nothing_to_fulfill" } | { kind: "existing"; order: OrderRow } | { kind: "created"; order: OrderRow };

// Stores an order exactly once, whichever webhook (create, paid or
// cancelled) happens to arrive first: every Shopify order webhook carries
// the full order, so any of them can create the row. The unique
// shopify_order_id plus ON CONFLICT DO NOTHING is the idempotency guard
// against Shopify retries and racing deliveries.
//
// Orders with nothing to send to a manufacturer (Shopify sends Extend
// protection plans as their own orders, e.g. #1301) aren't stored at all:
// they'd otherwise sit unsent and trip the 24-hour alert forever.
async function ensureOrder(tx: DbOrTx, payload: ShopifyOrderPayload, parsed: ParsedOrder, eventAt: Date): Promise<EnsureResult> {
  const fulfillable = parsed.lineItems.filter((li) => isFulfillableLineItem({ vendor: li.vendor, requires_shipping: li.requiresShipping }));
  if (fulfillable.length === 0) return { kind: "nothing_to_fulfill" };

  const charged = parsed.financialStatus !== null && CHARGED_FINANCIAL_STATUSES.includes(parsed.financialStatus);
  const [inserted] = await tx
    .insert(orders)
    .values({
      shopifyOrderId: parsed.shopifyOrderId,
      orderNumber: parsed.orderNumber,
      createdAtShopify: parsed.createdAt ?? eventAt,
      customerName: parsed.customerName,
      shipCompany: parsed.shipCompany,
      shipAddress1: parsed.shipAddress1,
      shipAddress2: parsed.shipAddress2,
      shipCity: parsed.shipCity,
      shipProvince: parsed.shipProvince,
      shipZip: parsed.shipZip,
      shipCountry: parsed.shipCountry,
      phone: parsed.phone,
      email: parsed.email,
      status: "new",
      financialStatus: parsed.financialStatus,
      charged,
      rawPayload: sanitizeOrderPayload(payload),
      autoSupplierEmail: true,
    })
    .onConflictDoNothing({ target: orders.shopifyOrderId })
    .returning();

  if (!inserted) {
    const [existing] = await tx.select().from(orders).where(eq(orders.shopifyOrderId, parsed.shopifyOrderId));
    if (!existing) throw new Error(`Order ${parsed.shopifyOrderId} conflicted on insert but can't be read back`);
    return { kind: "existing", order: existing };
  }

  const supplierList = await tx.select().from(suppliers);
  const itemValues = fulfillable.map((li) => ({
    orderId: inserted.id,
    sku: li.sku,
    productName: li.productName,
    quantity: li.quantity,
    vendor: li.vendor,
    supplierId: matchActiveSupplier(li.vendor, supplierList)?.id ?? null,
  }));
  await tx.insert(orderItems).values(itemValues);

  return { kind: "created", order: await refreshOrder(tx, inserted.id, eventAt) };
}

export function ordersPageUrl(baseUrl: string, orderNumber: string): string {
  return `${baseUrl.replace(/\/$/, "")}/review/orders#order-${orderNumber}`;
}

function chargeNote(order: OrderRow): string {
  return order.charged ? "(card already charged)" : "(card not charged yet)";
}

// Brendan's email about an order's supplier emails: one per new order
// ("placed"), and one more only if a later retry actually did something
// ("update"). Says, per supplier, whether the email was sent (or went to
// him only, in test mode) and what still needs him.
export function orderPlacedEmail(order: OrderRow, outcomes: DispatchOutcome[], baseUrl: string, kind: "placed" | "update" = "placed"): NotificationEmail {
  const n = order.orderNumber;
  const link = ordersPageUrl(baseUrl, n);
  const attention = outcomes.some(needsAttention);
  const sent = outcomes.filter((o): o is Extract<DispatchOutcome, { kind: "sent" }> => o.kind === "sent");
  const names = (list: { supplier: Supplier }[]) => list.map((o) => o.supplier.name).join(" and ");

  let summary: string;
  if (attention) summary = "needs attention";
  else if (sent.length > 0 && sent.every((o) => o.mode === "live")) summary = `emailed to ${names(sent)}`;
  else if (sent.length > 0) summary = `TEST supplier email for ${names(sent)} sent to you only`;
  else if (outcomes.length > 0) summary = "supplier email already handled";
  else summary = "nothing to send automatically";
  const subject = kind === "placed" ? `Order #${n} placed: ${summary} ${chargeNote(order)}` : `Order #${n} supplier email update: ${summary}`;

  const opening = kind === "placed" ? `Order #${n} (${order.customerName}) was placed. ${chargeNote(order)}` : `Order #${n} (${order.customerName}):`;
  const lines = outcomes.length > 0 ? outcomes.map((o) => `- ${outcomeLine(o, n)}`) : ["- No supplier email was sent automatically. Handle it from the orders page."];
  return { subject, text: `${opening}\n\n${lines.join("\n")}\n\nOrder page:\n${link}` };
}

export function orderAttentionAlertKey(orderNumber: string): string {
  return `order_attention_${orderNumber}`;
}

export function supplierEmailFailedAlertKey(orderNumber: string): string {
  return `supplier_email_failed_${orderNumber}`;
}

// Records what needs Brendan in the shared alerts table: a portal order or
// an unmatched / inactive-supplier vendor (warning), and a failed supplier
// email (urgent). One open alert per key, so retries don't pile up rows.
// Returns the ids of alerts not yet emailed, to mark once Brendan's email
// goes out. Both keys resolve once every item is sent or the order is
// cancelled (see refreshOrder).
async function recordSupplierAlerts(db: Db, order: OrderRow, outcomes: DispatchOutcome[], now: Date): Promise<string[]> {
  const ids: string[] = [];
  const attention = outcomes.flatMap((o) =>
    o.kind === "portal"
      ? [o.supplier.method === "portal" ? portalAlertLine(o.supplier.name, order.orderNumber) : outcomeLine(o, order.orderNumber)]
      : o.kind === "unmatched"
        ? [unmatchedAlertLine(o.vendor, order.orderNumber, o.inactiveSupplier)]
        : [],
  );
  if (attention.length > 0) {
    const { alert } = await openAlert(db, { key: orderAttentionAlertKey(order.orderNumber), severity: "warning", message: attention.join(" ") }, now);
    if (!alert.emailedAt) ids.push(alert.id);
  }
  const failed = outcomes.filter((o) => o.kind === "failed");
  if (failed.length > 0) {
    const message = failed.map((o) => outcomeLine(o, order.orderNumber)).join(" ");
    const { alert } = await openAlert(db, { key: supplierEmailFailedAlertKey(order.orderNumber), severity: "urgent", message }, now);
    if (!alert.emailedAt) ids.push(alert.id);
  } else if (outcomes.some((o) => o.kind === "sent") && !(await hasUnsentClaims(db, order.id))) {
    await resolveAlert(db, supplierEmailFailedAlertKey(order.orderNumber), now);
  }
  return ids;
}

async function hasUnsentClaims(db: Db, orderId: string): Promise<boolean> {
  const rows = await db
    .select({ id: supplierEmails.id })
    .from(supplierEmails)
    .where(and(eq(supplierEmails.orderId, orderId), or(eq(supplierEmails.status, "failed"), eq(supplierEmails.status, "sending"))));
  return rows.length > 0;
}

// A claim stuck at "sending" this long (the request died mid-send) may be
// retried, but only while Resend still remembers the idempotency key
// (24 hours; 23 here for margin), so a retry can't deliver it twice.
export const SUPPLIER_CLAIM_STALE_MS = 10 * 60 * 1000;
export const SUPPLIER_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
// A supplier email Resend definitely rejected is retried at most this many
// times in total (webhook retries plus the hourly safety net).
export const SUPPLIER_EMAIL_MAX_ATTEMPTS = 5;

// The atomic claim. Inserting the (order, supplier) row succeeds for
// exactly one caller, however many webhook retries, duplicate deliveries
// or concurrent requests race for it; the unique index makes the rest
// conflict. A conflicting row is re-claimed (also atomically) only if its
// last attempt definitely failed, or it's a stale "sending" claim still
// inside the idempotency window. Returns null when not claimed.
export async function claimSupplierEmail(
  db: DbOrTx,
  input: { orderId: string; supplierId: string; supplierAddress: string; subject: string; mode: SupplierEmailMode },
  now: Date,
): Promise<{ id: string; attempts: number } | null> {
  const staleBefore = new Date(now.getTime() - SUPPLIER_CLAIM_STALE_MS);
  const windowStart = new Date(now.getTime() - SUPPLIER_IDEMPOTENCY_WINDOW_MS);
  const wasFailed = sql`${supplierEmails.status} = 'failed'`;
  const [row] = await db
    .insert(supplierEmails)
    .values({ ...input, status: "sending", attempts: 1, firstClaimedAt: now, claimedAt: now })
    .onConflictDoUpdate({
      target: [supplierEmails.orderId, supplierEmails.supplierId],
      set: {
        status: "sending",
        mode: input.mode,
        subject: input.subject,
        supplierAddress: input.supplierAddress,
        claimedAt: now,
        error: null,
        // A new attempt after a definite failure gets a new idempotency key;
        // re-claiming a stale "sending" row keeps the old one.
        attempts: sql`case when ${wasFailed} then ${supplierEmails.attempts} + 1 else ${supplierEmails.attempts} end`,
        firstClaimedAt: sql`case when ${wasFailed} then ${now.toISOString()}::timestamptz else ${supplierEmails.firstClaimedAt} end`,
      },
      setWhere: sql`(${wasFailed} and ${supplierEmails.attempts} < ${SUPPLIER_EMAIL_MAX_ATTEMPTS})
        or (${supplierEmails.status} = 'sending' and ${supplierEmails.mode} = ${input.mode}
            and ${supplierEmails.claimedAt} < ${staleBefore.toISOString()}::timestamptz
            and ${supplierEmails.firstClaimedAt} > ${windowStart.toISOString()}::timestamptz)`,
    })
    .returning({ id: supplierEmails.id, attempts: supplierEmails.attempts });
  return row ?? null;
}

export function supplierEmailIdempotencyKey(orderId: string, supplierId: string, attempt: number): string {
  return `vgf-supplier-order/${orderId}/${supplierId}/${attempt}`;
}

export interface DispatchResult {
  order: OrderRow | null;
  outcomes: DispatchOutcome[];
  // True if this run sent, or tried to send, at least one email.
  acted: boolean;
}

// Sends one email per supplier for an order's unsent items, at most once
// each (claimSupplierEmail), and reports portal / unmatched / inactive
// groups instead of emailing them. Only for orders stored by this code
// (auto_supplier_email) and never for a cancelled order. Safe to call any
// number of times: the webhook, its retries and the hourly check all do.
//
// A live send marks that supplier's items sent (and the order `sent` once
// every item is). A test-mode send goes to Brendan only, so it changes
// nothing on the order: the supplier hasn't been told.
export async function dispatchSupplierEmails(db: Db, orderId: string, mailer: SupplierMailer, now: Date = new Date()): Promise<DispatchResult> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || !order.autoSupplierEmail || order.cancelledAt) return { order: order ?? null, outcomes: [], acted: false };

  const supplierList = await db.select().from(suppliers);
  const plans = planSupplierEmails(await loadItems(db, orderId), supplierList);
  const outcomes: DispatchOutcome[] = [];
  let acted = false;

  for (const plan of plans) {
    if (plan.kind === "portal") {
      outcomes.push({ kind: "portal", supplier: plan.supplier });
      continue;
    }
    if (plan.kind === "unmatched") {
      outcomes.push({ kind: "unmatched", vendor: plan.vendor, inactiveSupplier: plan.inactiveSupplier });
      continue;
    }
    const { supplier } = plan;
    const content = buildSupplierOrderEmail(order, plan.items, supplier, mailer.replyTo);
    const claim = await claimSupplierEmail(
      db,
      { orderId, supplierId: supplier.id, supplierAddress: supplier.orderEmail!, subject: content.subject, mode: mailer.mode },
      now,
    );
    if (!claim) {
      const [existing] = await db
        .select()
        .from(supplierEmails)
        .where(and(eq(supplierEmails.orderId, orderId), eq(supplierEmails.supplierId, supplier.id)));
      outcomes.push({ kind: "already_handled", supplier, status: existing?.status ?? "sending", mode: existing?.mode ?? mailer.mode });
      continue;
    }

    acted = true;
    try {
      const result = await mailer.send({
        supplier,
        subject: content.subject,
        text: content.text,
        idempotencyKey: supplierEmailIdempotencyKey(orderId, supplier.id, claim.attempts),
      });
      const firstOrder = result.mode === "live" && !supplier.orderedBefore;
      await db.transaction(async (tx) => {
        await tx
          .update(supplierEmails)
          .set({ status: "sent", mode: result.mode, toAddresses: result.to, subject: result.subject, resendMessageId: result.messageId, sentAt: now, error: null })
          .where(eq(supplierEmails.id, claim.id));
        if (result.mode === "live") {
          await tx
            .update(orderItems)
            .set({ sentAt: now })
            .where(and(eq(orderItems.orderId, orderId), eq(orderItems.supplierId, supplier.id), isNull(orderItems.sentAt)));
          if (!supplier.orderedBefore) await tx.update(suppliers).set({ orderedBefore: true }).where(eq(suppliers.id, supplier.id));
          await refreshOrder(tx, orderId, now);
        }
      });
      outcomes.push({ kind: "sent", supplier, mode: result.mode, to: result.to, firstOrder });
    } catch (err) {
      const definite = err instanceof SupplierEmailNotSentError;
      const message = err instanceof Error ? err.message : String(err);
      // A definite failure releases the claim for a retry with a new key;
      // an uncertain one stays "sending" and is only re-claimed (with the
      // same key) once stale.
      await db
        .update(supplierEmails)
        .set({ status: definite ? "failed" : "sending", error: message.slice(0, 500) })
        .where(eq(supplierEmails.id, claim.id));
      outcomes.push({ kind: "failed", supplier, error: message.slice(0, 200), mayHaveSent: !definite });
    }
  }

  const [latest] = await db.select().from(orders).where(eq(orders.id, orderId));
  return { order: latest ?? order, outcomes, acted };
}

// Dispatch, record alerts, and build Brendan's email for it.
async function dispatchAndReport(
  db: Db,
  orderId: string,
  mailer: SupplierMailer,
  baseUrl: string,
  kind: "placed" | "update",
  now: Date,
): Promise<{ result: DispatchResult; email: NotificationEmail | null; onNotified?: () => Promise<void> }> {
  const result = await dispatchSupplierEmails(db, orderId, mailer, now);
  if (!result.order) return { result, email: null };
  const alertIds = await recordSupplierAlerts(db, result.order, result.outcomes, now);
  const email = orderPlacedEmail(result.order, result.outcomes, baseUrl, kind);
  return {
    result,
    email,
    onNotified: async () => {
      for (const id of alertIds) await markAlertEmailed(db, id, now);
    },
  };
}

function outcomeSummary(outcomes: DispatchOutcome[]): Record<string, string> {
  return Object.fromEntries(
    outcomes.map((o) => [o.kind === "unmatched" ? `vendor:${o.vendor}` : o.supplier.id, o.kind === "sent" ? `sent_${o.mode}` : o.kind]),
  );
}

function cancelledEmail(order: OrderRow, sentSupplierNames: string[], baseUrl: string): NotificationEmail {
  const n = order.orderNumber;
  const sentLine =
    sentSupplierNames.length > 0
      ? `The New Order email already went to ${sentSupplierNames.join(" and ")}. Let them know it's cancelled.`
      : "The New Order email hadn't been marked sent to any manufacturer, so there's nothing to tell them.";
  const chargeLine = order.charged ? "\n\nThe card had been charged; check the refund in Shopify." : "";
  return {
    subject: `Order #${n} cancelled`,
    text: `Order #${n} (${order.customerName}) was cancelled in Shopify.\n\n${sentLine}${chargeLine}\n\n${ordersPageUrl(baseUrl, n)}`,
  };
}

// orders/create: the main trigger. Stores the order, emails each supplier
// (dispatchSupplierEmails) and tells Brendan what happened. A retry (or a
// create arriving after paid/cancelled already stored the order) re-runs
// the dispatch, which is a no-op unless an earlier send didn't finish; it
// only emails Brendan again if it actually sent or tried something.
export async function processOrderCreated(
  db: Db,
  payload: ShopifyOrderPayload,
  eventAt: Date,
  baseUrl: string,
  mailer: SupplierMailer,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const parsed = parseOrderPayload(payload);
  const stored = await db.transaction((tx) => ensureOrder(tx, payload, parsed, eventAt));
  if (stored.kind === "nothing_to_fulfill") return { body: { created: false, reason: "nothing_to_fulfill" }, email: null };

  const isNew = stored.kind === "created";
  const { result, email, onNotified } = await dispatchAndReport(db, stored.order.id, mailer, baseUrl, isNew ? "placed" : "update", now);
  const order = result.order ?? stored.order;
  const supplierEmails = outcomeSummary(result.outcomes);
  if (!isNew) {
    const body = { created: false, reason: "duplicate", shopifyOrderId: parsed.shopifyOrderId };
    return result.acted ? { body: { ...body, supplierEmails }, email, onNotified } : { body, email: null };
  }
  return { body: { created: true, orderNumber: order.orderNumber, status: order.status, supplierEmails }, email, onNotified };
}

// orders/paid: Brendan charged the card. Records paid_at/financial_status
// and the charged flag. If paid arrives before create, it stores the order
// itself (and sends the "placed" email, since create will then be a no-op).
export async function processOrderPaid(
  db: Db,
  payload: ShopifyOrderPayload,
  eventAt: Date,
  baseUrl: string,
  mailer: SupplierMailer,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const parsed = parseOrderPayload(payload);
  const stored = await db.transaction(async (tx) => {
    const result = await ensureOrder(tx, payload, parsed, eventAt);
    if (result.kind === "nothing_to_fulfill") return { body: { recorded: false, reason: "nothing_to_fulfill" }, email: null } as WebhookOutcome;

    const current = result.order;
    await tx
      .update(orders)
      .set({
        paidAt: current.paidAt ?? eventAt,
        financialStatus: parsed.financialStatus ?? "paid",
        charged: true,
      })
      .where(eq(orders.id, current.id));
    const order = await refreshOrder(tx, current.id, eventAt);

    return { created: result.kind === "created", order };
  });
  if (!("order" in stored)) return stored;

  const body: Record<string, unknown> = { recorded: true, orderCreated: stored.created, orderNumber: stored.order.orderNumber, status: stored.order.status };
  if (!stored.created) return { body, email: null };
  // Paid arrived before create: this stored the order, so it also sends the
  // supplier emails (the late create will find them already claimed).
  const { result, email, onNotified } = await dispatchAndReport(db, stored.order.id, mailer, baseUrl, "placed", now);
  return { body: { ...body, status: result.order?.status ?? stored.order.status, supplierEmails: outcomeSummary(result.outcomes) }, email, onNotified };
}

// orders/cancelled: mark cancelled, resolve the order's alerts, and tell
// Brendan whether the New Order email had already gone out.
export async function processOrderCancelled(db: Db, payload: ShopifyOrderPayload, eventAt: Date, baseUrl: string): Promise<WebhookOutcome> {
  const parsed = parseOrderPayload(payload);
  return db.transaction(async (tx) => {
    const result = await ensureOrder(tx, payload, parsed, eventAt);
    if (result.kind === "nothing_to_fulfill") return { body: { recorded: false, reason: "nothing_to_fulfill" }, email: null };

    const cancelledAt = payload.cancelled_at ? new Date(payload.cancelled_at) : eventAt;
    const transitioned = await tx
      .update(orders)
      .set({ cancelledAt: Number.isNaN(cancelledAt.getTime()) ? eventAt : cancelledAt })
      .where(and(eq(orders.id, result.order.id), isNull(orders.cancelledAt)))
      .returning({ id: orders.id });
    const order = await refreshOrder(tx, result.order.id, eventAt);

    // No email for a retry, or for an order we first heard about through
    // its cancellation (Brendan never got a "placed" email for it).
    let email: NotificationEmail | null = null;
    if (transitioned.length > 0 && result.kind === "existing") {
      const items = await loadItems(tx, order.id);
      const supplierList = await tx.select().from(suppliers);
      const sentNames = [...new Set(items.filter((i) => i.sentAt !== null).map((i) => i.supplierId))].map(
        (id) => supplierList.find((s) => s.id === id)?.name ?? "the manufacturer (handled manually)",
      );
      email = cancelledEmail(order, sentNames, baseUrl);
    }
    return { body: { recorded: true, cancelled: true, orderNumber: order.orderNumber }, email };
  });
}

async function loadItems(db: DbOrTx, orderId: string): Promise<OrderItemRow[]> {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

// Recomputes status from items + order fields, keeps orders.sent_at in
// step, and resolves whichever alerts no longer apply.
async function refreshOrder(db: DbOrTx, orderId: string, now: Date): Promise<OrderRow> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new Error(`Order ${orderId} not found`);
  const items = await loadItems(db, orderId);
  const status = deriveOrderStatus(items, order);
  const allSent = items.length > 0 && items.every((i) => i.sentAt !== null);
  const sentAt = allSent ? (order.sentAt ?? now) : null;
  const supplierIds = [...new Set(items.map((i) => i.supplierId).filter((id): id is string => id !== null))];
  const [updated] = await db
    .update(orders)
    .set({ status, sentAt, supplierId: supplierIds.length === 1 ? supplierIds[0] : null })
    .where(eq(orders.id, orderId))
    .returning();
  if (allSent || order.cancelledAt) {
    await resolveAlert(db, unsentAlertKey(order.orderNumber), now);
    await resolveAlert(db, orderAttentionAlertKey(order.orderNumber), now);
    await resolveAlert(db, supplierEmailFailedAlertKey(order.orderNumber), now);
  }
  if (order.stockConfirmedAt || order.cancelledAt) await resolveAlert(db, stockConfirmationAlertKey(order.orderNumber), now);
  return updated!;
}

// Mark one supplier's draft as sent (supplierId null = the unmatched items,
// handled by Brendan outside this tool). The order becomes `sent` once
// every item is, and the 24-hour alert resolves at that moment.
export async function markSupplierSent(db: Db, orderId: string, supplierId: string | null, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    await tx
      .update(orderItems)
      .set({ sentAt: now })
      .where(
        and(
          eq(orderItems.orderId, orderId),
          supplierId === null ? isNull(orderItems.supplierId) : eq(orderItems.supplierId, supplierId),
          isNull(orderItems.sentAt),
        ),
      );
    return refreshOrder(tx, orderId, now);
  });
}

// Undo for a mis-click on Mark Sent.
export async function markSupplierUnsent(db: Db, orderId: string, supplierId: string | null, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    await tx
      .update(orderItems)
      .set({ sentAt: null })
      .where(and(eq(orderItems.orderId, orderId), supplierId === null ? isNull(orderItems.supplierId) : eq(orderItems.supplierId, supplierId)));
    return refreshOrder(tx, orderId, now);
  });
}

export async function markStockConfirmed(db: Db, orderId: string, confirmed: boolean, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    await tx.update(orders).set({ stockConfirmedAt: confirmed ? now : null }).where(eq(orders.id, orderId));
    return refreshOrder(tx, orderId, now);
  });
}

export async function setTrackingNumber(db: Db, orderId: string, tracking: string, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    await tx.update(orders).set({ trackingNumber: tracking.trim() || null }).where(eq(orders.id, orderId));
    return refreshOrder(tx, orderId, now);
  });
}

export async function setFreight(db: Db, orderId: string, freightSeparate: boolean, freightNote: string | null): Promise<void> {
  await db.update(orders).set({ freightSeparate, freightNote: freightNote?.trim() || null }).where(eq(orders.id, orderId));
}

export async function setManufacturerReply(db: Db, orderId: string, reply: string | null, needsApproval: boolean): Promise<void> {
  await db.update(orders).set({ manufacturerReply: reply?.trim() || null, needsApproval }).where(eq(orders.id, orderId));
}

// For an item whose vendor didn't match: Brendan picks the supplier.
export async function assignItemSupplier(db: Db, itemId: string, supplierId: string, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    const [item] = await tx.update(orderItems).set({ supplierId }).where(eq(orderItems.id, itemId)).returning();
    if (!item) throw new Error(`Order item ${itemId} not found`);
    return refreshOrder(tx, item.orderId, now);
  });
}

export interface OrderCheckResult {
  supplierEmailsSent: number;
  supplierEmailFailures: number;
  unsentOverdue: number;
  awaitingStockConfirmation: number;
  alertsOpened: number;
  emailsSent: number;
  emailErrors: string[];
  resolved: number;
}

interface CheckFinding {
  order: OrderRow;
  key: string;
  severity: AlertSeverity;
  message: string;
  subject: string;
}

function hoursSince(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 3_600_000);
}

// The hourly check (see /api/cron/order-check). Two conditions:
//   - urgent: placed > UNSENT_ALERT_AFTER_MS ago, New Order email not sent
//   - normal: sent > STOCK_CONFIRMATION_ALERT_AFTER_MS ago, stock not confirmed
// Each opens (or refreshes) one alert per order and emails Brendan once
// per alert; a failed email leaves emailed_at null so the next run retries.
// Then any open order alert whose condition no longer holds is resolved
// (covers changes made outside the normal buttons).
//
// With a mailer, it first acts as the safety net for automatic supplier
// emails: any recent order whose supplier email didn't finish (the webhook
// request died, or Resend failed) is re-dispatched through the same
// idempotent dispatchSupplierEmails, so nothing is ever sent twice.
export async function runOrderCheck(
  db: Db,
  send: SendNotification,
  baseUrl: string,
  now: Date = new Date(),
  mailer?: SupplierMailer,
): Promise<OrderCheckResult> {
  const result: OrderCheckResult = {
    supplierEmailsSent: 0,
    supplierEmailFailures: 0,
    unsentOverdue: 0,
    awaitingStockConfirmation: 0,
    alertsOpened: 0,
    emailsSent: 0,
    emailErrors: [],
    resolved: 0,
  };
  if (mailer) await retrySupplierEmails(db, send, baseUrl, now, mailer, result);
  const unsentCutoff = new Date(now.getTime() - UNSENT_ALERT_AFTER_MS);
  const confirmCutoff = new Date(now.getTime() - STOCK_CONFIRMATION_ALERT_AFTER_MS);

  const candidates = await db
    .select()
    .from(orders)
    .where(
      and(
        isNull(orders.cancelledAt),
        or(
          and(isNull(orders.sentAt), lte(orders.createdAtShopify, unsentCutoff)),
          and(isNotNull(orders.sentAt), isNull(orders.stockConfirmedAt), lte(orders.sentAt, confirmCutoff)),
        ),
      ),
    );

  const findings: CheckFinding[] = [];
  for (const order of candidates) {
    if (isOverdueUnsent(order, now)) {
      result.unsentOverdue++;
      const message = `Order #${order.orderNumber} (${order.customerName}) was placed ${hoursSince(order.createdAtShopify, now)} hours ago and the New Order email hasn't been marked sent.`;
      findings.push({
        order,
        key: unsentAlertKey(order.orderNumber),
        severity: "urgent",
        message,
        subject: `[URGENT] Order #${order.orderNumber} not sent to the manufacturer after 24 hours`,
      });
    } else if (isAwaitingStockConfirmation(order, now)) {
      result.awaitingStockConfirmation++;
      const message = `Order #${order.orderNumber} (${order.customerName}) was sent to the manufacturer ${hoursSince(order.sentAt!, now)} hours ago and stock hasn't been confirmed. The customer is waiting and the card isn't charged.`;
      findings.push({
        order,
        key: stockConfirmationAlertKey(order.orderNumber),
        severity: "normal",
        message,
        subject: `Order #${order.orderNumber}: no stock confirmation 72 hours after sending`,
      });
    }
  }

  for (const f of findings) {
    const { alert, created } = await openAlert(db, { key: f.key, severity: f.severity, message: f.message }, now);
    if (created) result.alertsOpened++;
    if (alert.emailedAt) continue;
    try {
      await send({ subject: f.subject, text: `${f.message}\n\nOpen the order here:\n${ordersPageUrl(baseUrl, f.order.orderNumber)}` });
      await markAlertEmailed(db, alert.id, now);
      result.emailsSent++;
    } catch (err) {
      result.emailErrors.push(`#${f.order.orderNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const openOrderAlerts = await db
    .select()
    .from(alerts)
    .where(and(isNull(alerts.resolvedAt), or(like(alerts.key, "order_unsent_%"), like(alerts.key, "order_unconfirmed_%"))));
  if (openOrderAlerts.length > 0) {
    const stillOpen = new Set(findings.map((f) => f.key));
    for (const a of openOrderAlerts) {
      if (!stillOpen.has(a.key)) result.resolved += await resolveAlert(db, a.key, now);
    }
  }

  return result;
}

// Orders placed in the last SUPPLIER_IDEMPOTENCY_WINDOW_MS that aren't fully
// sent. Older ones are left to Brendan (the 24-hour alert covers them).
async function retrySupplierEmails(db: Db, send: SendNotification, baseUrl: string, now: Date, mailer: SupplierMailer, result: OrderCheckResult) {
  const since = new Date(now.getTime() - SUPPLIER_IDEMPOTENCY_WINDOW_MS);
  const pending = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(eq(orders.autoSupplierEmail, true), isNull(orders.cancelledAt), isNull(orders.sentAt), gt(orders.createdAtShopify, since)));
  for (const p of pending) {
    try {
      const { result: dispatched, email, onNotified } = await dispatchAndReport(db, p.id, mailer, baseUrl, "update", now);
      if (!dispatched.acted) continue;
      result.supplierEmailsSent += dispatched.outcomes.filter((o) => o.kind === "sent").length;
      result.supplierEmailFailures += dispatched.outcomes.filter((o) => o.kind === "failed").length;
      if (email) {
        await send(email);
        result.emailsSent++;
        await onNotified?.();
      }
    } catch (err) {
      result.emailErrors.push(`#${p.orderNumber} supplier email: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function loadSuppliers(db: Db): Promise<Supplier[]> {
  return db.select().from(suppliers);
}
