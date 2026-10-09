import { and, eq, inArray, isNull, like, lte } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { alerts, orderItems, orders, suppliers } from "@/db/schema";
import { markAlertEmailed, openAlert, resolveAlert } from "@/lib/alerts";
import type { NotificationEmail, SendNotification } from "@/lib/email";
import { parseOrderPayload, sanitizeOrderPayload, type ShopifyOrderPayload } from "./shopify-webhook";
import { deriveOrderStatus, isOverdueUnsent, unsentAlertKey, UNSENT_ALERT_AFTER_MS } from "./status";
import { isFulfillableLineItem, matchSupplier, type Supplier } from "./suppliers";

type Db = typeof DbClient;
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

export type IngestResult =
  | { created: false; shopifyOrderId: string; reason: "duplicate" | "nothing_to_fulfill" }
  | {
      created: true;
      order: OrderRow;
      supplierNames: string[];
      unmatchedVendors: string[];
    };

// Stores a paid order exactly once. The unique shopify_order_id plus
// ON CONFLICT DO NOTHING is the idempotency guard: a Shopify retry (or two
// deliveries racing) finds the row already there and returns
// created: false, so the caller skips the notification. Everything runs in
// one transaction so a failure part-way doesn't leave an order row with no
// items that a retry would then wrongly treat as "already done".
//
// Orders with nothing to send to a manufacturer (Shopify sends Extend
// protection plans as their own orders, e.g. #1301) aren't stored at all:
// they'd otherwise sit unsent and trip the 24-hour alert forever.
export async function ingestPaidOrder(db: Db, payload: ShopifyOrderPayload, paidAt: Date): Promise<IngestResult> {
  const parsed = parseOrderPayload(payload);
  const fulfillable = parsed.lineItems.filter((li) => isFulfillableLineItem({ vendor: li.vendor, requires_shipping: li.requiresShipping }));
  if (fulfillable.length === 0) {
    return { created: false, shopifyOrderId: parsed.shopifyOrderId, reason: "nothing_to_fulfill" };
  }

  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(orders)
      .values({
        shopifyOrderId: parsed.shopifyOrderId,
        orderNumber: parsed.orderNumber,
        paidAt,
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
        rawPayload: sanitizeOrderPayload(payload),
      })
      .onConflictDoNothing({ target: orders.shopifyOrderId })
      .returning();
    if (!inserted) return { created: false, shopifyOrderId: parsed.shopifyOrderId, reason: "duplicate" };

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

    const supplierIds = [...new Set(itemValues.map((i) => i.supplierId).filter((id): id is string => id !== null))];
    const status = deriveOrderStatus(
      itemValues.map((i) => ({ supplierId: i.supplierId, sentAt: null })),
      { confirmedAt: null, trackingNumber: null },
    );
    const [order] = await tx
      .update(orders)
      .set({ status, supplierId: supplierIds.length === 1 ? supplierIds[0] : null })
      .where(eq(orders.id, inserted.id))
      .returning();

    return {
      created: true,
      order: order!,
      supplierNames: supplierIds.map((id) => supplierList.find((s) => s.id === id)!.name),
      unmatchedVendors: [...new Set(itemValues.filter((i) => i.supplierId === null).map((i) => i.vendor ?? "(blank vendor)"))],
    };
  });
}

export function ordersPageUrl(baseUrl: string, orderNumber: string): string {
  return `${baseUrl.replace(/\/$/, "")}/review/orders#order-${orderNumber}`;
}

// The one email Brendan gets per new order.
export function newOrderEmail(result: Extract<IngestResult, { created: true }>, baseUrl: string): NotificationEmail {
  const n = result.order.orderNumber;
  const link = ordersPageUrl(baseUrl, n);
  if (result.order.status === "needs_attention") {
    const reason = `no supplier matches vendor ${result.unmatchedVendors.map((v) => `"${v}"`).join(", ")}`;
    const ready = result.supplierNames.length > 0 ? `\n\nDrafts are ready for: ${result.supplierNames.join(", ")}.` : "";
    return {
      subject: `Order #${n} needs attention`,
      text: `Order #${n} (${result.order.customerName}) needs attention: ${reason}.${ready}\n\nAssign a supplier or handle it manually here:\n${link}`,
    };
  }
  const to = result.supplierNames.join(" and ");
  return {
    subject: `Order #${n} is ready to send to ${to}`,
    text: `Order #${n} (${result.order.customerName}) is ready to send to ${to}.\n\nReview the draft and send it from here:\n${link}`,
  };
}

async function loadItems(db: DbOrTx, orderId: string): Promise<OrderItemRow[]> {
  return db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
}

// Recomputes status from items + manual fields, and keeps orders.sent_at
// and the 24-hour alert in step with it.
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
  if (allSent) await resolveAlert(db, unsentAlertKey(order.orderNumber), now);
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

export async function markConfirmed(db: Db, orderId: string, confirmed: boolean, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    await tx.update(orders).set({ confirmedAt: confirmed ? now : null }).where(eq(orders.id, orderId));
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

// For an item whose vendor didn't match: Brendan picks the supplier.
export async function assignItemSupplier(db: Db, itemId: string, supplierId: string, now: Date = new Date()): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    const [item] = await tx.update(orderItems).set({ supplierId }).where(eq(orderItems.id, itemId)).returning();
    if (!item) throw new Error(`Order item ${itemId} not found`);
    return refreshOrder(tx, item.orderId, now);
  });
}

export interface OrderCheckResult {
  overdue: number;
  alertsOpened: number;
  emailsSent: number;
  emailErrors: string[];
  resolved: number;
}

// The hourly 24-hour check. For each paid order more than 24h old that
// isn't marked sent: open (or refresh) the urgent alert and email Brendan
// once per alert. A failed email leaves emailed_at null so the next run
// retries it. Also resolves any unsent-order alert whose order has since
// been marked sent by some path other than markSupplierSent.
export async function runOrderCheck(db: Db, send: SendNotification, baseUrl: string, now: Date = new Date()): Promise<OrderCheckResult> {
  const result: OrderCheckResult = { overdue: 0, alertsOpened: 0, emailsSent: 0, emailErrors: [], resolved: 0 };
  const cutoff = new Date(now.getTime() - UNSENT_ALERT_AFTER_MS);
  const candidates = await db.select().from(orders).where(and(isNull(orders.sentAt), lte(orders.paidAt, cutoff)));

  for (const order of candidates) {
    if (!isOverdueUnsent(order, now)) continue;
    result.overdue++;
    const hours = Math.floor((now.getTime() - order.paidAt.getTime()) / 3_600_000);
    const message = `Order #${order.orderNumber} (${order.customerName}) was paid ${hours} hours ago and has not been sent to the manufacturer.`;
    const { alert, created } = await openAlert(db, { key: unsentAlertKey(order.orderNumber), severity: "urgent", message }, now);
    if (created) result.alertsOpened++;
    if (alert.emailedAt) continue;
    try {
      await send({
        subject: `[URGENT] Order #${order.orderNumber} not sent after 24 hours`,
        text: `${message}\n\nOpen the order here:\n${ordersPageUrl(baseUrl, order.orderNumber)}`,
      });
      await markAlertEmailed(db, alert.id, now);
      result.emailsSent++;
    } catch (err) {
      result.emailErrors.push(`#${order.orderNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const openUnsent = await db
    .select()
    .from(alerts)
    .where(and(like(alerts.key, "order_unsent_%"), isNull(alerts.resolvedAt)));
  if (openUnsent.length > 0) {
    const numbers = openUnsent.map((a) => a.key.slice("order_unsent_".length));
    const rows = await db.select().from(orders).where(inArray(orders.orderNumber, numbers));
    for (const row of rows) {
      if (row.sentAt !== null) result.resolved += await resolveAlert(db, unsentAlertKey(row.orderNumber), now);
    }
  }

  return result;
}

export async function loadSuppliers(db: Db): Promise<Supplier[]> {
  return db.select().from(suppliers);
}
