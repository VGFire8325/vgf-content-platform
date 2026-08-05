// One-off script to manually ingest a specific, hand-picked batch of
// existing Shopify articles — for seeding the Pinterest pipeline with a
// few known-good articles without backfilling the entire blog history
// via /api/cron/poll-shopify-articles.
//
// After ingesting the given articles, sets the shopify_articles sync
// cutoff to "now," so the next scheduled poll only picks up articles
// Shopify reports as changed after this point — the rest of the
// backlog is left alone rather than getting swept in on the next run.
//
// Run with the numeric Shopify article IDs to seed (from the article's
// admin URL or the Shopify API), space-separated:
//   DATABASE_URL=... SHOPIFY_BLOG_HANDLE=electric-fireplaces \
//     npx tsx scripts/seed-shopify-articles.ts 667538686170 667538784474 667537572058
import { db } from "../src/db/client";
import { shopifyConnection } from "../src/db/schema";
import {
  fetchArticleById,
  fetchShopifyBlogId,
  setShopifyArticlesCutoff,
  syncArticleFromShopify,
} from "../src/lib/platforms/shopify-articles";
import { readSecret } from "../src/lib/vault";

async function main() {
  const articleIds = process.argv.slice(2).map((arg) => Number(arg));
  if (articleIds.length === 0 || articleIds.some((id) => !Number.isFinite(id))) {
    throw new Error("Usage: npx tsx scripts/seed-shopify-articles.ts <articleId> [articleId...] — all args must be numeric Shopify article IDs");
  }

  const blogHandle = process.env.SHOPIFY_BLOG_HANDLE;
  if (!blogHandle) {
    throw new Error("SHOPIFY_BLOG_HANDLE is required (e.g. electric-fireplaces)");
  }

  const [connection] = await db.select().from(shopifyConnection).limit(1);
  if (!connection) {
    throw new Error("No shopify_connection row found — connect Shopify first via /api/oauth/shopify/start, then re-run this script.");
  }

  const accessToken = await readSecret(db, connection.accessTokenVaultId);
  const blogId = await fetchShopifyBlogId(connection.shopDomain, accessToken, blogHandle);

  console.log(`Seeding ${articleIds.length} article(s) from ${connection.shopDomain}`);
  for (const articleId of articleIds) {
    const article = await fetchArticleById(connection.shopDomain, accessToken, blogId, articleId);
    const result = await syncArticleFromShopify(db, article);
    console.log(`  ${result.status} — "${article.title}" (${result.articleId}), extraction queued: ${result.extractionQueued}`);
  }

  const cutoff = new Date();
  await setShopifyArticlesCutoff(db, cutoff);
  console.log(`\nSet the shopify_articles poll cutoff to ${cutoff.toISOString()} — tomorrow's poll will only pick up articles changed after this point.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
