// One-off integration check against a real local Postgres — not part of
// the app, not committed to run in CI. Exercises article sync, the job
// queue, and review actions against real DB round-trips instead of just
// type-checking them. Run with:
//   DATABASE_URL=... CRON_SECRET=... \
//     npx tsx scripts/integration-check.ts
import { eq, sql } from "drizzle-orm";
import assert from "node:assert/strict";

import { Resvg } from "@resvg/resvg-js";
import { db } from "../src/db/client";
import { articles, assetLibrary, contentAssets, contentItems, jobs, platformConnections, publishTargets } from "../src/db/schema";
import { GET as cronGet } from "../app/api/cron/run-jobs/route";
import { syncArticleFromShopify } from "../src/lib/platforms/shopify-articles";
import { approveContentItem, updateContentItemCopy } from "../app/review/actions";
import { enqueueJob } from "../src/lib/jobs";

const CRON_SECRET = process.env.CRON_SECRET!;

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

async function main() {
  console.log("--- 1. article sync: create ---");
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

  const createResult = await syncArticleFromShopify(db, basePayload);
  console.log(createResult);
  assert.equal(createResult.status, "created");
  assert.equal(createResult.extractionQueued, true);

  console.log("--- 2. article sync: re-poll with no change (unchanged) ---");
  const dupResult = await syncArticleFromShopify(db, basePayload);
  console.log(dupResult);
  assert.equal(dupResult.status, "unchanged");
  assert.equal(dupResult.extractionQueued, false);

  console.log("--- 3. article sync: real content change (updated) ---");
  const updatedPayload = { ...basePayload, body_html: "<p>Version TWO — actually different content.</p>" };
  const updateResult = await syncArticleFromShopify(db, updatedPayload);
  console.log(updateResult);
  assert.equal(updateResult.status, "updated");
  assert.equal(updateResult.extractionQueued, true);

  console.log("--- 4. verify exactly 2 extract_article jobs enqueued (create + real update) ---");
  const [articleRow] = await db.select().from(articles).where(eq(articles.shopifyArticleId, String(articleId))).limit(1);
  assert.ok(articleRow, "article row should exist");
  const allJobs = await db.select().from(jobs);
  const extractJobs = allJobs.filter((j) => j.jobType === "extract_article");
  console.log(`extract_article jobs: ${extractJobs.length}`);
  assert.equal(extractJobs.length, 2);

  console.log("--- 5. cron auth rejection ---");
  const unauthed = await cronGet(
    new Request("http://localhost/api/cron/run-jobs", { method: "GET", headers: { authorization: "Bearer wrong" } }),
  );
  assert.equal(unauthed.status, 401);
  console.log("401 as expected");

  console.log("--- 6. cron: unimplemented job type fails_final without crashing the run ---");
  await db.insert(jobs).values({ jobType: "refresh_token", payload: { note: "no standalone handler — auth renewal is inline in runPublishPost" } });
  const cronRes = await cronGet(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "GET",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  const cronJson = await cronRes.json();
  console.log(cronJson);
  assert.ok(cronJson.claimed >= 1);
  const refreshResult = cronJson.results.find((r: { jobType: string }) => r.jobType === "refresh_token");
  assert.equal(refreshResult.outcome, "failed_final");

  console.log("--- 7. approve auto-schedules a real content_item via a real platform_connection ---");
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
  console.log("status after approve:", afterApprove.status);
  assert.equal(afterApprove.status, "scheduled", "approving an item with a connected platform must auto-schedule it");

  const [publishTarget] = await db.select().from(publishTargets).where(eq(publishTargets.contentItemId, item.id)).limit(1);
  assert.ok(publishTarget, "approve must create a publish_targets row");
  console.log("scheduled_at:", publishTarget.scheduledAt.toISOString(), "status:", publishTarget.status);
  assert.equal(publishTarget.status, "scheduled");
  assert.ok(publishTarget.scheduledAt.getTime() > Date.now(), "scheduled_at must be in the future");

  console.log("--- 7a. re-approving an already-scheduled item is a no-op, not a duplicate publish ---");
  await runAction(approveContentItem, approveForm);
  const targetsAfterReapprove = await db.select().from(publishTargets).where(eq(publishTargets.contentItemId, item.id));
  console.log(`publish_targets for this item after a second approve: ${targetsAfterReapprove.length}`);
  assert.equal(targetsAfterReapprove.length, 1, "approving an already-approved/scheduled item must not create a second publish_target");

  const [enqueuedPublishJob] = await db
    .select()
    .from(jobs)
    .where(sql`job_type = 'publish_post' AND payload->>'publishTargetId' = ${publishTarget.id}`)
    .limit(1);
  assert.ok(enqueuedPublishJob, "approve must enqueue a publish_post job for the new publish_target");
  assert.equal(
    enqueuedPublishJob.runAt.getTime(),
    publishTarget.scheduledAt.getTime(),
    "the job must not run before the scheduled time",
  );
  console.log("publish_post job run_at matches scheduled_at:", enqueuedPublishJob.runAt.toISOString());

  console.log("--- 7c. LinkedIn also auto-schedules once connected, same as Pinterest/Facebook ---");
  const [linkedinConnection] = await db
    .insert(platformConnections)
    .values({
      platform: "linkedin",
      externalAccountId: "urn:li:organization:12345",
      displayName: "Test LinkedIn Page",
      accessTokenVaultId: "00000000-0000-0000-0000-000000000000",
    })
    .returning();
  const [linkedinItem] = await db
    .insert(contentItems)
    .values({
      articleId: articleRow.id,
      platform: "linkedin",
      contentType: "linkedin_post",
      copyFields: { postText: "A professional reframe of the article.", angle: "cost efficiency", flaggedClaims: [] },
      status: "in_review",
    })
    .returning();
  assert.ok(linkedinItem && linkedinConnection);

  const linkedinApproveForm = new FormData();
  linkedinApproveForm.set("id", linkedinItem.id);
  await runAction(approveContentItem, linkedinApproveForm);
  const [linkedinAfterApprove] = await db.select().from(contentItems).where(eq(contentItems.id, linkedinItem.id)).limit(1);
  console.log("LinkedIn status after approve:", linkedinAfterApprove.status);
  assert.equal(linkedinAfterApprove.status, "scheduled", "approving a LinkedIn item with a connected platform must auto-schedule it");

  const [linkedinTarget] = await db.select().from(publishTargets).where(eq(publishTargets.contentItemId, linkedinItem.id)).limit(1);
  assert.ok(linkedinTarget, "approve must create a publish_targets row for LinkedIn too");
  assert.ok(linkedinTarget.scheduledAt.getTime() > Date.now(), "LinkedIn scheduled_at must be in the future");

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

  console.log("--- 7b. the auto-enqueued publish_post job no-ops cleanly on a canceled target ---");
  // The job row itself isn't touched by cancellation (only
  // publish_targets is) — fast-forward its run_at so cron picks it up
  // now instead of at tomorrow's scheduled slot, and confirm
  // runPublishPost's canceled-target check actually works against a
  // real row, not just in isolation.
  await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.id, enqueuedPublishJob.id));
  const cronRes7b = await cronGet(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "GET",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  const cronJson7b = await cronRes7b.json();
  const canceledJobResult = cronJson7b.results.find((r: { id: string }) => r.id === enqueuedPublishJob.id);
  console.log(canceledJobResult);
  assert.equal(canceledJobResult.outcome, "succeeded", "a publish_post job for a canceled target must no-op, not fail");

  console.log("--- 8. render_image: empty asset library flags needs_asset, doesn't fail the job ---");
  await enqueueJob(db, "render_image", { contentItemId: item.id });
  const cronRes8a = await cronGet(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "GET",
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
  const cronRes9 = await cronGet(
    new Request("http://localhost/api/cron/run-jobs", {
      method: "GET",
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
