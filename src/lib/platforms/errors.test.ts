import { test } from "node:test";
import assert from "node:assert/strict";
import { PlatformAuthError, PlatformValidationError, classifyMetaError, classifyPinterestError } from "./errors";

test("Pinterest 401 classifies as an auth error", () => {
  const err = classifyPinterestError(401, { code: 40, message: "Invalid token" });
  assert.ok(err instanceof PlatformAuthError);
  assert.equal(err.message, "Invalid token");
});

test("Pinterest 403 classifies as an auth error", () => {
  const err = classifyPinterestError(403, { message: "Forbidden" });
  assert.ok(err instanceof PlatformAuthError);
});

test("Pinterest 400 classifies as a validation error, not auth", () => {
  const err = classifyPinterestError(400, { message: "board_id is required" });
  assert.ok(err instanceof PlatformValidationError);
});

test("Pinterest 500 classifies as a plain (retryable) error", () => {
  const err = classifyPinterestError(500, { message: "Internal error" });
  assert.ok(!(err instanceof PlatformAuthError));
  assert.ok(!(err instanceof PlatformValidationError));
});

test("Meta invalid-token error (HTTP 400, OAuthException) classifies as auth, not validation", () => {
  // This is the documented Graph API quirk: token errors come back as
  // HTTP 400, not 401 — status code alone would misclassify this as a
  // permanent validation failure instead of "needs reconnect."
  const err = classifyMetaError(400, {
    error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 },
  });
  assert.ok(err instanceof PlatformAuthError, "OAuthException must classify as an auth error despite HTTP 400");
});

test("Meta HTTP 401 classifies as an auth error even without a recognized error code", () => {
  const err = classifyMetaError(401, { error: { message: "Unauthorized", type: "OAuthException" } });
  assert.ok(err instanceof PlatformAuthError);
});

test("Meta a genuine validation error (HTTP 400, not OAuthException) classifies as validation", () => {
  const err = classifyMetaError(400, {
    error: { message: "Missing required parameter: message", type: "GraphMethodException", code: 100 },
  });
  assert.ok(err instanceof PlatformValidationError);
  assert.ok(!(err instanceof PlatformAuthError));
});

test("Meta 500 classifies as a plain (retryable) error", () => {
  const err = classifyMetaError(500, { error: { message: "Internal error", type: "Exception" } });
  assert.ok(!(err instanceof PlatformAuthError));
  assert.ok(!(err instanceof PlatformValidationError));
});
