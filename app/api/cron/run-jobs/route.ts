import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { articleExtractions, articles, contentAssets, contentItems, jobs, platformEnum } from "@/db/schema";
import { createAnthropicClient, extractArticle } from "@/lib/anthropic";
import { requireEnv } from "@/lib/env";
import { CONTENT_TYPE_BY_PLATFORM, generatePlatformContent, groundPosts } from "@/lib/generation";
import { claimDueJobs, enqueueJob, markJobFailed, markJobSucceeded } from "@/lib/jobs";
import { selectAssetForArticle } from "@/lib/assets";
import { renderPinterestPin, resolveImageSrc } from "@/lib/render";
import type { PinterestTemplateId } from "@/lib/templates/pinterest";
import { uploadRenderedImage } from "@/lib/storage";

export const runtime = "nodejs";

class NonRetryableJobError extends Error {}

type Job = typeof jobs.$inferSelect;
type Platform = (typeof platformEnum.enumValues)[number];

async function runExtractArticle(job: Job) {
  const { articleId } = job.payload as { articleId: string };
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!article) {
    throw new NonRetryableJobError(`Article ${articleId} not found`);
  }

  const { ANTHROPIC_API_KEY } = requireEnv("ANTHROPIC_API_KEY");
  const client = createAnthropicClient(ANTHROPIC_API_KEY);
  const extraction = await extractArticle(client, article.title, article.bodyHtml);

  const [inserted] = await db
    .insert(articleExtractions)
    .values({
      articleId: article.id,
      coreSubject: extraction.coreSubject,
      audience: extraction.audience,
      searchIntent: extraction.searchIntent,
      keyTakeaways: extraction.keyTakeaways,
      supportedClaims: extraction.supportedClaims,
      modelUsed: "claude-sonnet-5",
    })
    .returning();
  if (!inserted) {
    throw new Error("Insert into article_extractions returned no row");
  }
  await db.update(articles).set({ status: "processed" }).where(eq(articles.id, article.id));

  // Fan out one generate_content job per platform — copy generation for
  // all four happens regardless of which platforms can auto-publish yet
  // (LinkedIn copy still has value even though V1 publishes it manually,
  // per docs/PHASE_0_PLAN.md §2).
  for (const platform of platformEnum.enumValues) {
    await enqueueJob(db, "generate_content", { articleId: article.id, extractionId: inserted.id, platform });
  }
}

async function runGenerateContent(job: Job) {
  const { articleId, extractionId, platform } = job.payload as {
    articleId: string;
    extractionId: string;
    platform: Platform;
  };

  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!article) {
    throw new NonRetryableJobError(`Article ${articleId} not found`);
  }
  const [extraction] = await db
    .select()
    .from(articleExtractions)
    .where(eq(articleExtractions.id, extractionId))
    .limit(1);
  if (!extraction) {
    throw new NonRetryableJobError(`Extraction ${extractionId} not found`);
  }

  const { ANTHROPIC_API_KEY } = requireEnv("ANTHROPIC_API_KEY");
  const client = createAnthropicClient(ANTHROPIC_API_KEY);

  const posts = await generatePlatformContent(client, platform, article.title, {
    coreSubject: extraction.coreSubject,
    audience: extraction.audience,
    searchIntent: extraction.searchIntent,
    keyTakeaways: extraction.keyTakeaways as string[],
    supportedClaims: extraction.supportedClaims as string[],
  });

  const flaggedClaimsByPost = await groundPosts(
    client,
    platform,
    posts,
    extraction.supportedClaims as string[],
  );

  const contentType = CONTENT_TYPE_BY_PLATFORM[platform];
  const insertedItems = await db
    .insert(contentItems)
    .values(
      posts.map((post, i) => ({
        articleId: article.id,
        platform,
        contentType,
        copyFields: { ...post, flaggedClaims: flaggedClaimsByPost[i] ?? [] },
        status: "in_review" as const,
      })),
    )
    .returning();

  // Only Pinterest has a template/compositor implemented so far — see
  // runRenderImage below. Other platforms' visual concepts stay
  // text-only in copyFields until their templates exist.
  if (platform === "pinterest") {
    for (const row of insertedItems) {
      await enqueueJob(db, "render_image", { contentItemId: row.id });
    }
  }
}

async function runRenderImage(job: Job) {
  const { contentItemId, templateId } = job.payload as { contentItemId: string; templateId?: PinterestTemplateId };
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId)).limit(1);
  if (!item) {
    throw new NonRetryableJobError(`content_item ${contentItemId} not found`);
  }
  if (item.platform !== "pinterest" || item.contentType !== "pinterest_pin") {
    throw new NonRetryableJobError(`render_image has no template for ${item.platform}/${item.contentType} yet`);
  }

  const [article] = await db.select().from(articles).where(eq(articles.id, item.articleId)).limit(1);
  if (!article) {
    throw new NonRetryableJobError(`article ${item.articleId} not found`);
  }

  const chosenTemplateId: PinterestTemplateId = templateId ?? "photo-full-bleed";
  const asset = await selectAssetForArticle(db, article.tags);

  if (!asset) {
    // No approved photo tags to this article — surfaced in the review
    // UI as "needs an approved photo," not silently skipped or replaced
    // with an AI-generated visual (docs/PHASE_0_PLAN.md brand rule).
    await db.insert(contentAssets).values({
      contentItemId: item.id,
      sourceType: "asset_library",
      templateId: chosenTemplateId,
      status: "needs_asset",
    });
    return;
  }

  const copy = item.copyFields as { title: string; description: string };
  const imageSrc = await resolveImageSrc(asset.fileUrl);
  const png = await renderPinterestPin(chosenTemplateId, {
    title: copy.title,
    description: copy.description,
    imageSrc,
  });

  const fileUrl = await uploadRenderedImage(png, `pinterest/${item.id}-${Date.now()}.png`);

  await db.insert(contentAssets).values({
    contentItemId: item.id,
    sourceType: "asset_library",
    sourceAssetId: asset.id,
    templateId: chosenTemplateId,
    renderParams: { title: copy.title, description: copy.description },
    fileUrl,
    status: "rendered",
  });
}

async function dispatch(job: Job) {
  switch (job.jobType) {
    case "extract_article":
      return runExtractArticle(job);
    case "generate_content":
      return runGenerateContent(job);
    case "render_image":
      return runRenderImage(job);
    case "publish_post":
    case "refresh_token":
      // Not yet built — see docs/PHASE_0_PLAN.md Phase 1 milestones.
      throw new NonRetryableJobError(`Job type '${job.jobType}' has no handler yet`);
    default:
      throw new NonRetryableJobError(`Unknown job type '${job.jobType}'`);
  }
}

export async function POST(request: Request) {
  const { CRON_SECRET } = requireEnv("CRON_SECRET");
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const claimed = await claimDueJobs(db, 5);
  const results = [];

  for (const job of claimed) {
    try {
      await dispatch(job);
      await markJobSucceeded(db, job.id);
      results.push({ id: job.id, jobType: job.jobType, outcome: "succeeded" });
    } catch (error) {
      const nonRetryable = error instanceof NonRetryableJobError;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await markJobFailed(db, job, message, nonRetryable);
      results.push({ id: job.id, jobType: job.jobType, outcome, error: message });
    }
  }

  return Response.json({ claimed: claimed.length, results });
}
