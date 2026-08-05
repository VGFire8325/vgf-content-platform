import { eq } from "drizzle-orm";
import { z } from "zod";
import type { db as DbClient } from "@/db/client";
import { articles } from "@/db/schema";
import { hashArticleContent } from "@/lib/hash";
import { enqueueJob } from "@/lib/jobs";

const API_VERSION = "2026-04"; // matches [webhooks].api_version in shopify.app.toml

// Shape of Shopify's Article REST resource, as returned by the
// list-articles endpoint this module polls.
export const shopifyArticleSchema = z.object({
  id: z.number(),
  blog_id: z.number(),
  title: z.string(),
  handle: z.string(),
  body_html: z.string().nullable(),
  tags: z.string(), // comma-separated
  published_at: z.string().nullable(),
  updated_at: z.string(),
});
export type ShopifyArticle = z.infer<typeof shopifyArticleSchema>;

export async function fetchShopifyBlogId(shopDomain: string, accessToken: string, blogHandle: string): Promise<number> {
  const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/blogs.json?limit=250`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!response.ok) {
    throw new Error(`Failed to list blogs: HTTP ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as { blogs: { id: number; handle: string }[] };
  const blog = json.blogs.find((b) => b.handle === blogHandle);
  if (!blog) {
    throw new Error(`No blog with handle "${blogHandle}" found on ${shopDomain}`);
  }
  return blog.id;
}

// Follows the Link response header for cursor pagination — Shopify's
// classic REST endpoints don't support page numbers, only "next"/"prev"
// URLs handed back in this header.
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((s) => s.trim());
    if (relPart === 'rel="next"' && urlPart) {
      return urlPart.slice(1, -1); // strip surrounding <...>
    }
  }
  return null;
}

export async function fetchAllArticles(shopDomain: string, accessToken: string, blogId: number): Promise<ShopifyArticle[]> {
  const results: ShopifyArticle[] = [];
  let url: string | null = `https://${shopDomain}/admin/api/${API_VERSION}/blogs/${blogId}/articles.json?limit=250`;

  while (url) {
    const response: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!response.ok) {
      throw new Error(`Failed to list articles: HTTP ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { articles: unknown[] };
    for (const raw of json.articles) {
      results.push(shopifyArticleSchema.parse(raw));
    }
    url = parseNextLink(response.headers.get("link"));
  }

  return results;
}

interface SyncResult {
  status: "created" | "updated" | "unchanged";
  articleId: string;
  extractionQueued: boolean;
}

// Diffs one Shopify article against the stored copy and enqueues
// extraction only when the content actually changed — a re-poll of an
// untouched article, or a typo-fix save, is a no-op here rather than a
// fresh extract_article job. Shared by the daily poll cron; used to be
// shared with a webhook receiver too, before confirming Shopify has no
// webhook topic for blog articles at all (neither the GraphQL
// WebhookSubscriptionTopic enum nor the classic REST webhooks endpoint
// recognizes articles/create or articles/update as of API version
// 2026-04) — polling is the only ingestion path left.
export async function syncArticleFromShopify(db: typeof DbClient, payload: ShopifyArticle): Promise<SyncResult> {
  const bodyHtml = payload.body_html ?? "";
  const contentHash = hashArticleContent(bodyHtml);
  const shopifyArticleId = String(payload.id);
  const tags = payload.tags ? payload.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

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
        tags,
        shopifyUpdatedAt: new Date(payload.updated_at),
        contentHash,
        status: "new",
      })
      .returning();
    if (!inserted) {
      throw new Error("Insert into articles returned no row");
    }
    await enqueueJob(db, "extract_article", { articleId: inserted.id });
    return { status: "created", articleId: inserted.id, extractionQueued: true };
  }

  if (existing.contentHash === contentHash) {
    await db
      .update(articles)
      .set({ shopifyUpdatedAt: new Date(payload.updated_at), fetchedAt: new Date() })
      .where(eq(articles.id, existing.id));
    return { status: "unchanged", articleId: existing.id, extractionQueued: false };
  }

  await db
    .update(articles)
    .set({
      title: payload.title,
      handle: payload.handle,
      bodyHtml,
      tags,
      shopifyUpdatedAt: new Date(payload.updated_at),
      contentHash,
      status: "new",
      fetchedAt: new Date(),
    })
    .where(eq(articles.id, existing.id));
  await enqueueJob(db, "extract_article", { articleId: existing.id });
  return { status: "updated", articleId: existing.id, extractionQueued: true };
}
