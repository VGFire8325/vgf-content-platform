import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseOrderPayload, sanitizeOrderPayload, verifyShopifyWebhook } from "./shopify-webhook";

const SECRET = "app-secret";
const body = JSON.stringify({ id: 1, line_items: [] });
const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw, "utf8").digest("base64");

test("verifyShopifyWebhook accepts a correctly signed body", () => {
  assert.equal(verifyShopifyWebhook(body, sign(body), [SECRET]), true);
});

test("verifyShopifyWebhook rejects a tampered body", () => {
  assert.equal(verifyShopifyWebhook(body.replace("1", "2"), sign(body), [SECRET]), false);
});

test("verifyShopifyWebhook rejects the wrong secret, a missing header, and garbage", () => {
  assert.equal(verifyShopifyWebhook(body, sign(body, "other"), [SECRET]), false);
  assert.equal(verifyShopifyWebhook(body, null, [SECRET]), false);
  assert.equal(verifyShopifyWebhook(body, "not-base64!!", [SECRET]), false);
  assert.equal(verifyShopifyWebhook(body, sign(body), []), false);
  assert.equal(verifyShopifyWebhook(body, sign(body, ""), [""]), false);
});

test("verifyShopifyWebhook accepts any configured key (admin-created or app webhook)", () => {
  assert.equal(verifyShopifyWebhook(body, sign(body, "admin-key"), ["", SECRET, "admin-key"]), true);
});

test("parseOrderPayload reads the shipping address and line items", () => {
  const parsed = parseOrderPayload({
    id: 6806949429466,
    name: "#1322",
    order_number: 1322,
    email: "c@example.com",
    phone: null,
    shipping_address: {
      first_name: "Brenda",
      last_name: "Peek",
      name: "Brenda Peek",
      address1: "756 Pegasus Lane",
      address2: "",
      city: "League City",
      province: "Texas",
      province_code: "TX",
      zip: "77573",
      country: "United States",
      phone: "+1 702-204-3839",
    },
    line_items: [{ sku: "LPM-12016", name: "Landscape Pro", title: "Landscape Pro", quantity: 1, vendor: "Modern Flames", requires_shipping: true }],
  });
  assert.equal(parsed.shopifyOrderId, "6806949429466");
  assert.equal(parsed.orderNumber, "1322");
  assert.equal(parsed.customerName, "Brenda Peek");
  assert.equal(parsed.shipProvince, "TX");
  assert.equal(parsed.shipAddress2, null);
  assert.equal(parsed.phone, "+1 702-204-3839");
  assert.deepEqual(parsed.lineItems, [{ sku: "LPM-12016", productName: "Landscape Pro", quantity: 1, vendor: "Modern Flames", requiresShipping: true }]);
});

test("parseOrderPayload falls back to the order name and customer when fields are missing", () => {
  const parsed = parseOrderPayload({ id: 5, name: "#1400", customer: { first_name: "Al", last_name: "Bee", phone: "555" }, line_items: [] });
  assert.equal(parsed.orderNumber, "1400");
  assert.equal(parsed.customerName, "Al Bee");
  assert.equal(parsed.phone, "555");
});

test("parseOrderPayload rejects a non-order body", () => {
  assert.throws(() => parseOrderPayload({} as never));
});

test("sanitizeOrderPayload strips payment and browser data at any depth", () => {
  const clean = sanitizeOrderPayload({
    id: 1,
    payment_gateway_names: ["shopify_payments"],
    payment_details: { credit_card_number: "•••• 4242" },
    browser_ip: "1.2.3.4",
    client_details: { user_agent: "x" },
    total_price: "100.00",
    line_items: [{ sku: "A", payment_terms: "x" }],
    transactions: [{ amount: "100" }],
  });
  assert.deepEqual(clean, { id: 1, total_price: "100.00", line_items: [{ sku: "A" }] });
});
