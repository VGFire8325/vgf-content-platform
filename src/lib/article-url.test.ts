import { test } from "node:test";
import assert from "node:assert/strict";
import { withLinkedInUtm, withPinterestUtm } from "./article-url";

test("withLinkedInUtm adds utm_source/medium and uses the article slug as utm_campaign", () => {
  const tagged = withLinkedInUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas", "placement-ideas");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("utm_source"), "linkedin");
  assert.equal(url.searchParams.get("utm_medium"), "social");
  assert.equal(url.searchParams.get("utm_campaign"), "placement-ideas");
});

test("withLinkedInUtm preserves existing, unrelated query params", () => {
  const tagged = withLinkedInUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas?ref=newsletter", "placement-ideas");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("ref"), "newsletter");
  assert.equal(url.searchParams.get("utm_campaign"), "placement-ideas");
});

test("withLinkedInUtm does not duplicate UTM params when the link is already tagged", () => {
  const once = withLinkedInUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas", "placement-ideas");
  const twice = withLinkedInUtm(once, "placement-ideas");
  const url = new URL(twice);
  assert.equal(url.searchParams.getAll("utm_source").length, 1);
  assert.equal(url.searchParams.getAll("utm_medium").length, 1);
  assert.equal(url.searchParams.getAll("utm_campaign").length, 1);
  assert.equal(twice, once);
});

test("withPinterestUtm still tags with the fixed organic_pins campaign (unchanged behavior)", () => {
  const tagged = withPinterestUtm("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas", "item-123");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("utm_campaign"), "organic_pins");
  assert.equal(url.searchParams.get("utm_content"), "item-123");
});
