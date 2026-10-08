import { test } from "node:test";
import assert from "node:assert/strict";
import { inferAudienceTag, inferTopicTag, platformFitForArticle } from "./tagging";

test("inferAudienceTag tags a contractor-facing article as trade", () => {
  assert.equal(inferAudienceTag({ audience: "contractors and remodelers planning an install" }), "trade");
});

test("inferAudienceTag tags a plain homeowner article as homeowner", () => {
  assert.equal(inferAudienceTag({ audience: "homeowners shopping for their first electric fireplace" }), "homeowner");
});

test("inferTopicTag uses the Comparisons category tag directly", () => {
  assert.equal(
    inferTopicTag({ tags: ["Comparisons"] }, { searchIntent: "which is better", coreSubject: "two fireplace types" }),
    "comparison",
  );
});

test("inferTopicTag uses the Installation category tag directly", () => {
  assert.equal(
    inferTopicTag({ tags: ["Installation"] }, { searchIntent: "installing a fireplace", coreSubject: "install steps" }),
    "how_to",
  );
});

test("inferTopicTag falls back to text matching for comparison when no category tag matches", () => {
  assert.equal(
    inferTopicTag({ tags: [] }, { searchIntent: "built-in vs wall mounted, which is better", coreSubject: "comparing two styles" }),
    "comparison",
  );
});

test("inferTopicTag falls back to text matching for how-to", () => {
  assert.equal(
    inferTopicTag({ tags: [] }, { searchIntent: "how to install a linear fireplace", coreSubject: "installation steps" }),
    "how_to",
  );
});

test("inferTopicTag falls back to trade when the text names a trade professional with no other signal", () => {
  assert.equal(
    inferTopicTag({ tags: [] }, { searchIntent: "what contractors need to know about clearances", coreSubject: "clearance specs" }),
    "trade",
  );
});

test("inferTopicTag defaults to buying_guide when nothing else matches", () => {
  assert.equal(
    inferTopicTag({ tags: [] }, { searchIntent: "what size fireplace should I get", coreSubject: "sizing basics" }),
    "buying_guide",
  );
});

test("platformFitForArticle prefers LinkedIn for a trade/comparison article", () => {
  assert.equal(platformFitForArticle("linkedin", "trade", "comparison"), "preferred");
  assert.equal(platformFitForArticle("pinterest", "trade", "comparison"), "off_preference");
});

test("platformFitForArticle prefers Pinterest for a homeowner how-to article", () => {
  assert.equal(platformFitForArticle("pinterest", "homeowner", "how_to"), "preferred");
  assert.equal(platformFitForArticle("linkedin", "homeowner", "how_to"), "off_preference");
});

test("platformFitForArticle is neutral for a trade-audience how-to article (doesn't match either lean)", () => {
  assert.equal(platformFitForArticle("linkedin", "trade", "how_to"), "neutral");
  assert.equal(platformFitForArticle("pinterest", "trade", "how_to"), "neutral");
});

test("platformFitForArticle is always neutral for platforms the preference doesn't cover", () => {
  assert.equal(platformFitForArticle("facebook", "homeowner", "how_to"), "neutral");
  assert.equal(platformFitForArticle("instagram", "trade", "comparison"), "neutral");
});
