import { test } from "node:test";
import assert from "node:assert/strict";
import { PlatformValidationError } from "./errors";
import { createInstagramCarousel } from "./meta";

// createInstagramCarousel is a three-step orchestration (create child
// containers -> create parent carousel container -> publish), each step
// gated on Instagram's async "container ready" polling — genuinely easy
// to get wrong, unlike the platform clients' single-call functions
// (untested elsewhere in this codebase because the outbound proxy
// blocks live calls; see errors.ts). Mocking global.fetch here checks
// the call sequence and polling logic without a network dependency.

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

interface RecordedCall {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

test("createInstagramCarousel creates a child container per image, then the carousel, then publishes", async (t) => {
  const calls: RecordedCall[] = [];
  let childContainersCreated = 0;
  let statusPolls = 0;

  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method, body });

    if (url.endsWith("/ig-user-1/media") && init?.method === "POST") {
      if (body?.media_type === "CAROUSEL") {
        return jsonResponse({ id: "carousel-container-1" });
      }
      childContainersCreated += 1;
      return jsonResponse({ id: `child-${childContainersCreated}` });
    }
    if (url.endsWith("/media_publish")) {
      return jsonResponse({ id: "published-1" });
    }
    if (url.includes("fields=status_code")) {
      statusPolls += 1;
      return jsonResponse({ status_code: "FINISHED" });
    }
    if (url.includes("fields=permalink")) {
      return jsonResponse({ permalink: "https://www.instagram.com/p/abc123/" });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  const result = await createInstagramCarousel("page-token", "ig-user-1", {
    caption: "A carousel about linear fireplaces",
    imageUrls: ["https://example.com/slide-1.png", "https://example.com/slide-2.png", "https://example.com/slide-3.png"],
  });

  assert.deepEqual(result, { id: "published-1", url: "https://www.instagram.com/p/abc123/" });
  assert.equal(childContainersCreated, 3, "one container created per image");

  const carouselCall = calls.find((c) => c.body?.media_type === "CAROUSEL");
  assert.equal(carouselCall?.body?.children, "child-1,child-2,child-3", "carousel references children in order");

  const publishCall = calls.find((c) => c.url.endsWith("/media_publish"));
  assert.equal(publishCall?.body?.creation_id, "carousel-container-1");

  assert.equal(statusPolls, 4, "polls status for every child container plus the parent carousel container");
});

test("createInstagramCarousel rejects fewer than 2 images without making a network call", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });

  await assert.rejects(
    () => createInstagramCarousel("page-token", "ig-user-1", { caption: "x", imageUrls: ["only-one.png"] }),
    PlatformValidationError,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("createInstagramCarousel throws when a container fails processing", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith("/ig-user-1/media") && init?.method === "POST") {
      return jsonResponse({ id: "child-1" });
    }
    if (url.includes("fields=status_code")) {
      return jsonResponse({ status_code: "ERROR" });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  await assert.rejects(
    () => createInstagramCarousel("page-token", "ig-user-1", { caption: "x", imageUrls: ["a.png", "b.png"] }),
    PlatformValidationError,
  );
});
