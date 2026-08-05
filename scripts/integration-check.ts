// One-off integration check against a real local Postgres — not part of
// the app, not committed to run in CI. Exercises the webhook route, job
// queue, and review actions against real DB round-trips instead of just
// type-checking them. Run with:
//   DATABASE_URL=... SHOPIFY_WEBHOOK_SECRET=... CRON_SECRET=... \
//     npx tsx scripts/integration-check.ts
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import assert from "node:assert/strict";

import { Resvg } from "@resvg/resvg-js";
import { db } from "../src/db/client";
import { articles, assetLibrary, contentAssets, contentItems, jobs, platformConnections, publishTargets } from "../src/db/schema";
import { POST as webhookPost } from "../app/api/webhooks/shopify/articles/route";
import { POST as cronPost } from "../app/api/cron/run-jobs/route";
import { approveContentItem, updateContentItemCopy } from "../app/review/actions";
import { enqueueJob } from "../src/lib/jobs";

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET!;
const CRON_SECRET = process.env.CRON_SECRET!;

function sign(body: string) {
  return createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64");
}

// Server actions call revalidatePath(), which requires Next's request
// context — absent when invoking the action function directly outside
// the Next server, as this script does. The DB mutation itself already
// completed (awaited) before revalidatePath runs, so this is a harness
// artifact, not a real failure — swallow only this specific error.
async function runAction(fn: (formData: FormData) => Promise<void>, formData: FormData) {
  try {
    await fn(formData);
  } catch (err) {
    if (err instanceof Error && err.message.includes("static generation store missing")) {
      return;
    }
    throw err;
  }
}

function webhookRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  return new Request("http://localhost/api/webhooks/shopify/articles", {
    method: "POST",
    headers: { "x-shopify-hmac-sha256": sign(body) },
    body,
  });
}

async function main() {
  console.log("--- 1. webhook: create ---");
  const articleId = 999001;
  const basePayload = {
    id: articleId,
    blog_id: 52721614986,
    title: "Integration Test Article",
    handle: "integration-test-article",
    body_html: "<p>Version one of the body.</p>",
    tags: "test, integration",
    published_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const createRes = await webhookPost(webhookRequest(basePayload));
  const createJson = await createRes.json();
  console.log(createJson);
  assert.equal(createRes.status, 200);
  assert.equal(createJson.status, "created");
  assert.equal(createJson.extractionQueued, true);

  console.log("--- 2. webhook: duplicate delivery (unchanged) ---");
  const dupRes = await webhookPost(webhookRequest(basePayload));
  const dupJson = await dupRes.json();
  console.log(dupJson);
  assert.equal(dupJson.status, "unchanged");
  assert.equal(dupJson.extractionQueued, false);

  console.log("--- 3. webhook: real content change (updated) ---");
  const updatedPayload = { ...basePayload, body_html: "<p>Version TWO — actually different content.</p>" };
  const updateRes = await webhookPost(webhookRequest(updatedPayload));
  const updateJson = await updateRes.json();
  console.log(updateJson);
  assert.equal(updateJson.status, "updated");
  assert.equal(updateJson.extractionQueued, true);

  console.log("--- 4. verify exactly 2 extract_article jobs enqueued (create + real update) ---");
  const [articleRow] = await db.select().from(articles).where(eq(articles.shopifyArticleId, String(articleId))).limit(1);
  assert.ok(articleRow, "article row should exist");
  const allJobs = await db.select().from(jobs);
  const extractJobs = allJobs.filter((j) => j.jobType === "extract_article");
  console.log(`extract_article jobs: ${extractJobs.length}`);
  assert.equal(extractJobs.length, 2);

  console.log("--- 5. cron auth rejection ---");
  const unauthed = await cronPost(
    new Request("http://localhost/api/cron/run-jobs", { method: "POST", headers: { authorization: "Bearer wrong" } }),
  );
  assert.equal(unauthed.status, 401);
  console.log("401 as expected");

  console.log("--- 6. cron: unimplemented job type fails_final without crashing the run ---");
  await db.insert(jobs).values({ jobType: "publish_post", payload: { note: "no handler yet" } });
  const cronRes = await cronPost(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  const cronJson = await cronRes.json();
  console.log(cronJson);
  assert.ok(cronJson.claimed >= 1);
  const publishResult = cronJson.results.find((r: { jobType: string }) => r.jobType === "publish_post");
  assert.equal(publishResult.outcome, "failed_final");

  console.log("--- 7. review actions against a real content_item + publish_target ---");
  const [connection] = await db
    .insert(platformConnections)
    .values({
      platform: "pinterest",
      externalAccountId: "test-account",
      displayName: "Test Pinterest",
      accessTokenVaultId: "00000000-0000-0000-0000-000000000000",
    })
    .returning();
  const [item] = await db
    .insert(contentItems)
    .values({
      articleId: articleRow.id,
      platform: "pinterest",
      contentType: "pinterest_pin",
      copyFields: { title: "Original Title", description: "Original description", suggestedBoard: "Ideas", imageConcept: "concept", flaggedClaims: [] },
      status: "in_review",
    })
    .returning();
  assert.ok(item && connection);

  const approveForm = new FormData();
  approveForm.set("id", item.id);
  await runAction(approveContentItem, approveForm);
  const [afterApprove] = await db.select().from(contentItems).where(eq(contentItems.id, item.id)).limit(1);
  assert.equal(afterApprove.status, "approved");
  console.log("approved ->", afterApprove.status);

  const [publishTarget] = await db
    .insert(publishTargets)
    .values({
      contentItemId: item.id,
      platformConnectionId: connection.id,
      scheduledAt: new Date(Date.now() + 86_400_000),
      status: "scheduled",
    })
    .returning();
  assert.ok(publishTarget);

  const editForm = new FormData();
  editForm.set("id", item.id);
  editForm.set("field:title", "Edited Title After Approval");
  await runAction(updateContentItemCopy, editForm);

  const [afterEdit] = await db.select().from(contentItems).where(eq(contentItems.id, item.id)).limit(1);
  console.log("after edit -> status:", afterEdit.status, "version:", afterEdit.version, "title:", (afterEdit.copyFields as { title: string }).title);
  assert.equal(afterEdit.status, "in_review", "editing an approved item must revert it to in_review");
  assert.equal(afterEdit.version, 2, "version must increment on edit");
  assert.equal((afterEdit.copyFields as { title: string }).title, "Edited Title After Approval");

  const [publishTargetAfter] = await db.select().from(publishTargets).where(eq(publishTargets.id, publishTarget.id)).limit(1);
  console.log("publish target status after edit:", publishTargetAfter.status);
  assert.equal(publishTargetAfter.status, "canceled", "editing an approved item must cancel its pending publish");

  console.log("--- 8. render_image: empty asset library flags needs_asset, doesn't fail the job ---");
  await enqueueJob(db, "render_image", { contentItemId: item.id });
  const cronRes8a = await cronPost(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  const cronJson8a = await cronRes8a.json();
  const renderJob8a = cronJson8a.results.find((r: { jobType: string }) => r.jobType === "render_image");
  console.log(renderJob8a);
  assert.equal(renderJob8a.outcome, "succeeded", "an empty asset library should not fail the job");
  const [assetRow8a] = await db
    .select()
    .from(contentAssets)
    .where(eq(contentAssets.contentItemId, item.id))
    .orderBy(sql`created_at desc`)
    .limit(1);
  assert.equal(assetRow8a.status, "needs_asset");
  assert.equal(assetRow8a.fileUrl, null);
  console.log("content_assets row:", assetRow8a.status, "fileUrl:", assetRow8a.fileUrl);

  console.log("--- 9. render_image: matching asset renders a real PNG through Satori/resvg ---");
  const testPhotoSvg = `<svg width="1000" height="1500" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1500" fill="#7a4a2a"/></svg>`;
  const testPhotoPng = new Resvg(testPhotoSvg).render().asPng();
  const testPhotoDataUri = `data:image/png;base64,${testPhotoPng.toString("base64")}`;

  await db.insert(assetLibrary).values({
    fileUrl: testPhotoDataUri,
    tags: ["test"], // overlaps the article's "test" tag from step 1
    source: "manual_upload",
  });

  await enqueueJob(db, "render_image", { contentItemId: item.id });
  const cronRes9 = await cronPost(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  const cronJson9 = await cronRes9.json();
  const renderJob9 = cronJson9.results.find((r: { jobType: string }) => r.jobType === "render_image");
  console.log(renderJob9);
  // With no real SUPABASE_URL/SERVICE_ROLE_KEY in this environment, the
  // job reaches the storage upload and fails there — which is exactly
  // the right boundary: it confirms asset selection, image resolution,
  // and the actual Satori->resvg render all ran for real before hitting
  // the one step that genuinely needs Brendan's Supabase project.
  assert.equal(renderJob9.outcome, "failed_retryable");
  assert.match(renderJob9.error, /SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/);
  console.log("reached storage upload as expected, failed only on missing Supabase credentials");

  console.log("\nALL INTEGRATION CHECKS PASSED");
}

main()
  .catch((err) => {
    console.error("INTEGRATION CHECK FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
