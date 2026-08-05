import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAssetMatch } from "./assets";

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
