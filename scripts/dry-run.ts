// Dry-run mode: shows what the pipeline would do right now — which
// pending generate_content jobs would proceed vs. get skipped by the
// LinkedIn no-repeat gate (Spec 2), what a pending LinkedIn post's
// final published text would look like with its CTA + UTM link
// attached (Spec 1), and which pending Pinterest pins the quality gate
// would flag and why (Spec 3). Read-only (SELECT only) — never calls
// the Anthropic, LinkedIn, or Pinterest APIs, and never writes to the
// database.
//
// Run with:
//   DATABASE_URL=... SHOPIFY_SHOP_DOMAIN=... SHOPIFY_BLOG_HANDLE=... \
//     npx tsx scripts/dry-run.ts
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../src/db/client";
import { articleExtractions, articles, assetLibrary, contentAssets, contentItems, jobs } from "../src/db/schema";
import { articlePublicUrl, withLinkedInUtm, withPinterestUtm } from "../src/lib/article-url";
import { optionalEnvInt } from "../src/lib/env";
import { composeLinkedInPost } from "../src/lib/linkedin-post";
import { evaluatePinterestPinQuality } from "../src/lib/pinterest-quality";
import { DEFAULT_LINKEDIN_REPOST_GAP_DAYS, isWithinLinkedInRepostGap } from "../src/lib/repost-policy";

const REPOST_HISTORY_STATUSES = ["in_review", "approved", "scheduled", "published", "failed"] as const;

async function mostRecentLinkedInPost(articleId: string, campaign: string | null) {
  const [row] = await db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.articleId, articleId),
        eq(contentItems.platform, "linkedin"),
        campaign ? eq(contentItems.campaign, campaign) : isNull(contentItems.campaign),
        inArray(contentItems.status, REPOST_HISTORY_STATUSES),
      ),
    )
    .orderBy(desc(contentItems.createdAt))
    .limit(1);
  return row;
}

async function reportPendingGeneration() {
  console.log("=== 1. Pending generate_content jobs: would proceed or skip? ===");
  const pendingJobs = await db.select().from(jobs).where(and(eq(jobs.jobType, "generate_content"), eq(jobs.status, "pending")));
  if (pendingJobs.length === 0) {
    console.log("(none pending)\n");
    return;
  }
  const gapDays = optionalEnvInt("LINKEDIN_REPOST_GAP_DAYS", DEFAULT_LINKEDIN_REPOST_GAP_DAYS);
  for (const job of pendingJobs) {
    const { articleId, platform, campaign, forceRepost } = job.payload as {
      articleId: string;
      platform: string;
      campaign?: string;
      forceRepost?: boolean;
    };
    const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
    const label = `${platform} — "${article?.title ?? articleId}"`;
    if (platform !== "linkedin") {
      console.log(`  WOULD GENERATE: ${label}`);
      continue;
    }
    const prior = await mostRecentLinkedInPost(articleId, campaign ?? null);
    if (!forceRepost && isWithinLinkedInRepostGap(prior?.createdAt ?? null, new Date(), gapDays)) {
      console.log(`  WOULD SKIP (no-repeat gap): ${label} — previous post ${prior!.createdAt.toISOString()}, gap ${gapDays}d`);
    } else {
      console.log(`  WOULD GENERATE: ${label}${forceRepost ? " (forced repost)" : ""}`);
    }
  }
  console.log("");
}

async function reportPendingLinkedInPosts() {
  console.log("=== 2. Pending LinkedIn posts: final text preview (CTA + UTM link) ===");
  const { SHOPIFY_SHOP_DOMAIN, SHOPIFY_BLOG_HANDLE } = process.env;
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_BLOG_HANDLE) {
    console.log("(SHOPIFY_SHOP_DOMAIN/SHOPIFY_BLOG_HANDLE not set — skipping this section)\n");
    return;
  }
  const rows = await db
    .select({ item: contentItems, article: articles })
    .from(contentItems)
    .innerJoin(articles, eq(contentItems.articleId, articles.id))
    .where(and(eq(contentItems.platform, "linkedin"), eq(contentItems.status, "in_review")));

  if (rows.length === 0) {
    console.log("(none pending)\n");
    return;
  }
  for (const { item, article } of rows) {
    const copy = item.copyFields as { postText: string; cta?: string };
    if (!copy.cta) {
      console.log(`  "${article.title}" — legacy item with no cta field yet; regenerate to get the new format.`);
      continue;
    }
    const link = articlePublicUrl(SHOPIFY_SHOP_DOMAIN, SHOPIFY_BLOG_HANDLE, article.handle);
    const taggedLink = withLinkedInUtm(link, article.handle);
    console.log(`  "${article.title}":`);
    console.log("  ---");
    console.log(
      composeLinkedInPost(copy.postText, copy.cta, taggedLink)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    console.log("  ---\n");
  }
}

async function reportPendingPinterestPins() {
  console.log("=== 3. Pending Pinterest pins: quality gate re-check ===");
  const { SHOPIFY_SHOP_DOMAIN, SHOPIFY_BLOG_HANDLE } = process.env;
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_BLOG_HANDLE) {
    console.log("(SHOPIFY_SHOP_DOMAIN/SHOPIFY_BLOG_HANDLE not set — skipping this section)\n");
    return;
  }
  const rows = await db
    .select({ item: contentItems, article: articles })
    .from(contentItems)
    .innerJoin(articles, eq(contentItems.articleId, articles.id))
    .where(and(eq(contentItems.platform, "pinterest"), eq(contentItems.status, "in_review")));

  if (rows.length === 0) {
    console.log("(none pending)\n");
    return;
  }

  for (const { item, article } of rows) {
    const [extraction] = await db
      .select()
      .from(articleExtractions)
      .where(eq(articleExtractions.articleId, article.id))
      .orderBy(desc(articleExtractions.createdAt))
      .limit(1);
    const [assetRow] = await db
      .select({ sourceAssetId: contentAssets.sourceAssetId, tags: assetLibrary.tags, notes: assetLibrary.notes })
      .from(contentAssets)
      .leftJoin(assetLibrary, eq(contentAssets.sourceAssetId, assetLibrary.id))
      .where(and(eq(contentAssets.contentItemId, item.id), eq(contentAssets.status, "rendered")))
      .orderBy(desc(contentAssets.createdAt))
      .limit(1);

    const copy = item.copyFields as { title: string; description: string; altText: string };
    const articleUrl = articlePublicUrl(SHOPIFY_SHOP_DOMAIN, SHOPIFY_BLOG_HANDLE, article.handle);
    const flags = evaluatePinterestPinQuality({
      articleId: item.articleId,
      title: copy.title,
      description: copy.description,
      altText: copy.altText,
      topicKeywords: [article.title, extraction?.coreSubject, extraction?.searchIntent].filter(
        (k): k is string => Boolean(k),
      ),
      pinLink: withPinterestUtm(articleUrl, item.id),
      articleUrl,
      image: assetRow?.sourceAssetId
        ? { assetId: assetRow.sourceAssetId, tags: assetRow.tags ?? [], notes: assetRow.notes }
        : undefined,
      existingPins: [],
    });
    console.log(`  "${article.title}": ${flags.length === 0 ? "no flags" : flags.join("; ")}`);
  }
  console.log("");
}

async function main() {
  await reportPendingGeneration();
  await reportPendingLinkedInPosts();
  await reportPendingPinterestPins();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
