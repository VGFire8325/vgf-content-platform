import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isValidMyshopifyDomain, verifyShopifyOAuthCallback } from "./shopify";

const SECRET = "test-client-secret";

// Mirrors Shopify's own algorithm: every param except hmac, sorted
// alphabetically by key, joined as key=value&..., hex digest — the
// inverse of what verifyShopifyOAuthCallback checks.
function sign(params: Record<string, string>, secret = SECRET): string {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function callbackParams(overrides: Record<string, string> = {}): URLSearchParams {
  const base: Record<string, string> = {
    code: "abc123",
    shop: "very-good-fireplaces.myshopify.com",
    state: "nonce-1",
    timestamp: "1700000000",
    ...overrides,
  };
  const hmac = sign(base);
  return new URLSearchParams({ ...base, hmac });
}

test("verifyShopifyOAuthCallback accepts a correctly signed callback", () => {
  assert.equal(verifyShopifyOAuthCallback(callbackParams(), SECRET), true);
});

test("verifyShopifyOAuthCallback rejects a tampered parameter", () => {
  const params = callbackParams();
  params.set("shop", "attacker-shop.myshopify.com");
  assert.equal(verifyShopifyOAuthCallback(params, SECRET), false);
});

test("verifyShopifyOAuthCallback rejects the wrong secret", () => {
  assert.equal(verifyShopifyOAuthCallback(callbackParams(), "wrong-secret"), false);
});

test("verifyShopifyOAuthCallback rejects a missing hmac", () => {
  const params = new URLSearchParams({ code: "abc123", shop: "very-good-fireplaces.myshopify.com" });
  assert.equal(verifyShopifyOAuthCallback(params, SECRET), false);
});

test("isValidMyshopifyDomain accepts a well-formed myshopify.com domain", () => {
  assert.equal(isValidMyshopifyDomain("very-good-fireplaces.myshopify.com"), true);
});

test("isValidMyshopifyDomain rejects a non-myshopify domain", () => {
  assert.equal(isValidMyshopifyDomain("verygoodfireplaces.com"), false);
  assert.equal(isValidMyshopifyDomain("evil.com/.myshopify.com"), false);
});

test("isValidMyshopifyDomain rejects an empty or malformed handle", () => {
  assert.equal(isValidMyshopifyDomain(".myshopify.com"), false);
  assert.equal(isValidMyshopifyDomain("myshopify.com"), false);
});
