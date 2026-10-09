import { and, eq, inArray, isNotNull, isNull, like, lte, or } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { alerts, orderItems, orders, suppliers } from "@/db/schema";
import { markAlertEmailed, openAlert, resolveAlert, type AlertSeverity } from "@/lib/alerts";
import type { NotificationEmail, SendNotification } from "@/lib/email";
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
import { isFulfillableLineItem, matchSupplier, type Supplier } from "./suppliers";

type Db = typeof DbClient;
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

// Shopify financial_status values that mean the card has been charged.
const CHARGED_FINANCIAL_STATUSES = ["paid", "partially_paid"];

// What a webhook route sends back to Shopify, plus at most one email to
// Brendan (sent by the route after the transaction commits).
export interface WebhookOutcome {
  body: Record<string, unknown>;
  email: NotificationEmail | null;
}

type EnsureResult =
  | { kind: "nothing_to_fulfill" }
  | { kind: "existing"; order: OrderRow }
  | { kind: "created"; order: OrderRow; supplierNames: string[]; unmatchedVendors: string[] };

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
    supplierId: matchSupplier(li.vendor, supplierList)?.id ?? null,
  }));
  await tx.insert(orderItems).values(itemValues);

  const order = await refreshOrder(tx, inserted.id, eventAt);
  const supplierIds = [...new Set(itemValues.map((i) => i.supplierId).filter((id): id is string => id !== null))];
  return {
    kind: "created",
    order,
    supplierNames: supplierIds.map((id) => supplierList.find((s) => s.id === id)!.name),
    unmatchedVendors: [...new Set(itemValues.filter((i) => i.supplierId === null).map((i) => i.vendor ?? "(blank vendor)"))],
  };
}

export function ordersPageUrl(baseUrl: string, orderNumber: string): string {
  return `${baseUrl.replace(/\/$/, "")}/review/orders#order-${orderNumber}`;
}

function chargeNote(order: OrderRow): string {
  return order.charged ? "(card already charged)" : "(card not charged yet)";
}

// The one email Brendan gets per new order.
export function orderPlacedEmail(
  created: Extract<EnsureResult, { kind: "created" }>,
  baseUrl: string,
): NotificationEmail {
  const { order } = created;
  const n = order.orderNumber;
  const link = ordersPageUrl(baseUrl, n);
  if (order.status === "needs_attention") {
    const ready = created.supplierNames.length > 0 ? `\n\nDrafts are ready for: ${created.supplierNames.join(", ")}.` : "";
    return {
      subject: `Order #${n} placed: needs attention ${chargeNote(order)}`,
      text:
        `Order #${n} (${order.customerName}) was placed, but no supplier matches vendor ` +
        `${created.unmatchedVendors.map((v) => `"${v}"`).join(", ")}.${ready}\n\nAssign a supplier or handle it manually here:\n${link}`,
    };
  }
  const to = created.supplierNames.join(" and ");
  return {
    subject: `Order #${n} placed: ready to send to ${to} ${chargeNote(order)}`,
    text: `Order #${n} (${order.customerName}) was placed and is ready to send to ${to}.\n\nReview the draft and send it from here:\n${link}`,
  };
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

// orders/create: the main trigger. Stores the order and tells Brendan a
// draft is ready. A retry (or a create arriving after paid/cancelled
// already stored the order) does nothing.
export async function processOrderCreated(db: Db, payload: ShopifyOrderPayload, eventAt: Date, baseUrl: string): Promise<WebhookOutcome> {
  const parsed = parseOrderPayload(payload);
  const result = await db.transaction((tx) => ensureOrder(tx, payload, parsed, eventAt));
  if (result.kind === "nothing_to_fulfill") return { body: { created: false, reason: "nothing_to_fulfill" }, email: null };
  if (result.kind === "existing") return { body: { created: false, reason: "duplicate", shopifyOrderId: parsed.shopifyOrderId }, email: null };
  return {
    body: { created: true, orderNumber: result.order.orderNumber, status: result.order.status },
    email: orderPlacedEmail(result, baseUrl),
  };
}

// orders/paid: Brendan charged the card. Records paid_at/financial_status
// and the charged flag. If paid arrives before create, it stores the order
// itself (and sends the "placed" email, since create will then be a no-op).
export async function processOrderPaid(db: Db, payload: ShopifyOrderPayload, eventAt: Date, baseUrl: string): Promise<WebhookOutcome> {
  const parsed = parseOrderPayload(payload);
  return db.transaction(async (tx) => {
    const result = await ensureOrder(tx, payload, parsed, eventAt);
    if (result.kind === "nothing_to_fulfill") return { body: { recorded: false, reason: "nothing_to_fulfill" }, email: null };

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

    return {
      body: { recorded: true, orderCreated: result.kind === "created", orderNumber: order.orderNumber, status: order.status },
      email: result.kind === "created" ? orderPlacedEmail({ ...result, order }, baseUrl) : null,
    };
  });
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
  if (allSent || order.cancelledAt) await resolveAlert(db, unsentAlertKey(order.orderNumber), now);
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
export async function runOrderCheck(db: Db, send: SendNotification, baseUrl: string, now: Date = new Date()): Promise<OrderCheckResult> {
  const result: OrderCheckResult = { unsentOverdue: 0, awaitingStockConfirmation: 0, alertsOpened: 0, emailsSent: 0, emailErrors: [], resolved: 0 };
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

export async function loadSuppliers(db: Db): Promise<Supplier[]> {
  return db.select().from(suppliers);
}
