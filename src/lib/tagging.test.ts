import { test } from "node:test";
import assert from "node:assert/strict";
import { inferAudienceTag, inferFormatTag, inferHookType, inferTopicTag, platformFitForArticle } from "./tagging";

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

test("inferFormatTag always tags a Pinterest pin as image-pin, regardless of copy", () => {
  assert.equal(inferFormatTag("pinterest_pin", "anything"), "image-pin");
});

test("inferFormatTag always tags an Instagram carousel as carousel, regardless of copy", () => {
  assert.equal(inferFormatTag("ig_carousel", "anything"), "carousel");
});

test("inferFormatTag tags a quote-led LinkedIn post as quote", () => {
  assert.equal(inferFormatTag("linkedin_post", '"The biggest spec mistake we see is undersizing the electrical rough-in."'), "quote");
});

test("inferFormatTag tags a bulleted LinkedIn post as list", () => {
  const text = "Three things to check before framing:\n- Clearance to combustibles\n- Electrical rough-in\n- Venting, if gas";
  assert.equal(inferFormatTag("linkedin_post", text), "list");
});

test("inferFormatTag tags a numbered Facebook post as list", () => {
  const text = "Checklist:\n1. Measure the wall\n2. Confirm clearance\n3. Pick a finish";
  assert.equal(inferFormatTag("fb_post", text), "list");
});

test("inferFormatTag falls back to text-only for plain LinkedIn/Facebook copy", () => {
  assert.equal(inferFormatTag("linkedin_post", "Sequencing an electric fireplace install changes once trades are involved."), "text-only");
});

test("inferFormatTag doesn't call a single bullet line a list", () => {
  assert.equal(inferFormatTag("linkedin_post", "One more thing:\n- just this one line"), "text-only");
});

test("inferHookType tags a how-to opening before the generic question check", () => {
  assert.equal(inferHookType("How to size an electric fireplace for your wall."), "how-to");
});

test("inferHookType tags a question opening", () => {
  assert.equal(inferHookType("Is your electric fireplace actually sized right?"), "question");
  assert.equal(inferHookType("How much does an electric fireplace really cost to run?"), "question");
});

test("inferHookType tags a stat/number opening", () => {
  assert.equal(inferHookType("73% of homeowners pick the wrong size the first time."), "stat");
  assert.equal(inferHookType("$1,200 is the average cost of a bad install."), "stat");
});

test("inferHookType tags a bold-claim opening", () => {
  assert.equal(inferHookType("Never mount a TV above an electric fireplace without checking this first."), "bold-claim");
  assert.equal(inferHookType("Stop guessing at your fireplace size."), "bold-claim");
});

test("inferHookType falls back to other for plain statements", () => {
  assert.equal(inferHookType("Electric fireplaces come in a range of sizes and finishes."), "other");
});
