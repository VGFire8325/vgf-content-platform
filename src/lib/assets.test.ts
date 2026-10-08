import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeById,
  filterUnderReuseCap,
  normalizeSemanticMatchInput,
  pickFallbackAsset,
  rankAssetsByScore,
  scoreAssetMatch,
} from "./assets";

test("scoreAssetMatch counts overlapping tags case-insensitively", () => {
  const score = scoreAssetMatch(["Linear", "living-room", "Install"], ["linear", "buying-guide"]);
  assert.equal(score, 1);
});

test("scoreAssetMatch returns 0 when nothing overlaps", () => {
  const score = scoreAssetMatch(["wall-mounted"], ["linear", "buying-guide"]);
  assert.equal(score, 0);
});

test("scoreAssetMatch returns 0 for an empty tag list on either side", () => {
  assert.equal(scoreAssetMatch([], ["linear"]), 0);
  assert.equal(scoreAssetMatch(["linear"], []), 0);
});

test("scoreAssetMatch counts multiple overlaps", () => {
  const score = scoreAssetMatch(["linear", "install", "living-room"], ["linear", "install", "buying-guide"]);
  assert.equal(score, 2);
});

test("rankAssetsByScore orders best match first and drops zero-overlap candidates", () => {
  const candidates = [
    { id: "a", tags: ["linear"] },
    { id: "b", tags: ["linear", "install", "living-room"] },
    { id: "c", tags: ["wall-mounted"] },
  ];
  const ranked = rankAssetsByScore(candidates, ["linear", "install", "buying-guide"]);
  assert.deepEqual(
    ranked.map((a) => a.id),
    ["b", "a"],
  );
});

test("rankAssetsByScore returns [] when nothing matches, including an empty library", () => {
  assert.deepEqual(rankAssetsByScore([], ["linear"]), []);
  assert.deepEqual(rankAssetsByScore([{ id: "a", tags: ["wall-mounted"] }], ["linear"]), []);
});

test("rankAssetsByScore keeps stable order for equal scores", () => {
  const candidates = [
    { id: "a", tags: ["linear"] },
    { id: "b", tags: ["linear"] },
    { id: "c", tags: ["linear"] },
  ];
  const ranked = rankAssetsByScore(candidates, ["linear"]);
  assert.deepEqual(
    ranked.map((a) => a.id),
    ["a", "b", "c"],
  );
});

test("scoreAssetMatch ignores a blog category tag leaking onto an asset", () => {
  // Reproduces the real production bug: an asset imported from a Shopify
  // product picked up "Room & Space" (one of the blog's own category
  // tags) alongside its real photo tags. Every article tagged "Room &
  // Space" then "matched" this one unrelated asset by coincidence.
  const score = scoreAssetMatch(["Amantii", "Three-Sided", "Room & Space"], ["Room & Space"]);
  assert.equal(score, 0);
});

test("scoreAssetMatch still counts a real overlap alongside a blog category tag", () => {
  const score = scoreAssetMatch(["Linear", "Installation"], ["Linear", "Installation"]);
  assert.equal(score, 1);
});

test("rankAssetsByScore drops an asset whose only overlap is a blog category tag", () => {
  const candidates = [
    { id: "unrelated-but-tagged", tags: ["Amantii", "Three-Sided", "Room & Space"] },
    { id: "no-overlap", tags: ["Wall-Mount"] },
  ];
  assert.deepEqual(rankAssetsByScore(candidates, ["Room & Space"]), []);
});

test("dedupeById keeps first occurrence and drops later duplicates", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }, { id: "b" }];
  assert.deepEqual(
    dedupeById(items).map((i) => i.id),
    ["a", "b", "c"],
  );
});

test("pickFallbackAsset prefers an asset not used in the recent window", () => {
  const candidates = [{ id: "recent" }, { id: "fresh" }, { id: "also-fresh" }];
  const recentlyUsed = new Set(["recent"]);
  assert.equal(pickFallbackAsset(candidates, recentlyUsed).id, "fresh");
});

test("pickFallbackAsset still returns something when every candidate was used recently", () => {
  const candidates = [{ id: "a" }, { id: "b" }];
  const recentlyUsed = new Set(["a", "b"]);
  assert.equal(pickFallbackAsset(candidates, recentlyUsed).id, "a");
});

test("pickFallbackAsset prefers word overlap with the article over blind recency", () => {
  // Reproduces the real production case: every topically relevant asset
  // was within the recency window, so the old pure-recency fallback
  // handed an unrelated accessory photo to an "Electric Fireplace
  // Insert" article instead.
  const candidates = [
    { id: "trim-kit", tags: ["Amantii", "Electric Fireplace Accessory"], notes: "Trim Kit" },
    { id: "insert-photo", tags: ["Remii", "Electric Fireplace Insert"], notes: "Heritage Classic installed" },
  ];
  const recentlyUsed = new Set(["insert-photo"]); // the relevant one is "used up"
  const article = { title: "Electric vs Wood-Burning Fireplace Inserts", tags: [] };
  assert.equal(pickFallbackAsset(candidates, recentlyUsed, article).id, "insert-photo");
});

test("pickFallbackAsset falls back to pure recency when nothing overlaps the article at all", () => {
  const candidates = [{ id: "a", tags: ["Outdoor"], notes: null }, { id: "b", tags: ["Wall-Mount"], notes: null }];
  const recentlyUsed = new Set(["a"]);
  const article = { title: "Choosing a Mantel Style", tags: [] };
  assert.equal(pickFallbackAsset(candidates, recentlyUsed, article).id, "b");
});

test("pickFallbackAsset breaks a relevance tie toward the not-recently-used candidate", () => {
  const candidates = [
    { id: "used", tags: ["Electric Fireplace Insert"], notes: null },
    { id: "fresh", tags: ["Electric Fireplace Insert"], notes: null },
  ];
  const recentlyUsed = new Set(["used"]);
  const article = { title: "Electric Fireplace Insert Buying Guide", tags: [] };
  assert.equal(pickFallbackAsset(candidates, recentlyUsed, article).id, "fresh");
});

test("filterUnderReuseCap excludes an asset that's hit the cap", () => {
  const candidates = [{ id: "overused" }, { id: "under-cap" }];
  const usageCounts = new Map([["overused", 3]]);
  assert.deepEqual(
    filterUnderReuseCap(candidates, usageCounts, 3).map((c) => c.id),
    ["under-cap"],
  );
});

test("filterUnderReuseCap reproduces the real production case: one photo handed to 31 different articles", () => {
  const candidates = [{ id: "overused-photo" }, { id: "rarely-used" }];
  const usageCounts = new Map([
    ["overused-photo", 31],
    ["rarely-used", 1],
  ]);
  assert.deepEqual(
    filterUnderReuseCap(candidates, usageCounts).map((c) => c.id),
    ["rarely-used"],
  );
});

test("filterUnderReuseCap treats an asset with no recorded usage as under the cap", () => {
  const candidates = [{ id: "never-used" }];
  assert.deepEqual(filterUnderReuseCap(candidates, new Map(), 3).map((c) => c.id), ["never-used"]);
});

test("filterUnderReuseCap relaxes the cap rather than returning nothing when every candidate is over it", () => {
  const candidates = [{ id: "a" }, { id: "b" }];
  const usageCounts = new Map([
    ["a", 5],
    ["b", 5],
  ]);
  assert.deepEqual(
    filterUnderReuseCap(candidates, usageCounts, 3).map((c) => c.id),
    ["a", "b"],
  );
});

test("normalizeSemanticMatchInput passes a well-formed matchedAssetIds array through unchanged", () => {
  const normalized = normalizeSemanticMatchInput({ reasoning: "x", matchedAssetIds: ["a", "b"] });
  assert.deepEqual(normalized, { reasoning: "x", matchedAssetIds: ["a", "b"] });
});

test("normalizeSemanticMatchInput defaults a missing matchedAssetIds to an empty array (the real production failure)", () => {
  const normalized = normalizeSemanticMatchInput({ reasoning: "Nothing in the library fits this article." });
  assert.deepEqual(normalized, { reasoning: "Nothing in the library fits this article.", matchedAssetIds: [] });
});

test("normalizeSemanticMatchInput coerces a newline-joined matchedAssetIds string into an array", () => {
  const normalized = normalizeSemanticMatchInput({ reasoning: "x", matchedAssetIds: "asset-1\nasset-2" });
  assert.deepEqual(normalized, { reasoning: "x", matchedAssetIds: ["asset-1", "asset-2"] });
});

test("normalizeSemanticMatchInput defaults a non-string, non-array matchedAssetIds (e.g. null) to an empty array", () => {
  const normalized = normalizeSemanticMatchInput({ reasoning: "x", matchedAssetIds: null });
  assert.deepEqual(normalized, { reasoning: "x", matchedAssetIds: [] });
});
