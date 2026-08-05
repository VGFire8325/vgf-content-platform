import { db } from "@/db/client";
import { shopifyConnection } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import {
  fetchAllArticles,
  fetchShopifyBlogId,
  getShopifyArticlesCutoff,
  setShopifyArticlesCutoff,
  syncArticleFromShopify,
} from "@/lib/platforms/shopify-articles";
import { readSecret } from "@/lib/vault";

export const runtime = "nodejs";

// Shopify has no webhook topic for blog articles at all — confirmed
// against the full WebhookSubscriptionTopic enum and against the
// classic REST webhooks endpoint's own "Topics allowed" list, neither
// of which has ever included articles/blogs — so ingestion polls
// instead of reacting to a push event. Runs once daily per
// vercel.json; this content pipeline has no need for same-day
// freshness.
export async function GET(request: Request) {
  const { CRON_SECRET, SHOPIFY_BLOG_HANDLE } = requireEnv("CRON_SECRET", "SHOPIFY_BLOG_HANDLE");
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [connection] = await db.select().from(shopifyConnection).limit(1);
  if (!connection) {
    throw new Error("No shopify_connection row — connect Shopify via /api/oauth/shopify/start first");
  }

  const accessToken = await readSecret(db, connection.accessTokenVaultId);
  const blogId = await fetchShopifyBlogId(connection.shopDomain, accessToken, SHOPIFY_BLOG_HANDLE);

  // Captured before fetching, not after, so an article edited mid-run
  // still gets picked up by tomorrow's poll instead of falling in the
  // gap between "when we started reading" and "when we finished."
  const runStartedAt = new Date();
  const cutoff = await getShopifyArticlesCutoff(db);
  const shopifyArticles = await fetchAllArticles(connection.shopDomain, accessToken, blogId, cutoff ?? undefined);

  const results = { checked: shopifyArticles.length, created: 0, updated: 0, unchanged: 0 };
  for (const article of shopifyArticles) {
    const { status } = await syncArticleFromShopify(db, article);
    results[status]++;
  }

  await setShopifyArticlesCutoff(db, runStartedAt);

  return Response.json(results);
}
