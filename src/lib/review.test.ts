import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStatusAfterEdit, shouldCancelPendingPublish } from "./review";

test("editing an approved item reverts it to in_review", () => {
  assert.equal(nextStatusAfterEdit("approved"), "in_review");
});

test("editing a scheduled item reverts it to in_review", () => {
  assert.equal(nextStatusAfterEdit("scheduled"), "in_review");
});

test("editing an in_review item leaves it in_review", () => {
  assert.equal(nextStatusAfterEdit("in_review"), "in_review");
});

test("editing a draft, rejected, or failed item does not change its status", () => {
  assert.equal(nextStatusAfterEdit("draft"), "draft");
  assert.equal(nextStatusAfterEdit("rejected"), "rejected");
  assert.equal(nextStatusAfterEdit("failed"), "failed");
});

test("shouldCancelPendingPublish matches the same approved/scheduled condition", () => {
  assert.equal(shouldCancelPendingPublish("approved"), true);
  assert.equal(shouldCancelPendingPublish("scheduled"), true);
  assert.equal(shouldCancelPendingPublish("in_review"), false);
  assert.equal(shouldCancelPendingPublish("published"), false);
});
