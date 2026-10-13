import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseAssets,
  dedupeById,
  describeCandidate,
  filterUnderReuseCap,
  isPostableAsset,
  normalizeSemanticMatchInput,
  rankAssetsByScore,
  rankInstalledCandidates,
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

type Row = { id: string; tags: string[]; setting: string | null; featuredOk: boolean | null; quality: number | null };

const article = { title: "Electric fireplace inserts for a living room", tags: ["insert", "living-room"] };

// A semantic matcher that "picks" every candidate it's shown — the worst
// case, standing in for a model that ignores the installed-only rule.
const pickEverything = async (_a: unknown, candidates: Row[], limit: number) => candidates.slice(0, limit);

const noUsage = { recentlyUsed: new Set<string>(), usageCounts: new Map<string, number>() };

const productOnly: Row = { id: "product", tags: ["insert", "living-room"], setting: "product_only", featuredOk: false, quality: 5 };
const render: Row = { id: "render", tags: ["insert", "living-room"], setting: "render", featuredOk: false, quality: 5 };
const untagged: Row = { id: "untagged", tags: ["insert", "living-room"], setting: null, featuredOk: null, quality: null };
const installed: Row = { id: "installed", tags: [], setting: "installed", featuredOk: true, quality: 4 };

for (const row of [productOnly, render, untagged]) {
  test(`chooseAssets never returns a ${row.id} row when it is the only row`, async () => {
    assert.deepEqual(await chooseAssets([row], article, 3, { ...noUsage, semantic: pickEverything }), []);
  });

  test(`chooseAssets never returns a ${row.id} row even as the best tag match`, async () => {
    // `row` shares both article tags; the installed photo shares none.
    const picked = await chooseAssets([row, installed], article, 3, { ...noUsage, semantic: pickEverything });
    assert.deepEqual(
      picked.map((r) => r.id),
      ["installed"],
    );
  });

  test(`chooseAssets drops a ${row.id} row even if the semantic matcher returns it`, async () => {
    const rogue = async () => [row, installed];
    const picked = await chooseAssets([row, installed], { ...article, tags: [] }, 3, { ...noUsage, semantic: rogue });
    assert.deepEqual(
      picked.map((r) => r.id),
      ["installed"],
    );
  });
}

test("chooseAssets returns [] (no fallback pick) when no installed photo matches", async () => {
  const noMatch = async () => [];
  const picked = await chooseAssets([installed, productOnly], { ...article, tags: [] }, 1, { ...noUsage, semantic: noMatch });
  assert.deepEqual(picked, []);
});

test("chooseAssets prefers an installed photo not used recently", async () => {
  const other: Row = { ...installed, id: "other-installed" };
  const picked = await chooseAssets([installed, other], { ...article, tags: [] }, 1, {
    recentlyUsed: new Set(["installed"]),
    usageCounts: new Map([["installed", 1]]),
    semantic: pickEverything,
  });
  assert.deepEqual(
    picked.map((r) => r.id),
    ["other-installed"],
  );
});

test("isPostableAsset accepts only setting = installed", () => {
  for (const setting of ["product_only", "render", "detail", "diagram", "other", null, undefined, ""]) {
    assert.equal(isPostableAsset({ setting }), false, String(setting));
  }
  assert.equal(isPostableAsset({ setting: "installed" }), true);
});

test("rankInstalledCandidates keeps only installed rows, featured_ok first, then by quality", () => {
  const rows: Row[] = [
    untagged,
    productOnly,
    render,
    { id: "installed-q3", tags: [], setting: "installed", featuredOk: false, quality: 3 },
    { id: "installed-q5-unfeatured", tags: [], setting: "installed", featuredOk: false, quality: 5 },
    { id: "featured-q4", tags: [], setting: "installed", featuredOk: true, quality: 4 },
    { id: "featured-q5", tags: [], setting: "installed", featuredOk: true, quality: 5 },
  ];
  assert.deepEqual(
    rankInstalledCandidates(rows).map((r) => r.id),
    ["featured-q5", "featured-q4", "installed-q5-unfeatured", "installed-q3"],
  );
});

test("rankInstalledCandidates keeps input order for equal featured_ok and quality", () => {
  const rows: Row[] = [
    { id: "a", tags: [], setting: "installed", featuredOk: true, quality: 4 },
    { id: "b", tags: [], setting: "installed", featuredOk: true, quality: 4 },
  ];
  assert.deepEqual(
    rankInstalledCandidates(rows).map((r) => r.id),
    ["a", "b"],
  );
});

test("describeCandidate lists room, mounting, brand, tags and alt text", () => {
  const row = {
    id: "x",
    tags: [],
    room: "bedroom",
    mounting: "built_in",
    brand: "Modern Flames",
    altText: "Linear fireplace in a stone column",
  };
  assert.equal(describeCandidate(row), "x: bedroom, built_in, Modern Flames — Linear fireplace in a stone column");
  assert.equal(describeCandidate({ ...row, tags: ["linear"] }), "x: bedroom, built_in, Modern Flames [linear] — Linear fireplace in a stone column");
});
