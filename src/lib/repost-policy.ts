// LinkedIn no-repeat rule (Spec 2, 2026-10) — added after the same
// article went out twice within days (Placement Ideas Oct 5 + Oct 6,
// the Amantii guide Sep 30 + Oct 2). Root cause: syncArticleFromShopify
// (src/lib/platforms/shopify-articles.ts) re-enqueues extract_article
// (and so a fresh generate_content) on any content-hash change or
// unpublish/republish cycle, with nothing checking whether that article
// already has a recent LinkedIn post. content_items itself (createdAt +
// status, one row per generated post) is already the history this gate
// needs — no new storage was required for that part.

export const DEFAULT_LINKEDIN_REPOST_GAP_DAYS = 60;

// Pure gate: true if `previousPostAt` falls inside the no-repeat
// window, i.e. a new LinkedIn post for the same article should be
// skipped. `null` (no prior post at all) never blocks.
export function isWithinLinkedInRepostGap(
  previousPostAt: Date | null,
  now: Date,
  gapDays: number = DEFAULT_LINKEDIN_REPOST_GAP_DAYS,
): boolean {
  if (!previousPostAt) return false;
  const gapMs = gapDays * 24 * 60 * 60 * 1000;
  return now.getTime() - previousPostAt.getTime() < gapMs;
}

// Pulls the first sentence out of a post body to compare "opening
// line" between a deliberate repost and the post it's repeating.
// Splits on the first sentence-ending punctuation; falls back to the
// first line, then the whole trimmed text, for copy with no punctuation
// at all (so this never throws on an empty match).
export function extractOpeningLine(postText: string): string {
  const trimmed = postText.trim();
  const sentenceMatch = trimmed.match(/^.*?[.!?](?=\s|$)/);
  if (sentenceMatch) return sentenceMatch[0].trim();
  const firstLine = trimmed.split("\n")[0]?.trim();
  return firstLine || trimmed;
}

export interface RepostDistinctness {
  angle: string;
  openingLine: string;
}

// A deliberate repost (forceRepost: true) is only allowed to bypass the
// gap check — it must still land on an actually different angle and
// opening line than what it's repeating, per the spec. Returns the
// specific reasons it's too similar (empty = distinct enough), so the
// caller can flag rather than silently drop or auto-rewrite it.
export function checkRepostDistinctness(
  candidate: RepostDistinctness,
  previous: RepostDistinctness,
): string[] {
  const reasons: string[] = [];
  if (candidate.angle.trim().toLowerCase() === previous.angle.trim().toLowerCase()) {
    reasons.push(`Deliberate repost uses the same angle as the previous post ("${previous.angle}")`);
  }
  if (candidate.openingLine.trim().toLowerCase() === previous.openingLine.trim().toLowerCase()) {
    reasons.push("Deliberate repost opens with the same line as the previous post");
  }
  return reasons;
}
