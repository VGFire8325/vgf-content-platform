// Composes the final LinkedIn post body from generated copy plus the
// CTA line and UTM-tagged link the publish step appends — kept out of
// generation.ts because this runs at publish time, not generation time,
// and out of article-url.ts because it's text composition, not URL
// building. The model is instructed (see PLATFORM_INSTRUCTIONS.linkedin
// in generation.ts) never to include its own link or CTA line, so this
// is the only place either one is added — that's what makes "exactly
// one CTA line and one UTM-tagged link" (Spec 1) true by construction
// rather than something that has to be checked after the fact.
export function composeLinkedInPost(postText: string, cta: string, taggedLink: string): string {
  return `${postText.trim()}\n\n${cta.trim()}\n${taggedLink}`;
}
