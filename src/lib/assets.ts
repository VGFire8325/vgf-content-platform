import { and, desc, gt, isNotNull } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { db as DbClient } from "@/db/client";
import { assetLibrary, contentAssets } from "@/db/schema";
import { BRAND_CORE, callStructuredTool } from "./anthropic";

// The blog's entire content taxonomy (confirmed against production:
// `SELECT DISTINCT unnest(tags) FROM articles` never returns anything
// outside this set) — every article is tagged with one of these and
// nothing else. Exact-tag matching assumes an asset tag shared with an
// article is a deliberate, meaningful signal, but assets imported from
// Shopify products can pick up the product's own category tags
// alongside their real photo-specific ones (vendor, install style,
// room). When one of *these* seven leaks onto an asset, that asset
// "matches" every article in the category by coincidence, regardless of
// whether the photo has anything to do with the article — and since it
// wins before the semantic pass ever runs, the same photo gets reused
// across genuinely unrelated topics. A category name never describes a
// photo's content, so it carries no matching signal on the asset side.
const BLOG_CATEGORY_TAGS = new Set(
  [
    "Brands",
    "Comparisons",
    "Getting Started",
    "Installation",
    "Ownership & Maintenance",
    "Room & Space",
    "Style & Decor",
  ].map((t) => t.toLowerCase()),
);

// How well an approved image's tags match the article it'd be used for.
// Case-insensitive intersection count — pure so it's cheap to unit test
// without a database.
export function scoreAssetMatch(assetTags: string[], articleTags: string[]): number {
  const normalizedArticleTags = new Set(articleTags.map((t) => t.toLowerCase()));
  return assetTags.filter((t) => {
    const normalized = t.toLowerCase();
    return !BLOG_CATEGORY_TAGS.has(normalized) && normalizedArticleTags.has(normalized);
  }).length;
}

// Ranks candidates by scoreAssetMatch, best first, dropping anything
// with no overlap at all — per docs/PHASE_0_PLAN.md §1, "reuse approved
// imagery" degrading into "grab whatever's in the library" would be a
// trust problem, not just a missing feature. Pure (no db), shared by
// both selection functions below so their "no unrelated substitute"
// rule can't drift apart between the single- and multi-asset callers.
export function rankAssetsByScore<T extends { tags: string[] }>(candidates: T[], articleTags: string[]): T[] {
  return candidates
    .map((asset) => ({ asset, score: scoreAssetMatch(asset.tags, articleTags) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ asset }) => asset);
}

type AssetRow = typeof assetLibrary.$inferSelect;

// What the semantic fallback needs to judge topical fit — article tags
// alone are Shopify's generic content taxonomy (e.g. "Room & Space"),
// which by design shares no vocabulary with the asset library's
// vendor/product-type/installation tags, so title + extraction give the
// model something concrete to match against.
export type ArticleMatchContext = {
  title: string;
  tags: string[];
  coreSubject?: string;
  keyTakeaways?: string[];
};

const semanticMatchSchema = z.object({ matchedAssetIds: z.array(z.string()) });

const SEMANTIC_MATCH_TOOL: Anthropic.Tool = {
  name: "record_asset_matches",
  description: "Records which approved photo asset ids reasonably illustrate the article, best first.",
  input_schema: {
    type: "object",
    properties: { matchedAssetIds: { type: "array", items: { type: "string" } } },
    required: ["matchedAssetIds"],
  },
};

// Runs whenever exact tag overlap finds nothing — given the vocabulary
// mismatch described above, that's the common case, not a rare
// fallback. All candidates go in one call rather than being capped or
// pre-filtered; fine at the library's current size (~100s of assets),
// would need capping or a cheaper embedding-based pass first if it grows
// into the thousands.
async function matchAssetsSemantic(
  client: Anthropic,
  article: ArticleMatchContext,
  candidates: AssetRow[],
  limit: number,
): Promise<AssetRow[]> {
  const system = `${BRAND_CORE}

You are picking product/lifestyle photos from an approved library to
illustrate a blog article's social posts. Match on topic and visual
relevance (product type, installation style, room or setting), not
literal string overlap with any tag. Only include a photo if a reader
would recognize it as actually illustrating this article — an unrelated
product from the same brand, or a photo that only loosely fits, is not
a match. If nothing in the library is a reasonable fit, return an empty
list; never force a mismatched pick.`;

  const userContent = `Article title: ${article.title}
${article.coreSubject ? `Core subject: ${article.coreSubject}\n` : ""}${
    article.keyTakeaways?.length ? `Key takeaways:\n${article.keyTakeaways.map((t) => `- ${t}`).join("\n")}\n` : ""
  }Article tags: ${article.tags.join(", ") || "(none)"}

Available photos (id: tags — notes):
${candidates.map((c) => `${c.id}: [${c.tags.join(", ")}]${c.notes ? ` — ${c.notes}` : ""}`).join("\n")}

Pick up to ${limit} best-fitting photo id(s), ordered best first.`;

  const { matchedAssetIds } = await callStructuredTool(client, {
    system,
    userContent,
    tool: SEMANTIC_MATCH_TOOL,
    schema: semanticMatchSchema,
    maxTokens: 512,
  });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const matched: AssetRow[] = [];
  for (const id of matchedAssetIds) {
    const asset = byId.get(id);
    if (asset) matched.push(asset);
    if (matched.length >= limit) break;
  }
  return matched;
}

// A public feed reader scrolling past two posts sharing a photo notices,
// regardless of how good the topical match was on each — so recency is
// checked before either matching pass runs, not after. Window is days
// rather than "last N posts" so a slow week doesn't count as more
// distinct usage than it was.
const RECENT_ASSET_WINDOW_DAYS = 14;

async function recentlyUsedAssetIds(db: typeof DbClient, windowDays: number): Promise<Set<string>> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ sourceAssetId: contentAssets.sourceAssetId })
    .from(contentAssets)
    .where(and(isNotNull(contentAssets.sourceAssetId), gt(contentAssets.createdAt, since)));
  return new Set(rows.map((r) => r.sourceAssetId).filter((id): id is string => id !== null));
}

// Exact overlap, then the semantic pass, against a single candidate pool.
async function bestMatches(
  client: Anthropic,
  article: ArticleMatchContext,
  pool: AssetRow[],
  limit: number,
): Promise<AssetRow[]> {
  if (pool.length === 0) return [];
  const exact = rankAssetsByScore(pool, article.tags);
  if (exact.length > 0) return exact.slice(0, limit);
  return matchAssetsSemantic(client, article, pool, limit);
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

// Last-resort pick when neither matching pass finds even a loose fit.
// `candidates` must be non-empty; prefers an asset not used in the
// recent window, falling back to the newest asset on file otherwise —
// pure so it's cheap to unit test against the recency rule directly.
export function pickFallbackAsset<T extends { id: string }>(candidates: T[], recentlyUsed: Set<string>): T {
  const fresh = candidates.find((c) => !recentlyUsed.has(c.id));
  return fresh ?? candidates[0]!;
}

// Only an empty library returns null — every other case is guaranteed a
// photo. A post going out with no image at all is worse than one with an
// imperfect image, so "no confident match" falls back through
// progressively looser pools (recently-used assets excluded, then
// allowed back in, then just the newest asset on file) instead of
// leaving the item at needs_asset. Exact tag overlap is tried first —
// free, instant, and the right answer whenever an asset really was
// tagged to match — before the semantic pass.
export async function selectAssetForArticle(
  db: typeof DbClient,
  client: Anthropic,
  article: ArticleMatchContext,
): Promise<AssetRow | null> {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));
  if (candidates.length === 0) return null;

  const recentlyUsed = await recentlyUsedAssetIds(db, RECENT_ASSET_WINDOW_DAYS);
  const fresh = candidates.filter((c) => !recentlyUsed.has(c.id));

  const [freshMatch] = await bestMatches(client, article, fresh, 1);
  if (freshMatch) return freshMatch;

  const [anyMatch] = await bestMatches(client, article, candidates, 1);
  if (anyMatch) return anyMatch;

  return pickFallbackAsset(candidates, recentlyUsed);
}

// Returns up to `limit` distinct matches (best first) instead of one —
// used by the Instagram carousel renderer so slides don't all reuse the
// same single photo. Only an empty library returns fewer than `limit`
// (down to []); callers cycle through what's returned rather than
// treating a short list as an error.
export async function selectAssetsForArticle(
  db: typeof DbClient,
  client: Anthropic,
  article: ArticleMatchContext,
  limit: number,
): Promise<AssetRow[]> {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));
  if (candidates.length === 0) return [];

  const recentlyUsed = await recentlyUsedAssetIds(db, RECENT_ASSET_WINDOW_DAYS);
  const fresh = candidates.filter((c) => !recentlyUsed.has(c.id));

  const freshMatches = await bestMatches(client, article, fresh, limit);
  if (freshMatches.length >= limit) return freshMatches;

  const anyMatches = await bestMatches(client, article, candidates, limit);
  const merged = dedupeById([...freshMatches, ...anyMatches]).slice(0, limit);
  if (merged.length > 0) return merged;

  return [pickFallbackAsset(candidates, recentlyUsed)];
}
