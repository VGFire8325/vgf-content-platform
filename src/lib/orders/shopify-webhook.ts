import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify signs every webhook body with HMAC-SHA256 and sends the base64
// digest in X-Shopify-Hmac-Sha256. The signing key depends on how the
// webhook was registered: the app's client secret for app-registered
// webhooks, or the per-store key shown under Settings → Notifications →
// Webhooks for admin-created ones. Callers pass every key that may be
// in use; the body must match one of them. Must be checked against the
// raw request body, byte-for-byte, before JSON parsing.
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null, secrets: string[]): boolean {
  if (!hmacHeader) return false;
  const provided = Buffer.from(hmacHeader, "base64");
  for (const secret of secrets) {
    if (!secret) continue;
    const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    if (computed.length === provided.length && timingSafeEqual(computed, provided)) {
      return true;
    }
  }
  return false;
}

// The subset of Shopify's order webhook payload this helper reads.
export interface ShopifyAddress {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

export interface ShopifyLineItem {
  sku?: string | null;
  name?: string | null;
  title?: string | null;
  quantity: number;
  vendor?: string | null;
  requires_shipping?: boolean | null;
}

export interface ShopifyOrderPayload {
  id: number | string;
  name?: string | null; // "#1322"
  order_number?: number | null; // 1322
  email?: string | null;
  contact_email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  processed_at?: string | null;
  cancelled_at?: string | null;
  financial_status?: string | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  customer?: { first_name?: string | null; last_name?: string | null; phone?: string | null; email?: string | null } | null;
  line_items: ShopifyLineItem[];
}

export interface ParsedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  createdAt: Date | null; // Shopify's created_at; null if missing/unparseable
  financialStatus: string | null;
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
  lineItems: { sku: string | null; productName: string; quantity: number; vendor: string | null; requiresShipping: boolean }[];
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseOrderPayload(payload: ShopifyOrderPayload): ParsedOrder {
  if (payload.id === undefined || payload.id === null || !Array.isArray(payload.line_items)) {
    throw new Error("Not a Shopify order payload (missing id or line_items)");
  }
  const ship = payload.shipping_address ?? {};
  const fullName = (first?: string | null, last?: string | null) => clean([first, last].filter(Boolean).join(" "));
  const customerName =
    clean(ship.name) ??
    fullName(ship.first_name, ship.last_name) ??
    fullName(payload.customer?.first_name, payload.customer?.last_name) ??
    "(no name)";

  const orderNumber =
    payload.order_number !== undefined && payload.order_number !== null
      ? String(payload.order_number)
      : (clean(payload.name)?.replace(/^#/, "") ?? String(payload.id));

  const created = payload.created_at ? new Date(payload.created_at) : null;

  return {
    shopifyOrderId: String(payload.id),
    orderNumber,
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    financialStatus: clean(payload.financial_status),
    customerName,
    shipCompany: clean(ship.company),
    shipAddress1: clean(ship.address1),
    shipAddress2: clean(ship.address2),
    shipCity: clean(ship.city),
    shipProvince: clean(ship.province_code) ?? clean(ship.province),
    shipZip: clean(ship.zip),
    shipCountry: clean(ship.country),
    phone: clean(ship.phone) ?? clean(payload.phone) ?? clean(payload.customer?.phone),
    email: clean(payload.email) ?? clean(payload.contact_email) ?? clean(payload.customer?.email),
    lineItems: payload.line_items.map((item) => ({
      sku: clean(item.sku),
      productName: clean(item.name) ?? clean(item.title) ?? "(unnamed item)",
      quantity: item.quantity,
      vendor: clean(item.vendor),
      requiresShipping: item.requires_shipping !== false,
    })),
  };
}

// Keys dropped (at any depth) before the payload is stored. Payment
// details must never be stored; browser/session info isn't needed either.
const STRIPPED_KEY_PATTERN = /payment|gateway|credit_card|transaction|browser_ip|client_details|landing_site|referring_site|cart_token|checkout_token/i;

export function sanitizeOrderPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOrderPayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (STRIPPED_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeOrderPayload(child);
    }
    return out;
  }
  return value;
}
