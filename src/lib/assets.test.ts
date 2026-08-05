import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAssetsByScore, scoreAssetMatch } from "./assets";

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
