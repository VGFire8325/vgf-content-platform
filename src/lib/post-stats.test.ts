// Validation and auth checks run unconditionally (pure functions, no
// DB). The upsert/idempotency/pending-window behavior needs a real
// Postgres and is gated behind POST_STATS_TEST_DATABASE_URL, same
// convention as src/lib/orders/orders-db.test.ts — see README "Results
// ingest" for how to run it.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedStatsIngestRequest, postStatIngestRowSchema } from "./post-stats";

test("postStatIngestRowSchema accepts a row identified by publish_target_id", () => {
  const result = postStatIngestRowSchema.safeParse({
    publish_target_id: "11111111-1111-1111-1111-111111111111",
    impressions: 500,
    saves: 12,
    clicks: 3,
  });
  assert.equal(result.success, true);
});

test("postStatIngestRowSchema accepts a row identified by external_post_url", () => {
  const result = postStatIngestRowSchema.safeParse({
    external_post_url: "https://www.pinterest.com/pin/123/",
    impressions: 100,
  });
  assert.equal(result.success, true);
});

test("postStatIngestRowSchema rejects a row with neither identifier", () => {
  const result = postStatIngestRowSchema.safeParse({ impressions: 100 });
  assert.equal(result.success, false);
});

test("postStatIngestRowSchema rejects a negative metric", () => {
  const result = postStatIngestRowSchema.safeParse({
    publish_target_id: "11111111-1111-1111-1111-111111111111",
    impressions: -5,
  });
  assert.equal(result.success, false);
});

test("postStatIngestRowSchema allows an explicit null for a metric the platform didn't report", () => {
  const result = postStatIngestRowSchema.safeParse({
    publish_target_id: "11111111-1111-1111-1111-111111111111",
    reactions: null,
    impressions: 40,
  });
  assert.equal(result.success, true);
});

test("postStatIngestRowSchema rejects a malformed captured_on", () => {
  const result = postStatIngestRowSchema.safeParse({
    publish_target_id: "11111111-1111-1111-1111-111111111111",
    captured_on: "11/04/2026",
  });
  assert.equal(result.success, false);
});

test("isAuthorizedStatsIngestRequest accepts the exact bearer token", () => {
  const request = new Request("http://localhost/api/post-stats", { headers: { authorization: "Bearer secret-token" } });
  assert.equal(isAuthorizedStatsIngestRequest(request, "secret-token"), true);
});

test("isAuthorizedStatsIngestRequest rejects a wrong token", () => {
  const request = new Request("http://localhost/api/post-stats", { headers: { authorization: "Bearer wrong" } });
  assert.equal(isAuthorizedStatsIngestRequest(request, "secret-token"), false);
});

test("isAuthorizedStatsIngestRequest rejects a missing Authorization header", () => {
  const request = new Request("http://localhost/api/post-stats");
  assert.equal(isAuthorizedStatsIngestRequest(request, "secret-token"), false);
});

test("isAuthorizedStatsIngestRequest rejects a non-Bearer scheme", () => {
  const request = new Request("http://localhost/api/post-stats", { headers: { authorization: "secret-token" } });
  assert.equal(isAuthorizedStatsIngestRequest(request, "secret-token"), false);
});

const TEST_DB = process.env.POST_STATS_TEST_DATABASE_URL;

describe("post-stats (database)", { skip: TEST_DB ? false : "set POST_STATS_TEST_DATABASE_URL to run" }, () => {
  let mod: {
    db: typeof import("@/db/client").db;
    schema: typeof import("@/db/schema");
    postStats: typeof import("./post-stats");
    sql: typeof import("drizzle-orm").sql;
    eq: typeof import("drizzle-orm").eq;
  };

  before(async () => {
    process.env.DATABASE_URL = TEST_DB;
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const migrationClient = postgres(TEST_DB!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(migrationClient), { migrationsFolder: `${process.cwd()}/drizzle` });
    await migrationClient.end();

    const { db } = await import("@/db/client");
    const { sql, eq } = await import("drizzle-orm");
    mod = { db, schema: await import("@/db/schema"), postStats: await import("./post-stats"), sql, eq };
  });

  after(async () => {
    await (mod?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end();
  });

  let articleId: string;
  let pinterestConnectionId: string;
  let linkedinConnectionId: string;

  beforeEach(async () => {
    const { db, schema, sql } = mod;
    await db.execute(
      sql`truncate table post_stats, publish_targets, content_items, platform_connections, article_extractions, articles cascade`,
    );

    const [article] = await db
      .insert(schema.articles)
      .values({
        shopifyArticleId: "test-article-1",
        shopifyBlogId: "test-blog",
        title: "Test Article",
        handle: "test-article",
        bodyHtml: "<p>body</p>",
        contentHash: "hash-1",
        shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    articleId = article!.id;

    const [pinterestConnection] = await db
      .insert(schema.platformConnections)
      .values({
        platform: "pinterest",
        externalAccountId: "test-account",
        displayName: "Test Pinterest",
        accessTokenVaultId: "00000000-0000-0000-0000-000000000000",
      })
      .returning();
    pinterestConnectionId = pinterestConnection!.id;

    const [linkedinConnection] = await db
      .insert(schema.platformConnections)
      .values({
        platform: "linkedin",
        externalAccountId: "urn:li:organization:1",
        displayName: "Test LinkedIn Page",
        accessTokenVaultId: "00000000-0000-0000-0000-000000000000",
      })
      .returning();
    linkedinConnectionId = linkedinConnection!.id;
  });

  async function publishedTarget(opts: {
    platform: "pinterest" | "linkedin";
    publishedAt: Date;
    externalPostUrl?: string;
    externalPostId?: string;
  }) {
    const { db, schema } = mod;
    const connectionId = opts.platform === "pinterest" ? pinterestConnectionId : linkedinConnectionId;
    const contentType = opts.platform === "pinterest" ? "pinterest_pin" : "linkedin_post";
    const copyFields =
      opts.platform === "pinterest"
        ? { title: "t", description: "d", altText: "a", suggestedBoard: "b", imageConcept: "c" }
        : { postText: "p", angle: "a", cta: "c" };

    const [item] = await db
      .insert(schema.contentItems)
      .values({ articleId, platform: opts.platform, contentType, copyFields, status: "published" })
      .returning();

    const [target] = await db
      .insert(schema.publishTargets)
      .values({
        contentItemId: item!.id,
        platformConnectionId: connectionId,
        scheduledAt: opts.publishedAt,
        status: "published",
        publishedAt: opts.publishedAt,
        externalPostId: opts.externalPostId ?? "ext-1",
        externalPostUrl: opts.externalPostUrl ?? "https://example.com/post/1",
      })
      .returning();
    return target!;
  }

  test("listPendingPostStats includes a published post older than 3 days with no prior capture", async () => {
    const { db, postStats } = mod;
    const now = new Date("2026-11-10T00:00:00Z");
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-11-05T00:00:00Z") });

    const pending = await postStats.listPendingPostStats(db, { now });
    assert.deepEqual(
      pending.map((p) => p.publishTargetId),
      [target.id],
    );
    assert.equal(pending[0]!.lastCapturedOn, null);
  });

  test("listPendingPostStats excludes a post published less than 3 days ago", async () => {
    const { db, postStats } = mod;
    const now = new Date("2026-11-10T00:00:00Z");
    await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-11-09T00:00:00Z") });

    const pending = await postStats.listPendingPostStats(db, { now });
    assert.deepEqual(pending, []);
  });

  test("listPendingPostStats excludes a post captured within the last 7 days", async () => {
    const { db, schema, postStats } = mod;
    const now = new Date("2026-11-10T00:00:00Z");
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-20T00:00:00Z") });
    await db.insert(schema.postStats).values({
      publishTargetId: target.id,
      platform: "pinterest",
      externalPostId: target.externalPostId!,
      capturedOn: "2026-11-06", // 4 days before `now` — within the 7-day window
      impressions: 10,
    });

    const pending = await postStats.listPendingPostStats(db, { now });
    assert.deepEqual(pending, []);
  });

  test("listPendingPostStats includes a post captured more than 7 days ago", async () => {
    const { db, schema, postStats } = mod;
    const now = new Date("2026-11-10T00:00:00Z");
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-01T00:00:00Z") });
    await db.insert(schema.postStats).values({
      publishTargetId: target.id,
      platform: "pinterest",
      externalPostId: target.externalPostId!,
      capturedOn: "2026-10-20", // 21 days before `now`
      impressions: 10,
    });

    const pending = await postStats.listPendingPostStats(db, { now });
    assert.deepEqual(
      pending.map((p) => p.publishTargetId),
      [target.id],
    );
    assert.equal(pending[0]!.lastCapturedOn, "2026-10-20");
  });

  test("listPendingPostStats filters by platform", async () => {
    const { db, postStats } = mod;
    const now = new Date("2026-11-10T00:00:00Z");
    const pin = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-01T00:00:00Z") });
    await publishedTarget({ platform: "linkedin", publishedAt: new Date("2026-10-01T00:00:00Z") });

    const pending = await postStats.listPendingPostStats(db, { now, platform: "pinterest" });
    assert.deepEqual(
      pending.map((p) => p.publishTargetId),
      [pin.id],
    );
  });

  test("ingestPostStats inserts a new row for a target identified by publish_target_id", async () => {
    const { db, schema, postStats, eq } = mod;
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-01T00:00:00Z") });

    const result = await postStats.ingestPostStats(db, [
      { publish_target_id: target.id, impressions: 500, saves: 20, clicks: 8, outbound_clicks: 3, captured_on: "2026-11-05" },
    ]);
    assert.deepEqual(result, { inserted: 1, updated: 0, rejected: [] });

    const [row] = await db.select().from(schema.postStats).where(eq(schema.postStats.publishTargetId, target.id));
    assert.equal(row!.impressions, 500);
    assert.equal(row!.outboundClicks, 3);
    assert.equal(row!.capturedOn, "2026-11-05");
  });

  test("ingestPostStats resolves a target by external_post_url", async () => {
    const { db, postStats } = mod;
    const target = await publishedTarget({
      platform: "linkedin",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
      externalPostUrl: "https://www.linkedin.com/feed/update/urn:li:share:999/",
    });

    const result = await postStats.ingestPostStats(db, [
      { external_post_url: "https://www.linkedin.com/feed/update/urn:li:share:999/", reactions: 10, comments: 2, reposts: 1 },
    ]);
    assert.deepEqual(result, { inserted: 1, updated: 0, rejected: [] });
    void target;
  });

  test("ingestPostStats upserts on (publish_target_id, captured_on) — a second capture the same day updates, not duplicates", async () => {
    const { db, schema, postStats, eq } = mod;
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-01T00:00:00Z") });

    const first = await postStats.ingestPostStats(db, [
      { publish_target_id: target.id, impressions: 100, captured_on: "2026-11-05" },
    ]);
    assert.deepEqual(first, { inserted: 1, updated: 0, rejected: [] });

    const second = await postStats.ingestPostStats(db, [
      { publish_target_id: target.id, impressions: 250, captured_on: "2026-11-05" },
    ]);
    assert.deepEqual(second, { inserted: 0, updated: 1, rejected: [] });

    const rows = await db.select().from(schema.postStats).where(eq(schema.postStats.publishTargetId, target.id));
    assert.equal(rows.length, 1, "no duplicate row for the same (publish_target_id, captured_on)");
    assert.equal(rows[0]!.impressions, 250);
  });

  test("ingestPostStats keeps a different day's capture as its own history row", async () => {
    const { db, schema, postStats, eq } = mod;
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-01T00:00:00Z") });

    await postStats.ingestPostStats(db, [{ publish_target_id: target.id, impressions: 100, captured_on: "2026-11-04" }]);
    await postStats.ingestPostStats(db, [{ publish_target_id: target.id, impressions: 150, captured_on: "2026-11-05" }]);

    const rows = await db.select().from(schema.postStats).where(eq(schema.postStats.publishTargetId, target.id));
    assert.equal(rows.length, 2);
  });

  test("ingestPostStats rejects an unknown publish_target_id with a reason, without touching other rows in the batch", async () => {
    const { db, postStats } = mod;
    const target = await publishedTarget({ platform: "pinterest", publishedAt: new Date("2026-10-01T00:00:00Z") });

    const result = await postStats.ingestPostStats(db, [
      { publish_target_id: target.id, impressions: 100, captured_on: "2026-11-05" },
      { publish_target_id: "99999999-9999-9999-9999-999999999999", impressions: 1 },
    ]);
    assert.equal(result.inserted, 1);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /no publish_target found/);
  });

  test("ingestPostStats rejects a malformed row with a validation reason", async () => {
    const { db, postStats } = mod;
    const result = await postStats.ingestPostStats(db, [{ impressions: -1 }]);
    assert.equal(result.inserted, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.rejected.length, 1);
  });

  test("ingestPostStats rejects a non-array body", async () => {
    const { db, postStats } = mod;
    const result = await postStats.ingestPostStats(db, { not: "an array" });
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /JSON array/);
  });
});
