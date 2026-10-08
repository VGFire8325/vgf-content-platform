import { test } from "node:test";
import assert from "node:assert/strict";
import { optionalEnvBool, optionalEnvInt } from "./env";

const KEY_INT = "__TEST_OPTIONAL_ENV_INT__";
const KEY_BOOL = "__TEST_OPTIONAL_ENV_BOOL__";

test("optionalEnvInt returns the fallback when unset", () => {
  delete process.env[KEY_INT];
  assert.equal(optionalEnvInt(KEY_INT, 60), 60);
});

test("optionalEnvInt parses a set value, overriding the default gap (Spec 2's configurable setting)", () => {
  process.env[KEY_INT] = "14";
  assert.equal(optionalEnvInt(KEY_INT, 60), 14);
  delete process.env[KEY_INT];
});

test("optionalEnvInt falls back on a non-numeric value instead of returning NaN", () => {
  process.env[KEY_INT] = "not-a-number";
  assert.equal(optionalEnvInt(KEY_INT, 60), 60);
  delete process.env[KEY_INT];
});

test("optionalEnvBool returns the fallback when unset", () => {
  delete process.env[KEY_BOOL];
  assert.equal(optionalEnvBool(KEY_BOOL, true), true);
  assert.equal(optionalEnvBool(KEY_BOOL, false), false);
});

test("optionalEnvBool turns the audience/platform preference off when explicitly set to 'false'", () => {
  process.env[KEY_BOOL] = "false";
  assert.equal(optionalEnvBool(KEY_BOOL, true), false);
  delete process.env[KEY_BOOL];
});

test("optionalEnvBool is true only for the exact string 'true'", () => {
  process.env[KEY_BOOL] = "yes";
  assert.equal(optionalEnvBool(KEY_BOOL, false), false);
  delete process.env[KEY_BOOL];
});
