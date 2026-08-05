import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { articles } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { hashArticleContent } from "@/lib/hash";
import { enqueueJob } from "@/lib/jobs";
import { shopifyArticleWebhookSchema, verifyShopifyHmac } from "@/lib/shopify-webhook";

export const runtime = "nodejs";

// Handles both articles/create and articles/update — Shopify sends the
// same Article resource shape for each; the topic header only
// distinguishes them for logging.
export async function POST(request: Request) {
  const { SHOPIFY_WEBHOOK_SECRET } = requireEnv("SHOPIFY_WEBHOOK_SECRET");

  const rawBody = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");

  if (!verifyShopifyHmac(rawBody, hmacHeader, SHOPIFY_WEBHOOK_SECRET)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const parseResult = shopifyArticleWebhookSchema.safeParse(JSON.parse(rawBody));
  if (!parseResult.success) {
    return new Response(`Unexpected payload shape: ${parseResult.error.message}`, { status: 400 });
  }
  const payload = parseResult.data;

  const bodyHtml = payload.body_html ?? "";
  const contentHash = hashArticleContent(bodyHtml);
  const shopifyArticleId = String(payload.id);

  const [existing] = await db
    .select()
    .from(articles)
    .where(eq(articles.shopifyArticleId, shopifyArticleId))
    .limit(1);

  if (!existing) {
    const [inserted] = await db
      .insert(articles)
      .values({
        shopifyArticleId,
        shopifyBlogId: String(payload.blog_id),
        title: payload.title,
        handle: payload.handle,
        bodyHtml,
        tags: payload.tags ? payload.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        shopifyUpdatedAt: new Date(payload.updated_at),
        contentHash,
        status: "new",
      })
      .returning();
    if (!inserted) {
      throw new Error("Insert into articles returned no row");
    }
    await enqueueJob(db, "extract_article", { articleId: inserted.id });
    return Response.json({ status: "created", articleId: inserted.id, extractionQueued: true });
  }

  if (existing.contentHash === contentHash) {
    // No-op save (e.g. a typo fix already reflected, or a duplicate
    // webhook delivery) — touch metadata only, skip re-extraction.
    await db
      .update(articles)
      .set({ shopifyUpdatedAt: new Date(payload.updated_at), fetchedAt: new Date() })
      .where(eq(articles.id, existing.id));
    return Response.json({ status: "unchanged", articleId: existing.id, extractionQueued: false });
  }

  await db
    .update(articles)
    .set({
      title: payload.title,
      handle: payload.handle,
      bodyHtml,
      tags: payload.tags ? payload.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      shopifyUpdatedAt: new Date(payload.updated_at),
      contentHash,
      status: "new",
      fetchedAt: new Date(),
    })
    .where(eq(articles.id, existing.id));
  await enqueueJob(db, "extract_article", { articleId: existing.id });
  return Response.json({ status: "updated", articleId: existing.id, extractionQueued: true });
}
