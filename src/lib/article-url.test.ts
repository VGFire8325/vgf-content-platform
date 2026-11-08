import { test } from "node:test";
import assert from "node:assert/strict";
import { withLinkedInUtm, withPinterestUtm } from "./article-url";

test("withLinkedInUtm adds utm_source/medium/campaign and uses the content item id as utm_content (matches Pinterest's shape)", () => {
  const tagged = withLinkedInUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas", "item-123");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("utm_source"), "linkedin");
  assert.equal(url.searchParams.get("utm_medium"), "social");
  assert.equal(url.searchParams.get("utm_campaign"), "organic_posts");
  assert.equal(url.searchParams.get("utm_content"), "item-123");
});

test("withLinkedInUtm preserves existing, unrelated query params", () => {
  const tagged = withLinkedInUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas?ref=newsletter", "item-123");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("ref"), "newsletter");
  assert.equal(url.searchParams.get("utm_campaign"), "organic_posts");
});

test("withLinkedInUtm does not duplicate UTM params when the link is already tagged", () => {
  const once = withLinkedInUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas", "item-123");
  const twice = withLinkedInUtm(once, "item-123");
  const url = new URL(twice);
  assert.equal(url.searchParams.getAll("utm_source").length, 1);
  assert.equal(url.searchParams.getAll("utm_medium").length, 1);
  assert.equal(url.searchParams.getAll("utm_campaign").length, 1);
  assert.equal(url.searchParams.getAll("utm_content").length, 1);
  assert.equal(twice, once);
});

test("withPinterestUtm still tags with the fixed organic_pins campaign (unchanged behavior)", () => {
  const tagged = withPinterestUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas", "item-123");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("utm_campaign"), "organic_pins");
  assert.equal(url.searchParams.get("utm_content"), "item-123");
});
