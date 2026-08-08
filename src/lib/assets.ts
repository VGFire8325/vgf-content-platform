import { desc } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { db as DbClient } from "@/db/client";
import { assetLibrary } from "@/db/schema";
import { BRAND_CORE, callStructuredTool } from "./anthropic";

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

// No match (including an empty library) returns null, and callers are
// expected to surface that as "needs an approved photo" rather than
// pick something unrelated. Exact tag overlap is tried first — free,
// instant, and the right answer whenever an asset really was tagged to
// match — before falling back to the semantic pass.
export async function selectAssetForArticle(
  db: typeof DbClient,
  client: Anthropic,
  article: ArticleMatchContext,
): Promise<AssetRow | null> {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));
  const exact = rankAssetsByScore(candidates, article.tags)[0];
  if (exact) return exact;
  if (candidates.length === 0) return null;
  const [matched] = await matchAssetsSemantic(client, article, candidates, 1);
  return matched ?? null;
}

// Returns up to `limit` distinct matches (best first) instead of one —
// used by the Instagram carousel renderer so slides don't all reuse the
// same single photo. Returns fewer than `limit` (down to []) when
// neither pass finds that many; callers cycle through what's returned
// rather than treating a short list as an error.
export async function selectAssetsForArticle(
  db: typeof DbClient,
  client: Anthropic,
  article: ArticleMatchContext,
  limit: number,
): Promise<AssetRow[]> {
  const candidates = await db.select().from(assetLibrary).orderBy(desc(assetLibrary.uploadedAt));
  const exact = rankAssetsByScore(candidates, article.tags);
  if (exact.length > 0) return exact.slice(0, limit);
  if (candidates.length === 0) return [];
  return matchAssetsSemantic(client, article, candidates, limit);
}
