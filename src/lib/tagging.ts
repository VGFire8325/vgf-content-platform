// Audience / content-type tagging (Spec 4, one-month test, 2026-10).
// Deterministic, not model-driven — this only needs to be a reasonable
// first guess, since it's editable by a reviewer in the Review Queue,
// and a cheap heuristic avoids adding another paid Anthropic call to
// every generate_content run for a feature explicitly scoped as a
// one-month trial.

export type AudienceTag = "homeowner" | "trade";
export type TopicTag = "how_to" | "comparison" | "buying_guide" | "trade";
export type PlatformFit = "preferred" | "neutral" | "off_preference";

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
