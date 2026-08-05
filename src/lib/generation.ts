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
// is explicitly "multiple pin concepts" per the brief; the others are
// one post per article per the brief's "light touch" scope for
// Facebook/Instagram and single reframed post for LinkedIn.
export const POSTS_PER_PLATFORM: Record<Platform, number> = {
  pinterest: 3,
  linkedin: 1,
  facebook: 1,
  instagram: 1,
};

const pinterestPinSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  suggestedBoard: z.string().min(1),
  imageConcept: z.string().min(1),
});

const linkedinPostSchema = z.object({
  postText: z.string().min(1),
  angle: z.string().min(1),
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
  pinterest: `Generate ${POSTS_PER_PLATFORM.pinterest} distinct Pinterest pin concepts for this
article. Each needs: a title (Pinterest-style, benefit- or
question-driven, under 100 characters), a search-oriented description
written the way someone would actually search Pinterest, a suggested
board name, and an imageConcept describing what the pin graphic should
show — favor approved product/lifestyle photography over an AI-rendered
product visual. The three concepts should take genuinely different
angles on the article (e.g. different takeaways or different audience
questions), not three rewordings of the same pin.`,
  linkedin: `Reframe this article for a professional audience: builders,
contractors, remodelers, architects, designers, property managers. Do
not summarize or copy the consumer article's intro — take a
specification, installation, or project-planning angle a professional
would actually care about. Return postText (the LinkedIn post body) and
angle (one sentence naming which professional angle you took).`,
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
          suggestedBoard: { type: "string" },
          imageConcept: { type: "string" },
        },
        required: ["title", "description", "suggestedBoard", "imageConcept"],
      };
    case "linkedin":
      return {
        properties: { postText: { type: "string" }, angle: { type: "string" } },
        required: ["postText", "angle"],
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
  return result.posts;
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
    case "linkedin":
      return (post as LinkedinPost).postText;
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
