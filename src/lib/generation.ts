import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { BRAND_CORE, callStructuredTool } from "./anthropic";
import type { Extraction } from "./anthropic";

type Platform = "pinterest" | "linkedin" | "facebook" | "instagram";
type ContentType = "pinterest_pin" | "linkedin_post" | "fb_post" | "ig_carousel";

export const CONTENT_TYPE_BY_PLATFORM: Record<Platform, ContentType> = {
  pinterest: "pinterest_pin",
  linkedin: "linkedin_post",
  facebook: "fb_post",
  instagram: "ig_carousel",
};

// How many distinct posts to generate per platform per article. Pinterest
// was originally "multiple pin concepts" per the brief, but Brendan's
// explicit rule once Standard API access went live (2026-10-06) is one
// pin per article — the others are one post per article per the brief's
// "light touch" scope for Facebook/Instagram and single reframed post
// for LinkedIn.
export const POSTS_PER_PLATFORM: Record<Platform, number> = {
  pinterest: 1,
  linkedin: 1,
  facebook: 1,
  instagram: 1,
};

const pinterestPinSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  altText: z.string().min(1),
  suggestedBoard: z.string().min(1),
  imageConcept: z.string().min(1),
});

const linkedinPostSchema = z.object({
  postText: z.string().min(1),
  angle: z.string().min(1),
  // Benefit-led CTA line the publish step appends after postText, ahead
  // of the UTM-tagged article link (Spec 1) — generated per-article
  // rather than a fixed string so it actually names what the reader
  // gets, same reasoning as angle. Never a link itself; the publish
  // step is the only place the link gets added (composeLinkedInPost in
  // src/lib/linkedin-post.ts).
  cta: z.string().min(1).max(140),
});

const facebookPostSchema = z.object({
  postText: z.string().min(1),
  imageConcept: z.string().min(1),
});

const instagramCarouselSchema = z.object({
  caption: z.string().min(1),
  slides: z.array(z.string().min(1)).min(2).max(8),
});

export const POST_SCHEMA_BY_PLATFORM = {
  pinterest: pinterestPinSchema,
  linkedin: linkedinPostSchema,
  facebook: facebookPostSchema,
  instagram: instagramCarouselSchema,
} satisfies Record<Platform, z.ZodType>;

export type PinterestPin = z.infer<typeof pinterestPinSchema>;
export type LinkedinPost = z.infer<typeof linkedinPostSchema>;
export type FacebookPost = z.infer<typeof facebookPostSchema>;
export type InstagramCarousel = z.infer<typeof instagramCarouselSchema>;
export type PlatformPost = PinterestPin | LinkedinPost | FacebookPost | InstagramCarousel;

function postsArraySchema(platform: Platform) {
  return z.object({ posts: z.array(POST_SCHEMA_BY_PLATFORM[platform]).min(1) });
}

const PLATFORM_INSTRUCTIONS: Record<Platform, string> = {
  pinterest: `Generate exactly one Pinterest pin concept for this article.

Return:
- title: the main search phrase in natural wording — how someone would
  actually phrase what they're looking for, not a keyword fragment.
  Under 100 characters.
- description: 1-2 natural sentences, written the way a person would
  write them. Work the primary keyword into the first sentence and one
  or two related terms in naturally elsewhere. Say what the reader will
  learn or decide. Never a pipe-separated list of search phrases, never
  hashtags, never keyword stuffing.
- altText: a plain, literal description of what the pin's photo shows,
  for someone who can't see the image — not marketing copy.
- suggestedBoard: a board name for this topic.
- imageConcept: what the pin graphic should show. The photo must show
  the product installed in a real room or setting — never an isolated
  studio/white-background product shot and never an AI-rendered visual.
  If you can't describe a plausible installed-in-setting shot for this
  article, say so rather than defaulting to a plain product photo.

Brand voice: sophisticated, not salesy. Match the tone of these examples:

1. Article "Electric Fireplace Sizes Explained: 26 to 120 Inches"
   title: "How to Choose the Right Electric Fireplace Size for Your Wall"
   description: "Not sure how wide your electric fireplace should be? This guide walks through sizing for your wall, your room, and your TV setup, so you pick the right fit the first time."

2. Article "Built-In vs Wall Mounted Electric Fireplaces"
   title: "Built-In or Wall Mounted Electric Fireplace? How to Decide"
   description: "Building a media wall or updating a room? Here's how built-in and wall mounted electric fireplaces compare for remodels, bedrooms, and TV walls, and which one suits your project."

3. Article "Water Vapor Fireplaces: Everything You Need to Know"
   title: "Water Vapor Fireplaces: Are They Worth It?"
   description: "Water vapor fireplaces create a strikingly realistic flame effect. This guide covers how they work, where they fit best, what maintenance involves, and what to expect on cost."

4. Article "Can You Mount a TV Above an Electric Fireplace?"
   title: "Can You Mount a TV Above an Electric Fireplace?"
   description: "A TV above the fireplace is a popular layout, but heat and wall placement matter. Here's what to check before you hang the screen."`,
  linkedin: `Reframe this article for a professional audience: builders,
contractors, remodelers, architects, designers, property managers. Do
not summarize or copy the consumer article's intro — take a
specification, installation, or project-planning angle a professional
would actually care about. Return:
- postText: the LinkedIn post body. Do not include a call-to-action
  line, a link, or a URL — those are appended automatically after this.
- angle: one sentence naming which professional angle you took.
- cta: one short, benefit-led call-to-action sentence (e.g. "See which
  placement fits your room" or "Compare the options before you
  choose") naming what the reader gets by clicking through. Never a
  generic "learn more," and never a link itself.`,
  facebook: `Write one lightweight, credible Facebook post based on this
article. Facebook is a light-touch, roughly-weekly channel here — the
goal is staying active and credible, not promotional. Return postText
and imageConcept (what photo/graphic to pair with it, favoring approved
photography).`,
  instagram: `Write an Instagram carousel concept adapting this article. Return
caption (teach-first, not engagement bait) and slides: an ordered array
of 3-6 short slide concepts, each describing what that slide shows and
says. The visuals should adapt Pinterest/article imagery without
looking recycled — note briefly how each slide's visual differs from
the others.`,
};

function buildArticleContext(articleTitle: string, extraction: Extraction): string {
  return `Article title: ${articleTitle}
Core subject: ${extraction.coreSubject}
Audience: ${extraction.audience}
Search intent: ${extraction.searchIntent}

Key takeaways:
${extraction.keyTakeaways.map((t) => `- ${t}`).join("\n")}

Claims this article supports (you may only assert these, nothing else):
${extraction.supportedClaims.map((c) => `- ${c}`).join("\n") || "(none identified)"}`;
}

// The raw JSON-schema shape of one post per platform — shared by the
// "generate N posts" tool (wrapped in an array) and the "edit this one
// post" tool (used bare) so the two tool defs can't drift apart.
function postJsonSchema(platform: Platform): { properties: Record<string, unknown>; required: string[] } {
  switch (platform) {
    case "pinterest":
      return {
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          altText: { type: "string" },
          suggestedBoard: { type: "string" },
          imageConcept: { type: "string" },
        },
        required: ["title", "description", "altText", "suggestedBoard", "imageConcept"],
      };
    case "linkedin":
      return {
        properties: { postText: { type: "string" }, angle: { type: "string" }, cta: { type: "string" } },
        required: ["postText", "angle", "cta"],
      };
    case "facebook":
      return {
        properties: { postText: { type: "string" }, imageConcept: { type: "string" } },
        required: ["postText", "imageConcept"],
      };
    case "instagram":
      return {
        properties: { caption: { type: "string" }, slides: { type: "array", items: { type: "string" } } },
        required: ["caption", "slides"],
      };
  }
}

function toolForPlatform(platform: Platform): Anthropic.Tool {
  const item = postJsonSchema(platform);
  return {
    name: "record_posts",
    description: `Records the generated ${platform} post(s).`,
    input_schema: {
      type: "object",
      properties: { posts: { type: "array", items: { type: "object", ...item } } },
      required: ["posts"],
    },
  };
}

function editToolForPlatform(platform: Platform): Anthropic.Tool {
  const item = postJsonSchema(platform);
  return {
    name: "record_edited_post",
    description: `Records the revised ${platform} post.`,
    input_schema: { type: "object", ...item },
  };
}

// postsArraySchema only enforces .min(1) — the model has been observed
// returning more posts than POSTS_PER_PLATFORM asks for (LinkedIn in
// particular: confirmed in production returning 2-3 "angles" for a
// platform meant to get exactly 1 per article, on roughly half of real
// generations since this was first built). Truncating here makes the
// cap actually a cap instead of a prompt suggestion the model is free
// to ignore. Pure and exported so it's unit-testable without a live
// model call.
export function capPostsToPlatformLimit<T>(platform: Platform, posts: T[]): T[] {
  return posts.slice(0, POSTS_PER_PLATFORM[platform]);
}

export async function generatePlatformContent(
  client: Anthropic,
  platform: Platform,
  articleTitle: string,
  extraction: Extraction,
): Promise<PlatformPost[]> {
  const system = `${BRAND_CORE}\n\n${PLATFORM_INSTRUCTIONS[platform]}`;
  const result = await callStructuredTool(client, {
    system,
    userContent: buildArticleContext(articleTitle, extraction),
    tool: toolForPlatform(platform),
    schema: postsArraySchema(platform),
    maxTokens: 2048,
  });
  return capPostsToPlatformLimit(platform, result.posts);
}

// Revises a single already-generated post per a reviewer instruction —
// backs both the free-text instruction box and the "regenerate just the
// headline/caption" buttons in the review UI (the latter just supplies a
// canned instruction). Grounding is NOT re-run here; callers are
// expected to call groundPosts() on the result themselves, same as after
// initial generation, so edited copy doesn't silently skip the check.
export async function editPlatformPost(
  client: Anthropic,
  platform: Platform,
  currentPost: PlatformPost,
  instruction: string,
): Promise<PlatformPost> {
  const system = `${BRAND_CORE}

You are revising a single already-generated ${platform} post based on a
specific instruction from the reviewer. Apply the instruction. Leave
everything the instruction doesn't implicate unchanged. Return the full
revised post in the same shape as the current post — do not add fields
that weren't there and do not drop fields that were.`;
  const userContent = `Current post:\n${JSON.stringify(currentPost, null, 2)}\n\nInstruction: ${instruction}`;

  return callStructuredTool(client, {
    system,
    userContent,
    tool: editToolForPlatform(platform),
    schema: POST_SCHEMA_BY_PLATFORM[platform] as z.ZodType<PlatformPost>,
    maxTokens: 1024,
  });
}

// Pulls the claim-bearing text out of a generated post so the grounding
// pass has something to check against supportedClaims.
export function claimBearingText(platform: Platform, post: PlatformPost): string {
  switch (platform) {
    case "pinterest": {
      const p = post as PinterestPin;
      return `${p.title}\n${p.description}`;
    }
    case "linkedin": {
      const p = post as LinkedinPost;
      return `${p.postText}\n${p.cta}`;
    }
    case "facebook":
      return (post as FacebookPost).postText;
    case "instagram": {
      const p = post as InstagramCarousel;
      return `${p.caption}\n${p.slides.join("\n")}`;
    }
  }
}

const groundingResultSchema = z.object({
  results: z.array(z.object({ index: z.number().int().min(0), flaggedClaims: z.array(z.string()) })),
});

const GROUNDING_TOOL: Anthropic.Tool = {
  name: "record_grounding",
  description: "Records which claims in each post are not supported by the source article.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            flaggedClaims: { type: "array", items: { type: "string" } },
          },
          required: ["index", "flaggedClaims"],
        },
      },
    },
    required: ["results"],
  },
};

const GROUNDING_SYSTEM_PROMPT = `${BRAND_CORE}

You are the claim-grounding check that runs before generated content
reaches human review. You will be given a list of supported claims from
the source article, and a numbered list of draft posts. For each post,
list any factual or technical claim it makes that is NOT covered by the
supported-claims list — phrasing differences are fine, but a genuinely
new fact, spec, or comparison that isn't backed by the list must be
flagged. If a post makes no ungrounded claims, return an empty array for
it. Do not flag brand voice, tone, or subjective statements — only
factual/technical claims.`;

// Discrete pass, run once per platform per article across all its
// generated posts in a single call (docs/PHASE_0_PLAN.md §3) — checks
// what was generated against what the article actually supports, rather
// than trusting the generation step to have policed itself.
export async function groundPosts(
  client: Anthropic,
  platform: Platform,
  posts: PlatformPost[],
  supportedClaims: string[],
): Promise<string[][]> {
  const userContent = `Supported claims:
${supportedClaims.map((c) => `- ${c}`).join("\n") || "(none identified)"}

Posts:
${posts.map((post, i) => `[${i}] ${claimBearingText(platform, post)}`).join("\n\n")}`;

  const { results } = await callStructuredTool(client, {
    system: GROUNDING_SYSTEM_PROMPT,
    userContent,
    tool: GROUNDING_TOOL,
    schema: groundingResultSchema,
    maxTokens: 1024,
  });

  const flagsByIndex = new Map(results.map((r) => [r.index, r.flaggedClaims]));
  return posts.map((_, i) => flagsByIndex.get(i) ?? []);
}

export const altTextResultSchema = z.object({ altText: z.string().min(1) });

const ALT_TEXT_TOOL: Anthropic.Tool = {
  name: "record_alt_text",
  description: "Records plain, literal alt text for a photo, based only on its tags and note.",
  input_schema: {
    type: "object",
    properties: { altText: { type: "string" } },
    required: ["altText"],
  },
};

const ALT_TEXT_SYSTEM_PROMPT = `${BRAND_CORE}

Write one sentence of plain, literal alt text for a product photo, for
someone who can't see the image. Base it only on the tags and note
given below — never invent a room, a person, an action, or any detail
they don't imply. The asset library here is mostly plain product
photos (imported from Shopify listings), not installed-in-room
lifestyle shots — if the tags/note only identify a product, describe
it as that: a product photo of that item, not a scene you're
imagining around it.`;

// Pinterest pin copy's altText is written at generation time, before
// render_image has picked the real photo — grounded only in the
// imagined imageConcept, not anything about the actual asset. For a
// library of plain product photos, that produced alt text describing
// elaborate installed/construction scenes with nothing to do with the
// real (often plain) product shot that ended up being used. Called
// from renderPinterestPinItem once the real asset is known, so this
// replaces that placeholder with something grounded in what the photo
// actually is.
export async function writeAltTextForAsset(
  client: Anthropic,
  asset: { tags: string[]; notes?: string | null },
): Promise<string> {
  const userContent = `Tags: ${asset.tags.join(", ") || "(none)"}\nNote: ${asset.notes ?? "(none)"}`;
  const { altText } = await callStructuredTool(client, {
    system: ALT_TEXT_SYSTEM_PROMPT,
    userContent,
    tool: ALT_TEXT_TOOL,
    schema: altTextResultSchema,
    maxTokens: 256,
  });
  return altText;
}
