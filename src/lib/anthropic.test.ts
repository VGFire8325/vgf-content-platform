import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionSchema } from "./anthropic";

test("extractionSchema accepts a well-formed extraction", () => {
  const result = extractionSchema.safeParse({
    coreSubject: "How to choose a linear electric fireplace",
    audience: "Homeowners renovating a living room",
    searchIntent: "Comparing linear electric fireplace models before buying",
    keyTakeaways: ["Look for a realistic flame effect", "Check BTU output for room size"],
    supportedClaims: ["Most linear models require a dedicated 20A circuit"],
  });
  assert.equal(result.success, true);
});

test("extractionSchema rejects a response missing required fields", () => {
  const result = extractionSchema.safeParse({
    coreSubject: "How to choose a linear electric fireplace",
    audience: "Homeowners",
    // searchIntent missing
    keyTakeaways: ["..."],
    supportedClaims: [],
  });
  assert.equal(result.success, false);
});

test("extractionSchema rejects an empty keyTakeaways list", () => {
  const result = extractionSchema.safeParse({
    coreSubject: "x",
    audience: "x",
    searchIntent: "x",
    keyTakeaways: [],
    supportedClaims: [],
  });
  assert.equal(result.success, false);
});
