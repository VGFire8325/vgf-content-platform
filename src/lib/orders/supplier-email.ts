import { matchSupplier, type Supplier } from "./suppliers";

// Automatic supplier order emails: the pure parts (who gets an email,
// what it says, and what Brendan is told). The database side (atomic
// claim, send, state changes, alerts) is dispatchSupplierEmails in
// ./service; the Resend call is sendSupplierEmail in src/lib/email.ts.
//
// The customer's card is only authorized when the order is placed. The
// supplier replies to Brendan (Reply-To), and Brendan charges the card or
// contacts the customer himself. Nothing here charges, cancels or emails a
// customer.

export interface PlanItem {
  id: string;
  sku: string | null;
  productName: string;
  quantity: number;
  vendor: string | null;
  supplierId: string | null;
  sentAt: Date | null;
}

export type SupplierPlan =
  // Email this supplier automatically.
  | { kind: "email"; supplier: Supplier; items: PlanItem[] }
  // Touchstone: Brendan places it in the dealer portal.
  | { kind: "portal"; supplier: Supplier; items: PlanItem[] }
  // No active supplier for this vendor. inactiveSupplier is set when the
  // vendor matches a supplier that no longer exists (Evolution Fires).
  | { kind: "unmatched"; vendor: string; inactiveSupplier: Supplier | null; items: PlanItem[] };

// One entry per supplier (and per unmatched vendor) for the items not yet
// sent, in first-seen order. Items already marked sent (by Brendan or an
// earlier email) are left out. An item routed to a supplier that's
// inactive, or an email supplier with no address, can't be emailed and is
// reported as unmatched / portal-style manual work rather than sent.
export function planSupplierEmails(items: PlanItem[], supplierList: Supplier[]): SupplierPlan[] {
  const plans: SupplierPlan[] = [];
  const byKey = new Map<string, SupplierPlan>();
  for (const item of items) {
    if (item.sentAt !== null) continue;
    const assigned = item.supplierId ? (supplierList.find((s) => s.id === item.supplierId) ?? null) : null;
    let key: string;
    let make: () => SupplierPlan;
    if (assigned && assigned.active && assigned.method === "email" && assigned.orderEmail) {
      key = `email:${assigned.id}`;
      make = () => ({ kind: "email", supplier: assigned, items: [] });
    } else if (assigned && assigned.active) {
      key = `portal:${assigned.id}`;
      make = () => ({ kind: "portal", supplier: assigned, items: [] });
    } else {
      const vendor = item.vendor ?? "(blank vendor)";
      const inactive = assigned ?? matchSupplier(item.vendor, supplierList);
      key = `unmatched:${vendor.toLowerCase()}`;
      make = () => ({ kind: "unmatched", vendor, inactiveSupplier: inactive && !inactive.active ? inactive : null, items: [] });
    }
    let plan = byKey.get(key);
    if (!plan) {
      plan = make();
      byKey.set(key, plan);
      plans.push(plan);
    }
    plan.items.push(item);
  }
  return plans;
}

export interface SupplierEmailOrder {
  orderNumber: string;
  customerName: string;
  shipCompany: string | null;
  shipAddress1: string | null;
  shipAddress2: string | null;
  shipCity: string | null;
  shipProvince: string | null;
  shipZip: string | null;
  shipCountry: string | null;
  phone: string | null;
  email: string | null;
}

export function supplierEmailSubject(orderNumber: string): string {
  return `New Order [#${orderNumber}] from Very Good Fireplaces`;
}

// Plain-text order email to a supplier. Deliberately contains no prices
// and no payment details: only what the supplier needs to pick, ship and
// quote freight. The customer's email is included for the carrier.
export function buildSupplierOrderEmail(
  order: SupplierEmailOrder,
  items: Pick<PlanItem, "sku" | "productName" | "quantity">[],
  supplier: Pick<Supplier, "greeting" | "draftInstructions">,
  replyTo: string,
): { subject: string; text: string } {
  const cityLine = [[order.shipCity, order.shipProvince].filter(Boolean).join(", "), order.shipZip].filter(Boolean).join(" ");
  const shipTo = [
    order.customerName,
    order.shipCompany,
    order.shipAddress1,
    order.shipAddress2,
    cityLine,
    order.shipCountry,
    order.phone ? `Phone: ${order.phone}` : null,
    order.email ? `Email: ${order.email} (for the carrier)` : null,
  ].filter((line): line is string => Boolean(line));

  const lines = [
    supplier.greeting,
    "",
    "We have a new order to place with you.",
    "",
    `PO reference: #${order.orderNumber}`,
    "",
    "Items:",
    ...items.map((i) => `- Qty ${i.quantity}: ${i.productName}${i.sku ? ` (SKU ${i.sku})` : ""}`),
    "",
  ];
  if (supplier.draftInstructions) lines.push(supplier.draftInstructions, "");
  lines.push(
    "Ship to:",
    ...shipTo,
    "",
    "Please reply to this email to:",
    "1. Confirm the items are in stock and ready to ship.",
    "2. If anything isn't in stock, tell us the lead time.",
    "3. Send the freight quote, and the tracking number when it ships.",
    "",
    "Thank you,",
    "Very Good Fireplaces",
    replyTo,
  );
  return { subject: supplierEmailSubject(order.orderNumber), text: lines.join("\n") };
}

// What happened to each supplier group on one dispatch run.
export type DispatchOutcome =
  | { kind: "sent"; supplier: Supplier; mode: "test" | "live"; to: string[]; firstOrder: boolean }
  | { kind: "failed"; supplier: Supplier; error: string; mayHaveSent: boolean }
  // Another request (or an earlier run) already claimed or sent it.
  | { kind: "already_handled"; supplier: Supplier; status: string; mode: string }
  | { kind: "portal"; supplier: Supplier }
  | { kind: "unmatched"; vendor: string; inactiveSupplier: Supplier | null };

export function portalAlertLine(supplierName: string, orderNumber: string): string {
  return `Place order #${orderNumber} in the ${supplierName} dealer portal.`;
}

export function unmatchedAlertLine(vendor: string, orderNumber: string, inactiveSupplier: Supplier | null): string {
  const why = inactiveSupplier ? ` (${inactiveSupplier.name} is no longer an active supplier, so it was not emailed)` : "";
  return `Unmatched vendor ${vendor} on order #${orderNumber}${why}. Assign a supplier or handle it manually.`;
}

// One line per supplier group for Brendan's internal email.
export function outcomeLine(outcome: DispatchOutcome, orderNumber: string): string {
  switch (outcome.kind) {
    case "sent": {
      const address = outcome.supplier.orderEmail;
      const first = outcome.firstOrder ? ` This is the first order to ${address}: watch for their reply.` : "";
      return outcome.mode === "live"
        ? `${outcome.supplier.name}: supplier email sent to ${address} (you're on BCC; replies come to you).${first}`
        : `${outcome.supplier.name}: TEST MODE. The supplier email went to you only (it would go to ${address}). ${outcome.supplier.name} has NOT received it: send it yourself from the orders page.${outcome.supplier.orderedBefore ? "" : ` This will be the first order to ${address}.`}`;
    }
    case "failed":
      return outcome.mayHaveSent
        ? `${outcome.supplier.name}: the supplier email may not have gone out (${outcome.error}). It will be retried automatically; check Resend or send it from the orders page if it hasn't arrived.`
        : `${outcome.supplier.name}: the supplier email FAILED (${outcome.error}). Send it yourself from the orders page.`;
    case "already_handled":
      return `${outcome.supplier.name}: supplier email already ${outcome.status === "sent" ? `sent (${outcome.mode})` : "in progress"}.`;
    case "portal":
      return outcome.supplier.method === "portal"
        ? `${outcome.supplier.name}: ${portalAlertLine(outcome.supplier.name, orderNumber)}`
        : `${outcome.supplier.name}: no order email address on file, so it was not emailed. Send order #${orderNumber} yourself.`;
    case "unmatched":
      return unmatchedAlertLine(outcome.vendor, orderNumber, outcome.inactiveSupplier);
  }
}

export function needsAttention(outcome: DispatchOutcome): boolean {
  return outcome.kind === "portal" || outcome.kind === "unmatched" || outcome.kind === "failed";
}
