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

// Only returns an asset with at least one matching tag — per
// docs/PHASE_0_PLAN.md §1, "reuse approved imagery" degrading into
// "grab whatever's in the library" would be a trust problem, not just a
// missing feature. No match (including an empty library) returns null,
// and callers are expected to surface that as "needs an approved photo"
// rather than pick something unrelated.
export async function selectAssetForArticle(db: typeof DbClient, articleTags: string[]) {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));

  let best: (typeof candidates)[number] | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreAssetMatch(candidate.tags, articleTags);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
