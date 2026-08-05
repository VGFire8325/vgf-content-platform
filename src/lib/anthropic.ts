import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const MODEL = "claude-sonnet-5";

export const BRAND_CORE = `Very Good Fireplaces is an electric fireplace ecommerce business. Brand
rule for all content: teach first, sell second — answer real questions
homeowners, builders, contractors, and designers actually have. No
engagement bait, no "here's a fireplace, check it out" posts, no
unsupported technical claims. Ground every claim in the material
provided below; never assert a claim that isn't explicitly listed as
supported.`;

export function createAnthropicClient(apiKey: string) {
  return new Anthropic({ apiKey });
}

// Forces a single tool call and validates its input against `schema`,
// shared by extraction, generation, and grounding — all of which need
// "call this exact tool, then trust nothing until it's parsed."
export async function callStructuredTool<T>(
  client: Anthropic,
  options: {
    system: string;
    userContent: string;
    tool: Anthropic.Tool;
    schema: z.ZodType<T>;
    maxTokens?: number;
  },
): Promise<T> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: options.maxTokens ?? 2048,
    system: options.system,
    tools: [options.tool],
    tool_choice: { type: "tool", name: options.tool.name },
    messages: [{ role: "user", content: options.userContent }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Model did not return a '${options.tool.name}' tool call`);
  }

  return options.schema.parse(toolUse.input);
}

export const extractionSchema = z.object({
  coreSubject: z.string().min(1),
  audience: z.string().min(1),
  searchIntent: z.string().min(1),
  keyTakeaways: z.array(z.string().min(1)).min(1),
  supportedClaims: z.array(z.string().min(1)),
});

export type Extraction = z.infer<typeof extractionSchema>;

const EXTRACTION_SYSTEM_PROMPT = `${BRAND_CORE}

You are analyzing one article to prepare it for downstream content
generation. Extract, from this article only:
- coreSubject: the single main topic, one sentence.
- audience: who this article is actually written for (homeowner,
  contractor, designer, etc.) — be specific, not "everyone."
- searchIntent: what question or need brought someone to search for this.
- keyTakeaways: the strongest, most concrete points a reader leaves with.
- supportedClaims: factual/technical claims the article text actually
  makes and directly supports (specs, installation requirements,
  comparisons). Only include claims with clear textual support — this
  list is what later generation steps are allowed to assert; anything
  not listed here is ungrounded.`;

const RECORD_EXTRACTION_TOOL: Anthropic.Tool = {
  name: "record_extraction",
  description: "Records the structured extraction of the article.",
  input_schema: {
    type: "object",
    properties: {
      coreSubject: { type: "string" },
      audience: { type: "string" },
      searchIntent: { type: "string" },
      keyTakeaways: { type: "array", items: { type: "string" } },
      supportedClaims: { type: "array", items: { type: "string" } },
    },
    required: ["coreSubject", "audience", "searchIntent", "keyTakeaways", "supportedClaims"],
  },
};

export async function extractArticle(
  client: Anthropic,
  articleTitle: string,
  articleBodyHtml: string,
): Promise<Extraction> {
  return callStructuredTool(client, {
    system: EXTRACTION_SYSTEM_PROMPT,
    userContent: `Article title: ${articleTitle}\n\nArticle body (HTML):\n${articleBodyHtml}`,
    tool: RECORD_EXTRACTION_TOOL,
    schema: extractionSchema,
  });
}
