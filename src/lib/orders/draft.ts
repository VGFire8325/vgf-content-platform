import type { Supplier } from "./suppliers";

// Builds the manufacturer order email in the exact layout Brendan already
// sends by hand (matched against his sent "New Order [#1320]" email):
//
//   Hello,
//
//   Please process an order for:
//
//   (1) Landscape Pro Multi 120'' LPM-12016
//   (1) Freight for shipping to zip code 77573
//
//   Shipping to:
//
//   Brenda Peek
//   756 Pegasus Lane
//   League City TX 77573
//   United States
//   +1 702-204-3839
//
//   --
//   Have a wonderful day!
//
//   (307) 200-9396
//   www.VeryGoodFireplaces.com
//
// Pure function: no DB, no clock, so it's directly unit-testable.

export interface DraftOrder {
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
  freightSeparate: boolean;
}

export interface DraftItem {
  sku: string | null;
  productName: string;
  quantity: number;
}

export type DraftSupplier = Pick<Supplier, "greeting" | "draftInstructions">;

export interface Draft {
  subject: string;
  body: string;
}

export const SIGNATURE = ["--", "Have a wonderful day!", "", "(307) 200-9396", "www.VeryGoodFireplaces.com"].join("\n");

export function draftSubject(orderNumber: string): string {
  return `New Order [#${orderNumber}]`;
}

export function itemLine(item: DraftItem): string {
  return `(${item.quantity}) ${item.productName}${item.sku ? ` ${item.sku}` : ""}`;
}

export function freightLine(zip: string | null): string {
  return `(1) Freight for shipping to zip code ${zip ?? ""}`.trimEnd();
}

// "League City TX 77573" — no comma, matching Brendan's emails.
export function addressLines(order: DraftOrder): string[] {
  const cityLine = [order.shipCity, order.shipProvince, order.shipZip].filter(Boolean).join(" ");
  return [order.customerName, order.shipCompany, order.shipAddress1, order.shipAddress2, cityLine, order.shipCountry, order.phone].filter(
    (line): line is string => Boolean(line),
  );
}

export function buildDraft(order: DraftOrder, items: DraftItem[], supplier: DraftSupplier): Draft {
  const lines: string[] = [supplier.greeting, "", "Please process an order for:", ""];
  for (const item of items) lines.push(itemLine(item));
  if (order.freightSeparate) lines.push(freightLine(order.shipZip));
  lines.push("");
  if (supplier.draftInstructions) {
    lines.push(supplier.draftInstructions, "");
  }
  lines.push("Shipping to:", "", ...addressLines(order), "", SIGNATURE);
  return { subject: draftSubject(order.orderNumber), body: lines.join("\n") };
}

// For portal suppliers (Touchstone): the same facts as a plain block to
// paste into the dealer portal, no greeting or signature.
export function buildPortalBlock(order: DraftOrder, items: DraftItem[]): string {
  const lines = [`PO / Order: #${order.orderNumber}`, "", "Items:"];
  for (const item of items) lines.push(itemLine(item));
  if (order.freightSeparate) lines.push(freightLine(order.shipZip));
  lines.push("", "Ship to:", ...addressLines(order));
  return lines.join("\n");
}

// mailto: with CRLF line breaks (RFC 6068) so the body keeps its layout in
// Gmail/Apple Mail. Opens a draft in Brendan's mail client; it never sends.
export function buildMailtoUrl(to: string, draft: Draft): string {
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));
  return `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${enc(draft.subject)}&body=${enc(draft.body)}`;
}
