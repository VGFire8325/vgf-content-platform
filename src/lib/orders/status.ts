// Pure order-status and alert rules, separate from the DB code so they
// can be unit-tested directly.

export type OrderStatus = "new" | "draft_ready" | "sent" | "confirmed" | "shipped" | "needs_attention";

export const UNSENT_ALERT_AFTER_MS = 24 * 60 * 60 * 1000;

export interface StatusItem {
  supplierId: string | null;
  sentAt: Date | null;
}

// Derived from the items plus the manual Confirmed/tracking fields:
//   - nothing to fulfil, or an unmatched vendor not yet handled → needs_attention
//   - tracking number entered → shipped
//   - Confirmed clicked → confirmed
//   - every item's draft marked sent → sent
//   - otherwise → draft_ready
export function deriveOrderStatus(
  items: StatusItem[],
  manual: { confirmedAt: Date | null; trackingNumber: string | null },
): OrderStatus {
  if (items.length === 0) return "needs_attention";
  if (items.some((i) => i.supplierId === null && i.sentAt === null)) return "needs_attention";
  if (manual.trackingNumber) return "shipped";
  if (manual.confirmedAt) return "confirmed";
  if (items.every((i) => i.sentAt !== null)) return "sent";
  return "draft_ready";
}

export function unsentAlertKey(orderNumber: string): string {
  return `order_unsent_${orderNumber}`;
}

export function isOverdueUnsent(order: { paidAt: Date; sentAt: Date | null }, now: Date): boolean {
  return order.sentAt === null && now.getTime() - order.paidAt.getTime() > UNSENT_ALERT_AFTER_MS;
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
