import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSyncAction, isArticleLive, shopifyArticleSchema } from "./shopify-articles";

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

const NOW = new Date("2026-08-16T12:00:00Z");

test("isArticleLive is false when published_at is null (draft)", () => {
  assert.equal(isArticleLive(null, NOW), false);
});

test("isArticleLive is false when published_at is in the future (scheduled)", () => {
  assert.equal(isArticleLive("2026-09-01T00:00:00Z", NOW), false);
});

test("isArticleLive is true when published_at is in the past", () => {
  assert.equal(isArticleLive("2026-08-01T00:00:00Z", NOW), true);
});

test("isArticleLive is true when published_at is exactly now", () => {
  assert.equal(isArticleLive(NOW.toISOString(), NOW), true);
});

test("decideSyncAction: brand new article, already live -> created", () => {
  assert.equal(decideSyncAction({ existing: false, wasLive: false, isLive: true, hashChanged: false }), "created");
});

test("decideSyncAction: brand new article, not live yet -> skipped_unpublished", () => {
  assert.equal(decideSyncAction({ existing: false, wasLive: false, isLive: false, hashChanged: false }), "skipped_unpublished");
});

test("decideSyncAction: existing article, still not live -> unchanged (never enqueues while offline)", () => {
  assert.equal(decideSyncAction({ existing: true, wasLive: false, isLive: false, hashChanged: false }), "unchanged");
  assert.equal(decideSyncAction({ existing: true, wasLive: true, isLive: false, hashChanged: true }), "unchanged");
});

test("decideSyncAction: existing article just went live, content unchanged -> published (the actual bug fix)", () => {
  assert.equal(decideSyncAction({ existing: true, wasLive: false, isLive: true, hashChanged: false }), "published");
});

test("decideSyncAction: existing article just went live, content also changed -> still published, not updated", () => {
  assert.equal(decideSyncAction({ existing: true, wasLive: false, isLive: true, hashChanged: true }), "published");
});

test("decideSyncAction: already-live article, no content change -> unchanged (no needless reprocessing)", () => {
  assert.equal(decideSyncAction({ existing: true, wasLive: true, isLive: true, hashChanged: false }), "unchanged");
});

test("decideSyncAction: already-live article, real content edit -> updated", () => {
  assert.equal(decideSyncAction({ existing: true, wasLive: true, isLive: true, hashChanged: true }), "updated");
});
