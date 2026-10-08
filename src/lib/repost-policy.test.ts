import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRepostDistinctness, extractOpeningLine, isWithinLinkedInRepostGap } from "./repost-policy";

test("isWithinLinkedInRepostGap returns false when there's no prior post", () => {
  assert.equal(isWithinLinkedInRepostGap(null, new Date(), 60), false);
});

test("isWithinLinkedInRepostGap blocks a repost inside the gap (the Placement Ideas Oct 5/6 case)", () => {
  const previousPostAt = new Date("2026-10-05T12:00:00Z");
  const now = new Date("2026-10-06T09:00:00Z");
  assert.equal(isWithinLinkedInRepostGap(previousPostAt, now, 60), true);
});

test("isWithinLinkedInRepostGap allows a repost outside the gap", () => {
  const previousPostAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-10-06T00:00:00Z");
  assert.equal(isWithinLinkedInRepostGap(previousPostAt, now, 60), false);
});

test("isWithinLinkedInRepostGap respects a configured gap, not just the 60-day default", () => {
  const previousPostAt = new Date("2026-09-01T00:00:00Z");
  const now = new Date("2026-10-01T00:00:00Z"); // 30 days later
  assert.equal(isWithinLinkedInRepostGap(previousPostAt, now, 60), true, "inside a 60-day gap");
  assert.equal(isWithinLinkedInRepostGap(previousPostAt, now, 14), false, "outside a 14-day gap");
});

test("extractOpeningLine takes the first sentence", () => {
  assert.equal(
    extractOpeningLine("Placement affects clearance. The rest of the post goes on from there."),
    "Placement affects clearance.",
  );
});

test("extractOpeningLine falls back to the first line when there's no sentence punctuation", () => {
  assert.equal(extractOpeningLine("No punctuation here\nsecond line"), "No punctuation here");
});

test("checkRepostDistinctness flags a forced repost that repeats the same angle and opening line", () => {
  const previous = { angle: "cost efficiency", openingLine: "Placement affects clearance." };
  const candidate = { angle: "Cost Efficiency", openingLine: "Placement affects clearance." };
  const reasons = checkRepostDistinctness(candidate, previous);
  assert.equal(reasons.length, 2);
});

test("checkRepostDistinctness passes a forced repost with a genuinely different angle and opening line", () => {
  const previous = { angle: "cost efficiency", openingLine: "Placement affects clearance." };
  const candidate = { angle: "installation timeline", openingLine: "Most remodels underestimate lead time." };
  assert.deepEqual(checkRepostDistinctness(candidate, previous), []);
});
