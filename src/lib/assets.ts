import { desc } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { assetLibrary } from "@/db/schema";

// How well an approved image's tags match the article it'd be used for.
// Case-insensitive intersection count — pure so it's cheap to unit test
// without a database.
export function scoreAssetMatch(assetTags: string[], articleTags: string[]): number {
  const normalizedArticleTags = new Set(articleTags.map((t) => t.toLowerCase()));
  return assetTags.filter((t) => normalizedArticleTags.has(t.toLowerCase())).length;
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

// No match (including an empty library) returns null, and callers are
// expected to surface that as "needs an approved photo" rather than
// pick something unrelated.
export async function selectAssetForArticle(db: typeof DbClient, articleTags: string[]) {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));
  return rankAssetsByScore(candidates, articleTags)[0] ?? null;
}

// Returns up to `limit` distinct matches (best score first) instead of
// one — used by the Instagram carousel renderer so slides don't all
// reuse the same single photo when the library has more than one
// approved shot for the article's tags. Returns fewer than `limit` (down
// to []) when the library doesn't have that many matches; callers cycle
// through what's returned rather than treating a short list as an error.
export async function selectAssetsForArticle(db: typeof DbClient, articleTags: string[], limit: number) {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));
  return rankAssetsByScore(candidates, articleTags).slice(0, limit);
}
