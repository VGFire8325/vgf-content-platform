import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionSchema, normalizeExtractionInput } from "./anthropic";

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

test("normalizeExtractionInput coerces a newline-joined keyTakeaways string into an array", () => {
  const normalized = normalizeExtractionInput({
    coreSubject: "x",
    audience: "x",
    searchIntent: "x",
    keyTakeaways: "Look for a realistic flame effect\nCheck BTU output for room size",
    supportedClaims: [],
  });
  const result = extractionSchema.safeParse(normalized);
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.keyTakeaways, ["Look for a realistic flame effect", "Check BTU output for room size"]);
  }
});

test("normalizeExtractionInput defaults a missing supportedClaims to an empty array", () => {
  const normalized = normalizeExtractionInput({
    coreSubject: "x",
    audience: "x",
    searchIntent: "x",
    keyTakeaways: ["x"],
    // supportedClaims omitted entirely
  });
  const result = extractionSchema.safeParse(normalized);
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.supportedClaims, []);
  }
});

test("normalizeExtractionInput coerces a supportedClaims string into an array", () => {
  const normalized = normalizeExtractionInput({
    coreSubject: "x",
    audience: "x",
    searchIntent: "x",
    keyTakeaways: ["x"],
    supportedClaims: "Most linear models require a dedicated 20A circuit",
  });
  const result = extractionSchema.safeParse(normalized);
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.supportedClaims, ["Most linear models require a dedicated 20A circuit"]);
  }
});
