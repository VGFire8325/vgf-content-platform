// Pure order-status and alert rules, separate from the DB code so they
// can be unit-tested directly.

export type OrderStatus =
  | "new"
  | "draft_ready"
  | "sent"
  | "stock_confirmed"
  | "charged"
  | "shipped"
  | "needs_attention"
  | "cancelled";

// Urgent: the order was placed this long ago and the New Order email
// still isn't marked sent. The clock starts at Shopify's creation time.
export const UNSENT_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
// Normal: the New Order email went out this long ago and the
// manufacturer still hasn't confirmed stock (customer waiting, card not
// charged).
export const STOCK_CONFIRMATION_ALERT_AFTER_MS = 72 * 60 * 60 * 1000;

export interface StatusItem {
  supplierId: string | null;
  sentAt: Date | null;
}

export interface StatusFields {
  cancelledAt: Date | null;
  stockConfirmedAt: Date | null;
  charged: boolean;
  trackingNumber: string | null;
}

// Derived from the items plus the order's own fields:
//   - cancelled in Shopify → cancelled (wins over everything)
//   - nothing to send, or an unmatched vendor not yet handled → needs_attention
//   - any supplier's draft not yet sent → draft_ready
//   - then, furthest step reached: shipped (tracking entered) > charged
//     (orders/paid received) > stock_confirmed > sent
export function deriveOrderStatus(items: StatusItem[], fields: StatusFields): OrderStatus {
  if (fields.cancelledAt) return "cancelled";
  if (items.length === 0) return "needs_attention";
  if (items.some((i) => i.supplierId === null && i.sentAt === null)) return "needs_attention";
  if (items.some((i) => i.sentAt === null)) return "draft_ready";
  if (fields.trackingNumber) return "shipped";
  if (fields.charged) return "charged";
  if (fields.stockConfirmedAt) return "stock_confirmed";
  return "sent";
}

export function unsentAlertKey(orderNumber: string): string {
  return `order_unsent_${orderNumber}`;
}

export function stockConfirmationAlertKey(orderNumber: string): string {
  return `order_unconfirmed_${orderNumber}`;
}

export function isOverdueUnsent(order: { createdAtShopify: Date; sentAt: Date | null; cancelledAt: Date | null }, now: Date): boolean {
  return order.cancelledAt === null && order.sentAt === null && now.getTime() - order.createdAtShopify.getTime() > UNSENT_ALERT_AFTER_MS;
}

export function isAwaitingStockConfirmation(
  order: { sentAt: Date | null; stockConfirmedAt: Date | null; cancelledAt: Date | null },
  now: Date,
): boolean {
  return (
    order.cancelledAt === null &&
    order.stockConfirmedAt === null &&
    order.sentAt !== null &&
    now.getTime() - order.sentAt.getTime() > STOCK_CONFIRMATION_ALERT_AFTER_MS
  );
}

// Groups items by supplier, one draft per group, in first-seen order.
// Unmatched items (supplierId null) form their own group.
export function groupItemsBySupplier<T extends { supplierId: string | null }>(items: T[]): { supplierId: string | null; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const list = groups.get(item.supplierId) ?? [];
    list.push(item);
    groups.set(item.supplierId, list);
  }
  return [...groups.entries()].map(([supplierId, groupItems]) => ({ supplierId, items: groupItems }));
}
