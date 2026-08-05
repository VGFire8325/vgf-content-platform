import { test } from "node:test";
import assert from "node:assert/strict";
import { hashArticleContent } from "./hash";

test("hashArticleContent is stable for identical input", () => {
  const html = "<p>Electric fireplaces need a dedicated 20A circuit.</p>";
  assert.equal(hashArticleContent(html), hashArticleContent(html));
});

test("hashArticleContent changes when content changes", () => {
  const a = hashArticleContent("<p>Original text.</p>");
  const b = hashArticleContent("<p>Original text, lightly edited.</p>");
  assert.notEqual(a, b);
});
