import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  articleExtractions,
  articles,
  contentAssets,
  contentItems,
  jobs,
  platformConnections,
  platformEnum,
  publishLog,
  publishTargets,
} from "@/db/schema";
import { createAnthropicClient, extractArticle } from "@/lib/anthropic";
import { articlePublicUrl } from "@/lib/article-url";
import { requireEnv } from "@/lib/env";
import { CONTENT_TYPE_BY_PLATFORM, generatePlatformContent, groundPosts } from "@/lib/generation";
import { claimDueJobs, enqueueJob, markJobFailed, markJobSucceeded } from "@/lib/jobs";
import { PlatformAuthError, PlatformValidationError } from "@/lib/platforms/errors";
import { createOrganizationPost, refreshLinkedInToken } from "@/lib/platforms/linkedin";
import { createInstagramCarousel, createPagePost, refreshMetaUserToken } from "@/lib/platforms/meta";
import { createPin, findOrCreateBoard, refreshPinterestToken } from "@/lib/platforms/pinterest";
import { selectAssetForArticle, selectAssetsForArticle } from "@/lib/assets";
import { renderInstagramSlide, renderPinterestPin, resolveImageSrc } from "@/lib/render";
import type { PinterestTemplateId } from "@/lib/templates/pinterest";
import { uploadRenderedImage } from "@/lib/storage";
import { readSecret, updateSecret } from "@/lib/vault";

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

  // Only Pinterest and Instagram have templates/compositors implemented
  // so far — see runRenderImage below. Facebook and LinkedIn's visual
  // concepts stay text-only in copyFields (Facebook doesn't need a
  // rendered image at all; LinkedIn has no publish path yet in V1).
  if (platform === "pinterest" || platform === "instagram") {
    for (const row of insertedItems) {
      await enqueueJob(db, "render_image", { contentItemId: row.id });
    }
  }
}

type ContentItemRow = typeof contentItems.$inferSelect;
type ArticleRow = typeof articles.$inferSelect;

async function renderPinterestPinItem(item: ContentItemRow, article: ArticleRow, templateId?: PinterestTemplateId) {
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

async function renderInstagramCarouselItem(item: ContentItemRow, article: ArticleRow) {
  const copy = item.copyFields as { caption: string; slides: string[] };
  const assets = await selectAssetsForArticle(db, article.tags, copy.slides.length);

  if (assets.length === 0) {
    // Same brand rule as Pinterest: no approved photo for this article
    // means "needs an approved photo," never an AI-rendered stand-in.
    await db.insert(contentAssets).values({
      contentItemId: item.id,
      sourceType: "asset_library",
      status: "needs_asset",
    });
    return;
  }

  // Fewer approved photos than slides is common (the library starts
  // thin) — cycle through what's available rather than failing, so a
  // 5-slide carousel with 2 matching photos still renders instead of
  // getting stuck behind a library gap.
  for (let i = 0; i < copy.slides.length; i++) {
    const asset = assets[i % assets.length]!;
    const slideText = copy.slides[i]!;
    const imageSrc = await resolveImageSrc(asset.fileUrl);
    const png = await renderInstagramSlide({ slideText, imageSrc, slideIndex: i, slideCount: copy.slides.length });
    const fileUrl = await uploadRenderedImage(png, `instagram/${item.id}-${i}-${Date.now()}.png`);

    await db.insert(contentAssets).values({
      contentItemId: item.id,
      sourceType: "asset_library",
      sourceAssetId: asset.id,
      renderParams: { slideIndex: i, slideText },
      fileUrl,
      status: "rendered",
    });
  }
}

async function runRenderImage(job: Job) {
  const { contentItemId, templateId } = job.payload as { contentItemId: string; templateId?: PinterestTemplateId };
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId)).limit(1);
  if (!item) {
    throw new NonRetryableJobError(`content_item ${contentItemId} not found`);
  }

  const [article] = await db.select().from(articles).where(eq(articles.id, item.articleId)).limit(1);
  if (!article) {
    throw new NonRetryableJobError(`article ${item.articleId} not found`);
  }

  if (item.platform === "pinterest" && item.contentType === "pinterest_pin") {
    return renderPinterestPinItem(item, article, templateId);
  }
  if (item.platform === "instagram" && item.contentType === "ig_carousel") {
    return renderInstagramCarouselItem(item, article);
  }
  throw new NonRetryableJobError(`render_image has no template for ${item.platform}/${item.contentType} yet`);
}

type PlatformConnectionRow = typeof platformConnections.$inferSelect;

// contentItems.status mirrors the publish outcome once it's terminal
// (published or permanently failed) so the Review/Scheduled screens —
// which filter on contentItems.status, not publishTargets.status — stop
// showing an item the moment it's actually done, one way or the other.
async function finalizePublished(publishTargetId: string, contentItemId: string, result: { id: string; url: string }) {
  await db
    .update(publishTargets)
    .set({ status: "published", publishedAt: new Date(), externalPostId: result.id, externalPostUrl: result.url })
    .where(eq(publishTargets.id, publishTargetId));
  await db.update(contentItems).set({ status: "published" }).where(eq(contentItems.id, contentItemId));
  await db.insert(publishLog).values({
    publishTargetId,
    eventType: "published",
    detail: { externalPostId: result.id, externalPostUrl: result.url },
  });
}

async function handleNonAuthFailure(publishTargetId: string, contentItemId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  // A validation error (bad request shape, rejected content) won't
  // improve on retry — a 5xx/network error might, so it stays
  // failed_retrying and the job's normal backoff schedule tries again.
  // Only the terminal "failed" case flips contentItems.status too —
  // failed_retrying is still an active, still-queued state as far as
  // the Scheduled screen is concerned.
  const isTerminal = err instanceof PlatformValidationError;
  const status = isTerminal ? "failed" : "failed_retrying";
  await db.update(publishTargets).set({ status, errorMessage: message }).where(eq(publishTargets.id, publishTargetId));
  if (isTerminal) {
    await db.update(contentItems).set({ status: "failed" }).where(eq(contentItems.id, contentItemId));
  }
  await db.insert(publishLog).values({ publishTargetId, eventType: "failed", detail: { message } });
}

// Exactly one refresh attempt per docs/PHASE_0_PLAN.md §5 — returns the
// new access token on success, or null if refresh doesn't apply / fails,
// which the caller treats as "give up, mark expired."
async function attemptRefresh(connection: PlatformConnectionRow): Promise<string | null> {
  if (connection.platform === "pinterest") {
    if (!connection.refreshTokenVaultId) return null;
    const { PINTEREST_APP_ID, PINTEREST_APP_SECRET } = requireEnv("PINTEREST_APP_ID", "PINTEREST_APP_SECRET");
    const refreshToken = await readSecret(db, connection.refreshTokenVaultId);
    const tokens = await refreshPinterestToken(PINTEREST_APP_ID, PINTEREST_APP_SECRET, refreshToken);
    await updateSecret(db, connection.accessTokenVaultId, tokens.access_token);
    await updateSecret(db, connection.refreshTokenVaultId, tokens.refresh_token);
    await db
      .update(platformConnections)
      .set({ expiresAt: new Date(Date.now() + tokens.expires_in * 1000) })
      .where(eq(platformConnections.id, connection.id));
    return tokens.access_token;
  }
  if (connection.platform === "facebook" || connection.platform === "instagram") {
    const { META_APP_ID, META_APP_SECRET } = requireEnv("META_APP_ID", "META_APP_SECRET");
    const currentToken = await readSecret(db, connection.accessTokenVaultId);
    const refreshed = await refreshMetaUserToken(META_APP_ID, META_APP_SECRET, currentToken);
    await updateSecret(db, connection.accessTokenVaultId, refreshed.access_token);
    return refreshed.access_token;
  }
  if (connection.platform === "linkedin") {
    // No refresh_token stored means this connection's app grant doesn't
    // include refresh access — same "give up, mark expired" outcome as
    // any other unrefreshable connection, not a special case here.
    if (!connection.refreshTokenVaultId) return null;
    const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET } = requireEnv("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET");
    const refreshToken = await readSecret(db, connection.refreshTokenVaultId);
    const tokens = await refreshLinkedInToken(LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, refreshToken);
    await updateSecret(db, connection.accessTokenVaultId, tokens.access_token);
    if (tokens.refresh_token) {
      await updateSecret(db, connection.refreshTokenVaultId, tokens.refresh_token);
    }
    await db
      .update(platformConnections)
      .set({ expiresAt: new Date(Date.now() + tokens.expires_in * 1000) })
      .where(eq(platformConnections.id, connection.id));
    return tokens.access_token;
  }
  return null;
}

async function runPublishPost(job: Job) {
  const { publishTargetId } = job.payload as { publishTargetId: string };
  const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, publishTargetId)).limit(1);
  if (!target) {
    throw new NonRetryableJobError(`publish_target ${publishTargetId} not found`);
  }
  if (target.status === "canceled") {
    return; // edited after scheduling — nothing to publish, not an error
  }

  // §5: independent of the job-level attempt budget, a publish_target
  // that's been due for over 24 hours without succeeding stops
  // auto-retrying — it needs Brendan's eyes, not another silent attempt.
  const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - target.scheduledAt.getTime() > STALE_AFTER_MS) {
    await db
      .update(publishTargets)
      .set({ status: "failed", errorMessage: "Stale: still unpublished 24h after its scheduled time" })
      .where(eq(publishTargets.id, target.id));
    await db.update(contentItems).set({ status: "failed" }).where(eq(contentItems.id, target.contentItemId));
    await db.insert(publishLog).values({
      publishTargetId: target.id,
      eventType: "failed",
      detail: { reason: "stale_over_24h" },
    });
    throw new NonRetryableJobError("publish_target stale (>24h past scheduled_at) — marked failed, needs attention");
  }

  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, target.contentItemId)).limit(1);
  if (!item) throw new NonRetryableJobError(`content_item ${target.contentItemId} not found`);
  const [article] = await db.select().from(articles).where(eq(articles.id, item.articleId)).limit(1);
  if (!article) throw new NonRetryableJobError(`article ${item.articleId} not found`);
  const [connection] = await db
    .select()
    .from(platformConnections)
    .where(eq(platformConnections.id, target.platformConnectionId))
    .limit(1);
  if (!connection) throw new NonRetryableJobError(`platform_connection ${target.platformConnectionId} not found`);

  const { SHOPIFY_SHOP_DOMAIN, SHOPIFY_BLOG_HANDLE } = requireEnv("SHOPIFY_SHOP_DOMAIN", "SHOPIFY_BLOG_HANDLE");
  const link = articlePublicUrl(SHOPIFY_SHOP_DOMAIN, SHOPIFY_BLOG_HANDLE, article.handle);

  await db.update(publishTargets).set({ status: "publishing" }).where(eq(publishTargets.id, target.id));

  const doPublish = async (accessToken: string) => {
    if (item.platform === "pinterest") {
      const [asset] = await db
        .select()
        .from(contentAssets)
        .where(and(eq(contentAssets.contentItemId, item.id), eq(contentAssets.status, "rendered")))
        .orderBy(desc(contentAssets.createdAt))
        .limit(1);
      if (!asset?.fileUrl) {
        // Plain Error, not NonRetryableJobError: this is meant to be a
        // transient race against render_image, which normally finishes
        // well before the scheduled publish time — retrying (up to
        // publish_post's normal backoff budget) gives it room to catch
        // up instead of dying on the very first attempt. If the real
        // cause is content_assets stuck at needs_asset (no approved
        // photo tag match), retrying won't fix that either, but it'll
        // keep failing for a legible, still-diagnosable reason instead
        // of going failed_final after one shot.
        throw new Error("No rendered image for this pin yet — publish ran before render_image finished");
      }
      const copy = item.copyFields as { title: string; description: string; suggestedBoard: string };
      const boardId = await findOrCreateBoard(accessToken, copy.suggestedBoard);
      return createPin(accessToken, { title: copy.title, description: copy.description, link, boardId, imageUrl: asset.fileUrl });
    }
    if (item.platform === "facebook") {
      const copy = item.copyFields as { postText: string };
      return createPagePost(accessToken, connection.externalAccountId, { message: copy.postText, link });
    }
    if (item.platform === "linkedin") {
      const copy = item.copyFields as { postText: string };
      return createOrganizationPost(accessToken, connection.externalAccountId, {
        text: copy.postText,
        link,
        linkTitle: article.title,
      });
    }
    if (item.platform === "instagram") {
      const renderedAssets = await db
        .select()
        .from(contentAssets)
        .where(and(eq(contentAssets.contentItemId, item.id), eq(contentAssets.status, "rendered")));
      if (renderedAssets.length === 0) {
        // Same reasoning as the Pinterest branch above — retryable, not
        // a permanent failure on the first attempt.
        throw new Error("No rendered slides for this carousel yet — publish ran before render_image finished");
      }
      const copy = item.copyFields as { caption: string };
      const imageUrls = renderedAssets
        .sort((a, b) => {
          const ai = (a.renderParams as { slideIndex?: number } | null)?.slideIndex ?? 0;
          const bi = (b.renderParams as { slideIndex?: number } | null)?.slideIndex ?? 0;
          return ai - bi;
        })
        .map((a) => a.fileUrl!);
      return createInstagramCarousel(accessToken, connection.externalAccountId, { caption: copy.caption, imageUrls });
    }
    throw new NonRetryableJobError(`publish_post not implemented for ${item.platform} yet`);
  };

  const accessToken = await readSecret(db, connection.accessTokenVaultId);

  let firstError: unknown;
  try {
    const result = await doPublish(accessToken);
    await finalizePublished(target.id, target.contentItemId, result);
    return;
  } catch (err) {
    firstError = err;
  }

  if (!(firstError instanceof PlatformAuthError)) {
    await handleNonAuthFailure(target.id, target.contentItemId, firstError);
    throw firstError instanceof PlatformValidationError
      ? new NonRetryableJobError((firstError as Error).message)
      : firstError;
  }

  // firstError was an auth error — try exactly one refresh + one retry.
  const refreshedToken = await attemptRefresh(connection).catch(() => null);
  if (refreshedToken) {
    try {
      const result = await doPublish(refreshedToken);
      await finalizePublished(target.id, target.contentItemId, result);
      return;
    } catch (secondErr) {
      await handleNonAuthFailure(target.id, target.contentItemId, secondErr);
      throw secondErr instanceof PlatformValidationError || secondErr instanceof PlatformAuthError
        ? new NonRetryableJobError((secondErr as Error).message)
        : secondErr;
    }
  }

  // Refresh failed or didn't apply — stop retrying, mark the connection
  // expired, and pause this platform's other pending publishes instead
  // of letting them fail one at a time against the same dead token.
  await db.update(platformConnections).set({ status: "expired" }).where(eq(platformConnections.id, connection.id));
  await db
    .update(publishTargets)
    .set({ status: "failed_retrying", errorMessage: "auth expired — reconnect required" })
    .where(
      and(eq(publishTargets.platformConnectionId, connection.id), inArray(publishTargets.status, ["scheduled", "publishing"])),
    );
  await db.insert(publishLog).values({ publishTargetId: target.id, eventType: "failed", detail: { reason: "auth_expired" } });
  throw new NonRetryableJobError(`${connection.platform} auth expired, reconnect required`);
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
      return runPublishPost(job);
    case "refresh_token":
      // Auth renewal happens inline inside runPublishPost per §5, not as
      // its own scheduled job — nothing enqueues this job type yet.
      throw new NonRetryableJobError(`Job type '${job.jobType}' has no handler yet`);
    default:
      throw new NonRetryableJobError(`Unknown job type '${job.jobType}'`);
  }
}

// Vercel Cron always sends GET, not POST — vercel.json wires this path
// to fire on schedule, and a POST-only handler here 405s every time.
export async function GET(request: Request) {
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
