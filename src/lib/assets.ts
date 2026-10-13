import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
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

// Owner rule: Pinterest, Instagram, LinkedIn and blog images are only ever
// photos of a fireplace installed in a real room (setting = 'installed',
// from the per-image tagging in migration 0008). product_only, render,
// detail, diagram, other and not-yet-tagged rows are never candidates, no
// matter how well their tags or notes match an article. Enforced both in
// the query (loadCandidates) and again on the way out (chooseAssets), so a
// future change to one can't quietly let other rows through.
export function isPostableAsset(asset: { setting?: string | null }): boolean {
  return asset.setting === "installed";
}

// Upper bound on what the semantic pass is shown, to keep the prompt a
// sane size; the pool is ranked first, so the cut drops the weakest photos.
export const SEMANTIC_CANDIDATE_CAP = 200;

type RankFields = { setting?: string | null; featuredOk?: boolean | null; quality?: number | null };

// Pure: keeps only installed photos, featured_ok first, then by quality
// (highest first). Stable otherwise, so the caller's newest-first order
// still breaks ties.
export function rankInstalledCandidates<T extends RankFields>(candidates: T[]): T[] {
  return candidates
    .filter(isPostableAsset)
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        Number(Boolean(b.c.featuredOk)) - Number(Boolean(a.c.featuredOk)) ||
        (b.c.quality ?? 0) - (a.c.quality ?? 0) ||
        a.i - b.i,
    )
    .map(({ c }) => c);
}

// One prompt line per candidate, describing the photo by what's actually
// in it (room, mounting, brand, alt text) rather than by its Shopify tags,
// which are empty on most rows.
export function describeCandidate(
  c: Pick<AssetRow, "id" | "tags"> & Partial<Pick<AssetRow, "room" | "mounting" | "brand" | "altText">>,
): string {
  const fields = [c.room, c.mounting, c.brand].filter(Boolean).join(", ");
  const tags = c.tags.length ? ` [${c.tags.join(", ")}]` : "";
  return `${c.id}: ${fields || "(untagged)"}${tags}${c.altText ? ` — ${c.altText}` : ""}`;
}

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

const semanticMatchSchema = z.object({ reasoning: z.string(), matchedAssetIds: z.array(z.string()) });

// Observed in production (2026-10): matchedAssetIds sometimes comes
// back missing entirely from the tool_use input, failing schema
// validation on a field the model just didn't echo back rather than
// anything wrong with the call — same class of non-compliance
// normalizeExtractionInput already coerces around in anthropic.ts. A
// missing or malformed matchedAssetIds is treated the same as the
// model explicitly saying "no match" (already a valid, instructed
// outcome — see the system prompt below), not a hard failure; a
// string gets split the same way a newline-joined list would.
export function normalizeSemanticMatchInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const obj = input as Record<string, unknown>;
  const raw = obj.matchedAssetIds;
  const matchedAssetIds = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw
          .split(/\r?\n+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return { ...obj, matchedAssetIds };
}

// `reasoning` is required and declared first: tool_choice forces a
// structured call with no room for free-text deliberation beforehand,
// so without a field to think out loud in first, a genuinely borderline
// case (e.g. "is a plain product photo an acceptable illustration for a
// how-to/process article, since no process photography exists in this
// library?") gets decided in one shot with no scratchpad — found via a
// real miss where 5 untouched, clearly relevant photos were all passed
// over on one call and one of them accepted on the very next.
const SEMANTIC_MATCH_TOOL: Anthropic.Tool = {
  name: "record_asset_matches",
  description: "Records which approved photo asset ids reasonably illustrate the article, best first.",
  input_schema: {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description:
          "Briefly note which candidates you considered relevant and why, before deciding. For a how-to/process article with no process photography available, a photo of the article's core subject installed in a room is an acceptable illustration — say so explicitly if that's the case here.",
      },
      matchedAssetIds: { type: "array", items: { type: "string" } },
    },
    required: ["reasoning", "matchedAssetIds"],
  },
};

// Runs whenever exact tag overlap finds nothing — given the vocabulary
// mismatch described above, that's the common case, not a rare
// fallback. Sees at most SEMANTIC_CANDIDATE_CAP candidates.
async function matchAssetsSemantic(
  client: Anthropic,
  article: ArticleMatchContext,
  allCandidates: AssetRow[],
  limit: number,
): Promise<AssetRow[]> {
  const candidates = allCandidates.slice(0, SEMANTIC_CANDIDATE_CAP);
  const system = `${BRAND_CORE}

You are picking photos from an approved library to illustrate a blog
article's social posts. Every photo shows an electric fireplace installed
in a real room. Match on topic and visual relevance (room, mounting or
installation style, brand, what the photo shows), not
literal string overlap with any tag. Only include a photo if a reader
would recognize it as actually illustrating this article — an unrelated
product from the same brand, or a photo that only loosely fits, is not
a match. If nothing in the library is a reasonable fit, return an empty
list; never force a mismatched pick.

The library only has finished-room photos, never step-by-step or
process shots. For a how-to or installation-process article, don't hold
out for photography that doesn't exist — a clear photo of the article's
core subject installed in a room (e.g. an installed insert for an article
about framing an insert) is a legitimate illustration on its own.`;

  const userContent = `Article title: ${article.title}
${article.coreSubject ? `Core subject: ${article.coreSubject}\n` : ""}${
    article.keyTakeaways?.length ? `Key takeaways:\n${article.keyTakeaways.map((t) => `- ${t}`).join("\n")}\n` : ""
  }Article tags: ${article.tags.join(", ") || "(none)"}

Available photos (id: room, mounting, brand [tags] — description):
${candidates.map((c) => describeCandidate(c)).join("\n")}

Pick up to ${limit} best-fitting photo id(s), ordered best first.`;

  const { matchedAssetIds } = await callStructuredTool(client, {
    system,
    userContent,
    tool: SEMANTIC_MATCH_TOOL,
    schema: semanticMatchSchema,
    maxTokens: 1024, // room for the reasoning field ahead of the id array, not just the array itself
    normalizeInput: normalizeSemanticMatchInput,
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

// How many times one asset can be used within RECENT_ASSET_WINDOW_DAYS
// before it's excluded from new picks entirely — found after a real
// production case where a 108-photo library still handed the same few
// "generic enough to fit anything" photos to 10-30+ different articles,
// because the binary recentlyUsed exclusion only ever asked "used at
// all in the window?", never "used how many times?" With a 108-asset
// library against ~54 pending articles, exhausting the under-cap pool
// shouldn't happen in practice — but if it ever does, the cap is
// relaxed rather than leaving the item at needs_asset (same "better an
// imperfect photo than none" reasoning as the rest of this file).
const MAX_ASSET_REUSE_PER_WINDOW = 3;

async function assetUsageCounts(db: typeof DbClient, windowDays: number): Promise<Map<string, number>> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ sourceAssetId: contentAssets.sourceAssetId })
    .from(contentAssets)
    .where(and(isNotNull(contentAssets.sourceAssetId), gt(contentAssets.createdAt, since)));
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.sourceAssetId) continue;
    counts.set(row.sourceAssetId, (counts.get(row.sourceAssetId) ?? 0) + 1);
  }
  return counts;
}

// Pure so the cap-then-relax behavior is cheap to unit test directly:
// filters candidates down to ones under the cap, but returns the full
// list unfiltered if that would otherwise leave nothing to pick from.
export function filterUnderReuseCap<T extends { id: string }>(
  candidates: T[],
  usageCounts: Map<string, number>,
  maxReuse: number = MAX_ASSET_REUSE_PER_WINDOW,
): T[] {
  const underCap = candidates.filter((c) => (usageCounts.get(c.id) ?? 0) < maxReuse);
  return underCap.length > 0 ? underCap : candidates;
}

type SemanticMatcher<T> = (article: ArticleMatchContext, candidates: T[], limit: number) => Promise<T[]>;

// Exact overlap, then the semantic pass, against a single candidate pool.
async function bestMatches<T extends { tags: string[] }>(
  semantic: SemanticMatcher<T>,
  article: ArticleMatchContext,
  pool: T[],
  limit: number,
): Promise<T[]> {
  if (pool.length === 0) return [];
  const exact = rankAssetsByScore(pool, article.tags);
  if (exact.length > 0) return exact.slice(0, limit);
  return semantic(article, pool, limit);
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

// Word set for free-text overlap checks (used by pinterest-quality.ts).
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3), // skip tiny/common words that would match almost anything
  );
}

// Installed photos only (see isPostableAsset), newest first, then ranked
// by rankInstalledCandidates.
async function loadCandidates(db: typeof DbClient): Promise<AssetRow[]> {
  const rows = await db
    .select()
    .from(assetLibrary)
    .where(eq(assetLibrary.setting, "installed"))
    .orderBy(desc(assetLibrary.uploadedAt));
  return rankInstalledCandidates(rows);
}

type MatchableAsset = RankFields & { id: string; tags: string[] };

// The whole selection policy, minus I/O — pure apart from the injected
// semantic matcher, so the installed-only rule is unit-testable without a
// database or a model call. Filters to installed photos itself (whatever
// the caller passed), tries photos not used in the recent window first,
// then any under the reuse cap, and returns [] when nothing matches. There
// is deliberately no "pick something anyway" fallback: a post with no
// photo beats a post with the wrong kind of photo.
export async function chooseAssets<T extends MatchableAsset>(
  rows: T[],
  article: ArticleMatchContext,
  limit: number,
  opts: { recentlyUsed: Set<string>; usageCounts: Map<string, number>; semantic: SemanticMatcher<T> },
): Promise<T[]> {
  const candidates = filterUnderReuseCap(rankInstalledCandidates(rows), opts.usageCounts);
  if (candidates.length === 0) return [];
  const fresh = candidates.filter((c) => !opts.recentlyUsed.has(c.id));

  const freshMatches = await bestMatches(opts.semantic, article, fresh, limit);
  const anyMatches = freshMatches.length >= limit ? [] : await bestMatches(opts.semantic, article, candidates, limit);
  const candidateIds = new Set(candidates.map((c) => c.id));
  return dedupeById([...freshMatches, ...anyMatches])
    .filter((a) => candidateIds.has(a.id) && isPostableAsset(a))
    .slice(0, limit);
}

async function selectionOptions(db: typeof DbClient, client: Anthropic) {
  return {
    recentlyUsed: await recentlyUsedAssetIds(db, RECENT_ASSET_WINDOW_DAYS),
    usageCounts: await assetUsageCounts(db, RECENT_ASSET_WINDOW_DAYS),
    semantic: (article: ArticleMatchContext, candidates: AssetRow[], limit: number) =>
      matchAssetsSemantic(client, article, candidates, limit),
  };
}

// Returns null when no installed photo matches the article (or the library
// has none). Callers record that as needs_asset; see app/api/cron/run-jobs.
export async function selectAssetForArticle(
  db: typeof DbClient,
  client: Anthropic,
  article: ArticleMatchContext,
): Promise<AssetRow | null> {
  const rows = await loadCandidates(db);
  if (rows.length === 0) return null;
  const [match] = await chooseAssets(rows, article, 1, await selectionOptions(db, client));
  return match ?? null;
}

// Returns up to `limit` distinct matches (best first) instead of one —
// used by the Instagram carousel renderer so slides don't all reuse the
// same single photo. Returns [] when no installed photo matches; callers
// cycle through a short list rather than treating it as an error.
export async function selectAssetsForArticle(
  db: typeof DbClient,
  client: Anthropic,
  article: ArticleMatchContext,
  limit: number,
): Promise<AssetRow[]> {
  const rows = await loadCandidates(db);
  if (rows.length === 0) return [];
  return chooseAssets(rows, article, limit, await selectionOptions(db, client));
}
