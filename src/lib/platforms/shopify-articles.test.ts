import { test } from "node:test";
import assert from "node:assert/strict";
import { shopifyArticleSchema } from "./shopify-articles";

test("shopifyArticleSchema parses a real-shaped payload", () => {
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
  const result = shopifyArticleSchema.safeParse(payload);
  assert.equal(result.success, true);
});
