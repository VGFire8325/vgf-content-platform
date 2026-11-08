// Audience / content-type tagging (Spec 4, one-month test, 2026-10).
// Deterministic, not model-driven — this only needs to be a reasonable
// first guess, since it's editable by a reviewer in the Review Queue,
// and a cheap heuristic avoids adding another paid Anthropic call to
// every generate_content run for a feature explicitly scoped as a
// one-month trial.

export type AudienceTag = "homeowner" | "trade";
export type TopicTag = "how_to" | "comparison" | "buying_guide" | "trade";
export type PlatformFit = "preferred" | "neutral" | "off_preference";

// Format/hook tags (2026-11, for the monthly social-performance review)
// — same "cheap deterministic heuristic, editable by a reviewer" design
// as the Spec 4 tags above, not a model call: these only need to be a
// reasonable first guess for post_performance_by_tag's aggregates.
export type FormatTag = "image-pin" | "text-only" | "carousel" | "quote" | "list";
export type HookType = "question" | "stat" | "how-to" | "bold-claim" | "other";

const TRADE_AUDIENCE_KEYWORDS = [
  "contractor",
  "builder",
  "installer",
  "architect",
  "designer",
  "remodeler",
  "property manager",
  "dealer",
  "retailer",
  "trade",
  "professional",
];

// extraction.audience is free text (extractArticle's prompt asks for
// "homeowner, contractor, designer, etc." — not a fixed enum), so this
// matches on the trade-professional vocabulary the extraction prompt
// itself uses rather than expecting an exact value.
export function inferAudienceTag(extraction: { audience: string }): AudienceTag {
  const text = extraction.audience.toLowerCase();
  return TRADE_AUDIENCE_KEYWORDS.some((k) => text.includes(k)) ? "trade" : "homeowner";
}

// Shopify's fixed blog category taxonomy (see BLOG_CATEGORY_TAGS in
// src/lib/assets.ts for the full seven) gives a direct, reliable signal
// for two of the four topic tags before falling back to keyword
// matching against the extraction's own text.
const CATEGORY_TAG_TOPIC: Partial<Record<string, TopicTag>> = {
  comparisons: "comparison",
  installation: "how_to",
};

export function inferTopicTag(
  article: { tags: string[] },
  extraction: { searchIntent: string; coreSubject: string },
): TopicTag {
  for (const tag of article.tags) {
    const mapped = CATEGORY_TAG_TOPIC[tag.toLowerCase()];
    if (mapped) return mapped;
  }

  const text = `${extraction.searchIntent} ${extraction.coreSubject}`.toLowerCase();
  if (/\bvs\b|\bversus\b|compar/.test(text)) return "comparison";
  if (/\bhow to\b|\binstall/.test(text)) return "how_to";
  if (/\bcontractors?\b|\bbuilders?\b|\binstallers?\b|\barchitects?\b|\bdesigners?\b|\bproperty managers?\b|\btrades?\b/.test(text)) {
    return "trade";
  }
  // Most remaining consumer content on this blog is "which one should I
  // get" — the most common catch-all for a retail content blog once
  // comparison/how-to/trade signals are ruled out.
  return "buying_guide";
}

// Topic alone decides the LinkedIn lean (comparison/buying-guide/trade
// articles, per the spec's own wording); audience only comes in for the
// Pinterest lean, where it's combined with topic. That leaves one
// genuinely neutral combination — a trade-audience how-to article —
// rather than forcing every article into one lean or the other.
function leansLinkedIn(topicTag: TopicTag): boolean {
  return topicTag === "comparison" || topicTag === "buying_guide" || topicTag === "trade";
}

function leansPinterest(audienceTag: AudienceTag, topicTag: TopicTag): boolean {
  return audienceTag === "homeowner" && topicTag === "how_to";
}

// Advisory-only routing preference (Spec 4b): LinkedIn leans toward
// comparison/buying-guide/trade articles, Pinterest toward homeowner
// how-to articles. Never gates generation — see runGenerateContent in
// app/api/cron/run-jobs/route.ts, which still generates for every
// enabled platform regardless of this label; it's purely informational
// for the reviewer, and callers skip calling this entirely when
// AUDIENCE_PLATFORM_PREFERENCE_ENABLED is off.
export function platformFitForArticle(
  platform: "pinterest" | "linkedin" | "facebook" | "instagram",
  audienceTag: AudienceTag,
  topicTag: TopicTag,
): PlatformFit {
  if (platform === "linkedin") {
    if (leansLinkedIn(topicTag)) return "preferred";
    if (leansPinterest(audienceTag, topicTag)) return "off_preference";
    return "neutral";
  }
  if (platform === "pinterest") {
    if (leansPinterest(audienceTag, topicTag)) return "preferred";
    if (leansLinkedIn(topicTag)) return "off_preference";
    return "neutral";
  }
  return "neutral";
}

// contentType alone decides format for Pinterest/Instagram, which are
// always an image pin or an image carousel respectively — there's
// nothing in the generated copy to look at. LinkedIn/Facebook post a
// single block of text that may itself be shaped like a quote or a
// list, which the copy's own opening and structure can signal; the
// thumbnail they may or may not get is decided later at publish time
// (an approved photo may or may not match), so it's never a factor here.
export function inferFormatTag(
  contentType: "pinterest_pin" | "linkedin_post" | "fb_post" | "ig_carousel",
  primaryText: string,
): FormatTag {
  if (contentType === "pinterest_pin") return "image-pin";
  if (contentType === "ig_carousel") return "carousel";

  const trimmed = primaryText.trim();
  if (/^[“"].+[”"]$/.test(trimmed)) return "quote";
  const listLineCount = trimmed.split("\n").filter((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line)).length;
  if (listLineCount >= 2) return "list";
  return "text-only";
}

// Opening-line pattern match (reuses extractOpeningLine's "first
// sentence, or first line" rule — src/lib/repost-policy.ts — so a hook
// tag and the repost-distinctness check agree on what "the opening" of
// a post means). Order matters: "how to" is checked before the general
// question-word list, since "how" would otherwise match there first.
export function inferHookType(openingText: string): HookType {
  const text = openingText.trim();
  if (/^how to\b/i.test(text)) return "how-to";
  if (/^\$?\d/.test(text) || /\d+%/.test(text)) return "stat";
  if (text.endsWith("?") || /^(do|does|did|is|are|was|were|can|could|should|would|will|why|what|how|when|where|who)\b/i.test(text)) {
    return "question";
  }
  if (/\b(never|always|the #1|biggest mistake|the truth about|the secret)\b/i.test(text) || /^stop\b/i.test(text)) {
    return "bold-claim";
  }
  return "other";
}
