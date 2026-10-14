import type { suppliers } from "@/db/schema";

export type Supplier = typeof suppliers.$inferSelect;

// The supplier seed confirmed by Brendan on 2026-10-09, with the
// active / ordered_before flags from 0009. The migrations
// (drizzle/0007_order_fulfillment.sql, 0009_supplier_email.sql) are what actually write these rows;
// this copy exists so tests and scripts can use the same values, and a
// unit test checks the two haven't drifted apart.
export const SUPPLIER_SEED: Supplier[] = [
  {
    id: "sustainable_hearth",
    name: "Sustainable Hearth",
    orderEmail: "inside.sales@sustainablehearth.com",
    method: "email",
    vendorNames: ["Sustainable Hearth", "European Home", "Flamerite", "Solution Electric Fires"],
    greeting: "Hi Holly,",
    draftInstructions: "Please ship to the address below. Include shipping on the invoice.",
    notes: "Formerly European Home. Flamerite and Solution Electric Fires products are also Sustainable Hearth (confirmed by Brendan 2026-10-14). Contact: Holly. Wants shipping on the invoice. Do NOT use orders@europeanhome.com.",
    active: true,
    orderedBefore: true,
  },
  {
    id: "modern_flames",
    name: "Modern Flames",
    orderEmail: "orders@modernflames.com",
    method: "email",
    vendorNames: ["Modern Flames"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: "Freight is quoted separately and needs Brendan's approval.",
    active: true,
    orderedBefore: true,
  },
  {
    id: "dynasty",
    name: "Dynasty",
    orderEmail: "info@dynastyfireplace.com",
    method: "email",
    vendorNames: ["Dynasty Fireplaces", "Dynasty"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: null,
    active: true,
    orderedBefore: true,
  },
  {
    id: "amantii_remii",
    name: "Amantii and Remii",
    orderEmail: "usaorders@cannedheat.com",
    method: "email",
    vendorNames: ["Amantii", "Remii"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: null,
    active: true,
    orderedBefore: true,
  },
  {
    id: "dimplex",
    name: "Dimplex",
    orderEmail: "msanders@tsdsupply.com",
    method: "email",
    vendorNames: ["Dimplex"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: "Ordered through TSD Supply.",
    active: true,
    orderedBefore: true,
  },
  {
    id: "litedeer",
    name: "Litedeer",
    orderEmail: "litedeerhomes@gmail.com",
    method: "email",
    vendorNames: ["Litedeer", "Litedeer Homes"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: "Never ordered from before: the first order is the test of this address.",
    active: true,
    orderedBefore: false,
  },
  {
    id: "evolution_fires",
    name: "Evolution Fires",
    orderEmail: "sales@evolutionfires.com",
    method: "email",
    vendorNames: ["Evolution Fires"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: "sales@evolutionfires.com is probably out of date. Confirm the address before sending.",
    active: false,
    orderedBefore: true,
  },
  {
    id: "touchstone",
    name: "Touchstone",
    orderEmail: null,
    method: "portal",
    vendorNames: ["Touchstone"],
    greeting: "Hello,",
    draftInstructions: null,
    notes: "Orders are placed in the Touchstone dealer portal, not by email.",
    active: true,
    orderedBefore: true,
  },
];

// Line items that never go to a manufacturer: Shopify add-ons for
// shipping insurance and protection plans. Shopify marks these
// requires_shipping: false too; the vendor list is a second guard.
export const NON_FULFILLMENT_VENDORS = ["Extend", "Route"];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// Maps a Shopify product `vendor` to a supplier, case-insensitively and
// ignoring surrounding whitespace. Returns null for no match (including a
// blank vendor, which custom/manual line items have).
export function matchSupplier(vendor: string | null | undefined, list: Supplier[]): Supplier | null {
  if (!vendor || !vendor.trim()) return null;
  const wanted = normalize(vendor);
  return list.find((s) => s.vendorNames.some((v) => normalize(v) === wanted)) ?? null;
}

// The supplier an order item is routed to: an inactive supplier (Evolution
// Fires) never is, so its vendor ends up unmatched and Brendan is alerted.
export function matchActiveSupplier(vendor: string | null | undefined, list: Supplier[]): Supplier | null {
  return matchSupplier(
    vendor,
    list.filter((s) => s.active),
  );
}

export function isFulfillableLineItem(item: { vendor?: string | null; requires_shipping?: boolean | null }): boolean {
  if (item.requires_shipping === false) return false;
  if (item.vendor && NON_FULFILLMENT_VENDORS.some((v) => normalize(v) === normalize(item.vendor!))) return false;
  return true;
}
