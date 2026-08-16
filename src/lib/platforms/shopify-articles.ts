import { eq } from "drizzle-orm";
import { z } from "zod";
import type { db as DbClient } from "@/db/client";
import { articles, syncCursors } from "@/db/schema";
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

export async function fetchArticleById(
  shopDomain: string,
  accessToken: string,
  blogId: number,
  articleId: number,
): Promise<ShopifyArticle> {
  const response = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/blogs/${blogId}/articles/${articleId}.json`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch article ${articleId}: HTTP ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as { article: unknown };
  return shopifyArticleSchema.parse(json.article);
}

// updatedAtMin scopes the fetch to articles Shopify reports changed
// after that point — see syncCursors: the daily poll uses this to
// avoid re-scanning the whole blog once a cutoff has been established.
export async function fetchAllArticles(
  shopDomain: string,
  accessToken: string,
  blogId: number,
  updatedAtMin?: Date,
): Promise<ShopifyArticle[]> {
  const results: ShopifyArticle[] = [];
  const minParam = updatedAtMin ? `&updated_at_min=${encodeURIComponent(updatedAtMin.toISOString())}` : "";
  // Explicit "any" rather than trusting Shopify's default — syncArticleFromShopify
  // decides what's ready to process based on published_at itself, and needs
  // to see drafts/scheduled/unpublished articles too, not just currently-live
  // ones. Filtering here would hide the "went offline" half of an
  // unpublish-then-republish cycle, which is exactly the transition it needs
  // to detect on the way back.
  let url: string | null = `https://${shopDomain}/admin/api/${API_VERSION}/blogs/${blogId}/articles.json?limit=250&published_status=any${minParam}`;

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
  status: "created" | "skipped_unpublished" | "published" | "updated" | "unchanged";
  articleId: string | null;
  extractionQueued: boolean;
}

// Shopify's own "live" concept: published_at set and not in the future.
// Confirmed to match Shopify's isPublished exactly — a post scheduled for
// a future date carries a real published_at but Shopify itself reports
// isPublished: false until that date arrives.
export function isArticleLive(publishedAt: string | null, now: Date = new Date()): boolean {
  if (!publishedAt) return false;
  return new Date(publishedAt).getTime() <= now.getTime();
}

type SyncAction = SyncResult["status"];

// Pure decision table, factored out so every branch is unit-testable
// without a database. `wasLive`/`isLive` are Shopify's live concept
// (isArticleLive) as of our last stored copy vs. right now; `hashChanged`
// only matters once we already know the article is live and existed
// before — an unpublished/scheduled article is never a candidate for a
// content-hash comparison in the first place.
export function decideSyncAction(params: { existing: boolean; wasLive: boolean; isLive: boolean; hashChanged: boolean }): SyncAction {
  if (!params.existing) {
    return params.isLive ? "created" : "skipped_unpublished";
  }
  if (!params.isLive) {
    // Not live right now — whether it used to be live (unpublished/
    // rescheduled) or never was, there's nothing to (re)generate while
    // it's offline. wasLive still gets persisted by the caller so the
    // eventual "published" transition can be detected later.
    return "unchanged";
  }
  if (!params.wasLive) {
    // The actual fix: going from not-live to live is a trigger on its
    // own, independent of content — the body may have been written and
    // hashed long before the article ever went live.
    return "published";
  }
  return params.hashChanged ? "updated" : "unchanged";
}

// Diffs one Shopify article against the stored copy and enqueues
// extraction when the content changed OR the article just went live for
// the first time (see decideSyncAction) — a re-poll of an untouched,
// already-live article, or a typo-fix save, is a no-op here rather than a
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
  const shopifyPublishedAt = payload.published_at ? new Date(payload.published_at) : null;
  const isLive = isArticleLive(payload.published_at);

  const [existing] = await db
    .select()
    .from(articles)
    .where(eq(articles.shopifyArticleId, shopifyArticleId))
    .limit(1);

  const wasLive = existing ? isArticleLive(existing.shopifyPublishedAt?.toISOString() ?? null) : false;
  const action = decideSyncAction({
    existing: Boolean(existing),
    wasLive,
    isLive,
    hashChanged: existing ? existing.contentHash !== contentHash : false,
  });

  if (action === "skipped_unpublished") {
    // Not inserted at all — Shopify bumps an article's updated_at the
    // moment it actually goes live (confirmed directly: a republished
    // article's updatedAt and publishedAt landed on the same timestamp),
    // so this article will resurface on its own in a future poll once
    // it's really live, and get created normally at that point.
    return { status: "skipped_unpublished", articleId: null, extractionQueued: false };
  }

  if (action === "created") {
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
        shopifyPublishedAt,
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

  // existing is guaranteed here — the only actions left (unchanged/
  // published/updated) all require existing: true in decideSyncAction.
  const existingId = existing!.id;

  if (action === "unchanged") {
    await db
      .update(articles)
      .set({ shopifyUpdatedAt: new Date(payload.updated_at), shopifyPublishedAt, fetchedAt: new Date() })
      .where(eq(articles.id, existingId));
    return { status: "unchanged", articleId: existingId, extractionQueued: false };
  }

  // "published" (went live, content unchanged from when it was drafted)
  // or "updated" (already live, content actually changed) — both refresh
  // the stored copy and enqueue extraction the same way.
  await db
    .update(articles)
    .set({
      title: payload.title,
      handle: payload.handle,
      bodyHtml,
      tags,
      shopifyUpdatedAt: new Date(payload.updated_at),
      shopifyPublishedAt,
      contentHash,
      status: "new",
      fetchedAt: new Date(),
    })
    .where(eq(articles.id, existingId));
  await enqueueJob(db, "extract_article", { articleId: existingId });
  return { status: action, articleId: existingId, extractionQueued: true };
}

const SHOPIFY_ARTICLES_CURSOR_KEY = "shopify_articles";

// Null means no cutoff has been set yet — the caller should treat that
// as "fetch everything" (first-ever poll, or before any manual seed).
export async function getShopifyArticlesCutoff(db: typeof DbClient): Promise<Date | null> {
  const [row] = await db.select().from(syncCursors).where(eq(syncCursors.key, SHOPIFY_ARTICLES_CURSOR_KEY)).limit(1);
  return row?.cutoff ?? null;
}

export async function setShopifyArticlesCutoff(db: typeof DbClient, cutoff: Date): Promise<void> {
  await db
    .insert(syncCursors)
    .values({ key: SHOPIFY_ARTICLES_CURSOR_KEY, cutoff, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncCursors.key,
      set: { cutoff, updatedAt: new Date() },
    });
}
