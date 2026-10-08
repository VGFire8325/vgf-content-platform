import { test } from "node:test";
import assert from "node:assert/strict";
import { composeLinkedInPost } from "./linkedin-post";

test("composeLinkedInPost appends exactly one CTA line and one link after the post text", () => {
  const result = composeLinkedInPost(
    "Placement affects clearance requirements more than most people expect.",
    "See which placement fits your room.",
    "https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas?utm_source=linkedin",
  );
  const lines = result.split("\n").filter(Boolean);
  assert.equal(lines.filter((l) => l.includes("utm_source=linkedin")).length, 1, "exactly one link line");
  assert.equal(lines.filter((l) => l === "See which placement fits your room.").length, 1, "exactly one CTA line");
  assert.ok(result.endsWith("https://verygoodfireplaces.com/blogs/electric-fireplaces/placement-ideas?utm_source=linkedin"));
});

test("composeLinkedInPost puts the CTA line immediately before the link", () => {
  const result = composeLinkedInPost("Body text.", "Compare the options before you choose.", "https://example.com/a");
  const lines = result.split("\n").filter(Boolean);
  assert.equal(lines[lines.length - 2], "Compare the options before you choose.");
  assert.equal(lines[lines.length - 1], "https://example.com/a");
});
