import { tokenize } from "./assets";

// Pinterest pin quality gate (Spec 3, 2026-10) — added after several
// live pins had no real title and one pin was created twice for the
// same article/photo. Every check here is a deterministic heuristic,
// not a model call: the gate's job is to flag likely misses for a human
// to check, never to invent or "fix" copy itself (hard rule). A pin
// that fails a check still reaches the Review Queue — see qualityFlags
// on content_items — it's just flagged with why.

function hasTokenOverlap(a: string, b: string): boolean {
  const aWords = tokenize(a);
  const bWords = tokenize(b);
  for (const w of aWords) {
    for (const v of bWords) {
      if (w.startsWith(v) || v.startsWith(w)) return true;
    }
  }
  return false;
}

// Check 1: title leads with a search keyword for the article's topic —
// looks at just the first few words (how a Pinterest searcher's own
// phrasing tends to front-load the keyword), not the whole title.
export function pinTitleLeadsWithKeyword(title: string, topicKeywords: string[]): boolean {
  const leadWords = title.trim().split(/\s+/).slice(0, 6).join(" ");
  return topicKeywords.some((keyword) => hasTokenOverlap(leadWords, keyword));
}

// Check 2: description answers the search the pin targets — a loose
// but deterministic proxy is topical overlap with the title plus a
// minimum length, so an empty or generic description still fails even
// though it may technically share a word with the title.
export function pinDescriptionAnswersSearch(title: string, description: string): boolean {
  if (description.trim().length < 20) return false;
  return hasTokenOverlap(title, description);
}

// Check 3: alt text describes the actual image. Without a real image
// to compare against (not yet selected — see the generation-time vs.
// render-time call sites in app/api/cron/run-jobs/route.ts) this can
// only check the alt text isn't a one- or two-word placeholder; once an
// asset is selected, it checks the alt text actually overlaps with that
// asset's own tags/notes.
export function pinAltTextDescribesImage(altText: string, imageTags: string[] = [], imageNotes?: string | null): boolean {
  const trimmed = altText.trim();
  if (trimmed.length < 10) return false;
  const imageText = [...imageTags, imageNotes ?? ""].join(" ").trim();
  if (!imageText) return true; // nothing to check against — don't fail on a library gap
  return hasTokenOverlap(trimmed, imageText);
}

// Check 4: destination link points at the matching blog article —
// compares origin+pathname only, so this still passes once UTM params
// are attached (withPinterestUtm appends query params, never changes
// the path).
export function pinLinkMatchesArticle(pinLink: string, articleUrl: string): boolean {
  try {
    const a = new URL(pinLink);
    const b = new URL(articleUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

// Check 5: not a duplicate of an existing pin for the same article and
// image. A null assetId (image not selected yet) never counts as a
// match on either side — two pins both still waiting on image
// selection aren't "the same image," they're both unknown yet.
export function isDuplicatePinterestPin(
  existingPins: { articleId: string; assetId: string | null }[],
  candidate: { articleId: string; assetId: string | null },
): boolean {
  if (!candidate.assetId) return false;
  return existingPins.some((p) => p.articleId === candidate.articleId && p.assetId === candidate.assetId);
}

export interface PinterestPinQualityContext {
  articleId: string;
  title: string;
  description: string;
  altText: string;
  topicKeywords: string[];
  pinLink: string;
  articleUrl: string;
  // Omitted at generation time (before render_image picks a photo);
  // present at render time once the real asset is known.
  image?: { assetId: string; tags: string[]; notes?: string | null };
  existingPins: { articleId: string; assetId: string | null }[];
}

// Orchestrates all five checks into the flag list stored on
// content_items.qualityFlags. Called twice in the real pipeline: once
// right after generation (checks 1/2/4 and a cheap alt-text-placeholder
// check, since no image is picked yet) and again after render_image
// selects the real photo (full check 3 + the duplicate check 5).
export function evaluatePinterestPinQuality(ctx: PinterestPinQualityContext): string[] {
  const flags: string[] = [];

  if (!pinTitleLeadsWithKeyword(ctx.title, ctx.topicKeywords)) {
    flags.push("Title doesn't lead with a search keyword for this article's topic");
  }
  if (!pinDescriptionAnswersSearch(ctx.title, ctx.description)) {
    flags.push("Description doesn't clearly answer the search this pin targets");
  }
  if (!pinLinkMatchesArticle(ctx.pinLink, ctx.articleUrl)) {
    flags.push("Destination link doesn't point to this article");
  }

  if (ctx.image) {
    if (!pinAltTextDescribesImage(ctx.altText, ctx.image.tags, ctx.image.notes)) {
      flags.push("Alt text doesn't appear to describe the selected image");
    }
    if (isDuplicatePinterestPin(ctx.existingPins, { articleId: ctx.articleId, assetId: ctx.image.assetId })) {
      flags.push("Possible duplicate — another pin already uses this article and image");
    }
  } else if (!pinAltTextDescribesImage(ctx.altText)) {
    flags.push("Alt text looks too short to describe an image");
  }

  return flags;
}
