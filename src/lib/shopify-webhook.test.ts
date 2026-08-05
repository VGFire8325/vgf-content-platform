import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { shopifyArticleWebhookSchema, verifyShopifyHmac } from "./shopify-webhook";

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

test("verifyShopifyHmac accepts a correctly signed body", () => {
  const body = JSON.stringify({ id: 1 });
  assert.equal(verifyShopifyHmac(body, sign(body), SECRET), true);
});

test("verifyShopifyHmac rejects a tampered body", () => {
  const body = JSON.stringify({ id: 1 });
  const signature = sign(body);
  const tampered = JSON.stringify({ id: 2 });
  assert.equal(verifyShopifyHmac(tampered, signature, SECRET), false);
});

test("verifyShopifyHmac rejects the wrong secret", () => {
  const body = JSON.stringify({ id: 1 });
  assert.equal(verifyShopifyHmac(body, sign(body, "wrong-secret"), SECRET), false);
});

test("verifyShopifyHmac rejects a missing header", () => {
  assert.equal(verifyShopifyHmac("{}", null, SECRET), false);
});

test("shopifyArticleWebhookSchema parses a real-shaped payload", () => {
  const payload = {
    id: 555781750938,
    blog_id: 52721614986,
    title: "5 Best Linear Electric Fireplaces for Your Home in 2026",
    handle: "best-linear-electric-fireplaces-for-your-home",
    body_html: "<p>...</p>",
    tags: "linear, electric fireplace, buying guide",
    published_at: "2021-04-21T12:16:46Z",
    updated_at: "2026-07-28T01:05:08Z",
  };
  const result = shopifyArticleWebhookSchema.safeParse(payload);
  assert.equal(result.success, true);
});
