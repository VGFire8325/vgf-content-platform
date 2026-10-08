import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePinterestPinQuality,
  isDuplicatePinterestPin,
  pinAltTextDescribesImage,
  pinDescriptionAnswersSearch,
  pinLinkMatchesArticle,
  pinTitleLeadsWithKeyword,
} from "./pinterest-quality";

// Check 1
test("pinTitleLeadsWithKeyword passes when the title's first words match a topic keyword", () => {
  assert.equal(
    pinTitleLeadsWithKeyword("Electric Fireplace Sizing Guide for Every Wall", ["electric fireplace sizing"]),
    true,
  );
});

test("pinTitleLeadsWithKeyword fails a title with no real title at all (the 'several pins had no title' bug)", () => {
  assert.equal(pinTitleLeadsWithKeyword("", ["electric fireplace sizing"]), false);
});

test("pinTitleLeadsWithKeyword fails when the keyword only appears buried at the end", () => {
  assert.equal(
    pinTitleLeadsWithKeyword("A Complete Buyer's Overview You Should Read About Electric Fireplace Sizing", ["electric fireplace sizing"]),
    false,
  );
});

// Check 2
test("pinDescriptionAnswersSearch passes a description that shares the title's topic and has real content", () => {
  assert.equal(
    pinDescriptionAnswersSearch(
      "How to Choose the Right Electric Fireplace Size",
      "This guide walks through sizing an electric fireplace for your wall and room.",
    ),
    true,
  );
});

test("pinDescriptionAnswersSearch fails an empty or too-short description", () => {
  assert.equal(pinDescriptionAnswersSearch("How to Choose the Right Electric Fireplace Size", "Nice."), false);
});

test("pinDescriptionAnswersSearch fails a description with no topical overlap with the title", () => {
  assert.equal(
    pinDescriptionAnswersSearch("How to Choose the Right Electric Fireplace Size", "Our brand has been around for a long time and we care."),
    false,
  );
});

// Check 3
test("pinAltTextDescribesImage passes real alt text that overlaps the asset's own tags", () => {
  assert.equal(pinAltTextDescribesImage("Linear electric fireplace built into a living room wall", ["linear", "insert"]), true);
});

test("pinAltTextDescribesImage fails a placeholder alt text", () => {
  assert.equal(pinAltTextDescribesImage("image", ["linear", "insert"]), false);
});

test("pinAltTextDescribesImage fails real-looking alt text that doesn't match the actual selected image's tags", () => {
  assert.equal(pinAltTextDescribesImage("A cozy wood-burning stove in a cabin", ["linear", "wall-mounted", "electric"]), false);
});

test("pinAltTextDescribesImage passes substantive alt text when no image tags exist to check against yet", () => {
  assert.equal(pinAltTextDescribesImage("Linear electric fireplace built into a living room wall"), true);
});

// Check 4
test("pinLinkMatchesArticle passes a UTM-tagged link to the right article", () => {
  assert.equal(
    pinLinkMatchesArticle(
      "https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas?utm_source=pinterest",
      "https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas",
    ),
    true,
  );
});

test("pinLinkMatchesArticle fails a link to a different article", () => {
  assert.equal(
    pinLinkMatchesArticle(
      "https://verygoodfireplaces.com/blogs/electric-fireplaces/some-other-article",
      "https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas",
    ),
    false,
  );
});

// Check 5
test("isDuplicatePinterestPin blocks a second pin for the same article and image", () => {
  const existing = [{ articleId: "article-1", assetId: "asset-1" }];
  assert.equal(isDuplicatePinterestPin(existing, { articleId: "article-1", assetId: "asset-1" }), true);
});

test("isDuplicatePinterestPin allows the same article with a different image", () => {
  const existing = [{ articleId: "article-1", assetId: "asset-1" }];
  assert.equal(isDuplicatePinterestPin(existing, { articleId: "article-1", assetId: "asset-2" }), false);
});

test("isDuplicatePinterestPin never matches on an unselected (null) image", () => {
  const existing = [{ articleId: "article-1", assetId: null }];
  assert.equal(isDuplicatePinterestPin(existing, { articleId: "article-1", assetId: null }), false);
});

// Orchestrator
test("evaluatePinterestPinQuality flags a pin with no real title and no real description", () => {
  const flags = evaluatePinterestPinQuality({
    articleId: "article-1",
    title: "",
    description: "",
    altText: "Linear electric fireplace built into a living room wall",
    topicKeywords: ["electric fireplace sizing"],
    pinLink: "https://verygoodfireplaces.com/blogs/electric-fireplaces/sizing-guide",
    articleUrl: "https://verygoodfireplaces.com/blogs/electric-fireplaces/sizing-guide",
    existingPins: [],
  });
  assert.ok(flags.some((f) => f.includes("Title")));
  assert.ok(flags.some((f) => f.includes("Description")));
});

test("evaluatePinterestPinQuality passes a well-formed pin with no issues", () => {
  const flags = evaluatePinterestPinQuality({
    articleId: "article-1",
    title: "How to Choose the Right Electric Fireplace Size",
    description: "This guide walks through sizing an electric fireplace for your wall and room.",
    altText: "Linear electric fireplace built into a living room wall",
    topicKeywords: ["electric fireplace sizing"],
    pinLink: "https://verygoodfireplaces.com/blogs/electric-fireplaces/sizing-guide?utm_source=pinterest",
    articleUrl: "https://verygoodfireplaces.com/blogs/electric-fireplaces/sizing-guide",
    image: { assetId: "asset-1", tags: ["linear", "wall"] },
    existingPins: [],
  });
  assert.deepEqual(flags, []);
});

test("evaluatePinterestPinQuality flags a duplicate pin for the same article and image", () => {
  const flags = evaluatePinterestPinQuality({
    articleId: "article-1",
    title: "How to Choose the Right Electric Fireplace Size",
    description: "This guide walks through sizing an electric fireplace for your wall and room.",
    altText: "Linear electric fireplace built into a living room wall",
    topicKeywords: ["electric fireplace sizing"],
    pinLink: "https://verygoodfireplaces.com/blogs/electric-fireplaces/sizing-guide?utm_source=pinterest",
    articleUrl: "https://verygoodfireplaces.com/blogs/electric-fireplaces/sizing-guide",
    image: { assetId: "asset-1", tags: ["linear", "wall"] },
    existingPins: [{ articleId: "article-1", assetId: "asset-1" }],
  });
  assert.ok(flags.some((f) => f.toLowerCase().includes("duplicate")));
});
