import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_TYPE_BY_PLATFORM,
  POST_SCHEMA_BY_PLATFORM,
  POSTS_PER_PLATFORM,
  claimBearingText,
} from "./generation";

test("every platform maps to exactly one content type", () => {
  assert.deepEqual(CONTENT_TYPE_BY_PLATFORM, {
    pinterest: "pinterest_pin",
    linkedin: "linkedin_post",
    facebook: "fb_post",
    instagram: "ig_carousel",
  });
});

test("pinterest generates multiple pins, other platforms generate one post", () => {
  assert.equal(POSTS_PER_PLATFORM.pinterest, 3);
  assert.equal(POSTS_PER_PLATFORM.linkedin, 1);
  assert.equal(POSTS_PER_PLATFORM.facebook, 1);
  assert.equal(POSTS_PER_PLATFORM.instagram, 1);
});

test("pinterest schema accepts a well-formed pin", () => {
  const result = POST_SCHEMA_BY_PLATFORM.pinterest.safeParse({
    title: "How to Size a Linear Electric Fireplace",
    description: "A quick guide to matching BTU output to room size for linear electric fireplaces.",
    suggestedBoard: "Electric Fireplace Ideas",
    imageConcept: "Wide shot of an approved linear fireplace install in a living room.",
  });
  assert.equal(result.success, true);
});

test("pinterest schema rejects a title over 100 characters", () => {
  const result = POST_SCHEMA_BY_PLATFORM.pinterest.safeParse({
    title: "x".repeat(101),
    description: "desc",
    suggestedBoard: "board",
    imageConcept: "concept",
  });
  assert.equal(result.success, false);
});

test("instagram schema requires at least 2 slides", () => {
  const result = POST_SCHEMA_BY_PLATFORM.instagram.safeParse({
    caption: "caption",
    slides: ["only one"],
  });
  assert.equal(result.success, false);
});

test("linkedin schema rejects a post missing the angle", () => {
  const result = POST_SCHEMA_BY_PLATFORM.linkedin.safeParse({ postText: "text only" });
  assert.equal(result.success, false);
});

test("claimBearingText combines title and description for pinterest", () => {
  const text = claimBearingText("pinterest", {
    title: "Title",
    description: "Description",
    suggestedBoard: "Board",
    imageConcept: "Concept",
  });
  assert.equal(text, "Title\nDescription");
});

test("claimBearingText combines caption and slides for instagram", () => {
  const text = claimBearingText("instagram", {
    caption: "Caption",
    slides: ["Slide one", "Slide two"],
  });
  assert.equal(text, "Caption\nSlide one\nSlide two");
});
