import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrCreateBoard, sanitizeBoardName } from "./pinterest";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// Pinterest rejects board names of 50+ characters with error code 96
// ("Name should be less than 50 characters") — these fixtures are the
// two real board names already stored in production (one 54 chars, one
// exactly 50) plus the cases the task called out explicitly.

test("sanitizeBoardName leaves an already-short name unchanged", () => {
  assert.equal(sanitizeBoardName("Electric Fireplace Ideas", 49), "Electric Fireplace Ideas");
});

test("sanitizeBoardName clamps the real 54-char production board name at a word boundary", () => {
  const name = "Fireplace Installation Tips for Builders & Contractors"; // 56 chars
  const sanitized = sanitizeBoardName(name, 49);
  assert.ok(sanitized.length <= 49, `expected <= 49 chars, got ${sanitized.length}: "${sanitized}"`);
  assert.equal(sanitized, "Fireplace Installation Tips for Builders");
});

test("sanitizeBoardName clamps the real exactly-50-char production board name", () => {
  const name = "Fireplace Buying Guides for Builders & Contractors"; // 51 chars
  const sanitized = sanitizeBoardName(name, 49);
  assert.ok(sanitized.length <= 49, `expected <= 49 chars, got ${sanitized.length}: "${sanitized}"`);
  assert.equal(sanitized.endsWith("&"), false);
});

test("sanitizeBoardName strips a trailing '&' left behind by a word-boundary cut", () => {
  const sanitized = sanitizeBoardName("Short Ideas for Builders & Contractors Everywhere", 26);
  assert.equal(sanitized, "Short Ideas for Builders");
});

test("sanitizeBoardName trims and collapses internal whitespace", () => {
  assert.equal(sanitizeBoardName("  Electric   Fireplace  Ideas  ", 49), "Electric Fireplace Ideas");
});

test("sanitizeBoardName hard-cuts a single word with no earlier space to fall back to", () => {
  const sanitized = sanitizeBoardName("Supercalifragilisticexpialidocious Fireplace Boards", 20);
  assert.equal(sanitized.length, 20);
  assert.equal(sanitized, "Supercalifragilistic");
});

test("findOrCreateBoard creates a board using the sanitized (clamped) name", async (t) => {
  let createdName: string | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/boards?page_size=100")) {
      return jsonResponse(200, { items: [] });
    }
    if (url.endsWith("/boards") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { name: string };
      createdName = body.name;
      return jsonResponse(201, { id: "board-1", name: body.name });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  const boardId = await findOrCreateBoard("token", "Fireplace Installation Tips for Builders & Contractors");
  assert.equal(boardId, "board-1");
  assert.ok(createdName && createdName.length <= 49, `expected clamped name, got "${createdName}"`);
});

test("findOrCreateBoard matches an existing board against the sanitized name, case-insensitive", async (t) => {
  let createCalled = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/boards?page_size=100")) {
      // Stored on Pinterest from before this fix, at its full
      // (over-49-char) length — the sanitized comparison must still
      // match a suggestedBoard that generates the same sanitized name.
      return jsonResponse(200, {
        items: [{ id: "existing-board", name: "fireplace installation tips for builders & contractors" }],
      });
    }
    createCalled = true;
    throw new Error("should not create a new board when a sanitized match exists");
  });

  const boardId = await findOrCreateBoard("token", "Fireplace Installation Tips for Builders & Contractors");
  assert.equal(boardId, "existing-board");
  assert.equal(createCalled, false);
});

test("findOrCreateBoard retries once with a shorter fallback name on Pinterest error code 96", async (t) => {
  let createAttempts = 0;
  let secondAttemptName: string | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/boards?page_size=100")) {
      return jsonResponse(200, { items: [] });
    }
    if (url.endsWith("/boards") && init?.method === "POST") {
      createAttempts += 1;
      const body = JSON.parse(init.body as string) as { name: string };
      if (createAttempts === 1) {
        return jsonResponse(400, { code: 96, message: "Name should be less than 50 characters" });
      }
      secondAttemptName = body.name;
      return jsonResponse(201, { id: "board-fallback", name: body.name });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  const boardId = await findOrCreateBoard("token", "A Board Name That Somehow Still Triggers Code 96 Anyway");
  assert.equal(boardId, "board-fallback");
  assert.equal(createAttempts, 2);
  assert.ok(secondAttemptName && secondAttemptName.length <= 40, `expected a <=40 char fallback, got "${secondAttemptName}"`);
});

test("findOrCreateBoard fails with a clear message when the code-96 retry also fails", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/boards?page_size=100")) {
      return jsonResponse(200, { items: [] });
    }
    if (url.endsWith("/boards") && init?.method === "POST") {
      return jsonResponse(400, { code: 96, message: "Name should be less than 50 characters" });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  await assert.rejects(
    () => findOrCreateBoard("token", "A Board Name That Somehow Still Triggers Code 96 Anyway"),
    /Name should be less than 50 characters/,
  );
});
