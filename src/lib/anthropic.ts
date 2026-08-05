import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const MODEL = "claude-sonnet-5";

export const extractionSchema = z.object({
  coreSubject: z.string().min(1),
  audience: z.string().min(1),
  searchIntent: z.string().min(1),
  keyTakeaways: z.array(z.string().min(1)).min(1),
  supportedClaims: z.array(z.string().min(1)),
});

export type Extraction = z.infer<typeof extractionSchema>;

const BRAND_PROMPT = `You are analyzing a blog article for Very Good Fireplaces, an electric
fireplace ecommerce business. The brand rule for all downstream content:
teach first, sell second — answer real questions homeowners, builders,
contractors, and designers have. No engagement bait, no unsupported
technical claims.

Extract, from this article only:
- coreSubject: the single main topic, one sentence.
- audience: who this article is actually written for (homeowner,
  contractor, designer, etc.) — be specific, not "everyone."
- searchIntent: what question or need brought someone to search for this.
- keyTakeaways: the strongest, most concrete points a reader leaves with.
- supportedClaims: factual/technical claims the article text actually
  makes and directly supports (specs, installation requirements,
  comparisons). Only include claims with clear textual support — this
  list is what later generation steps are allowed to assert; anything
  not listed here should be treated as ungrounded.`;

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
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: BRAND_PROMPT,
    tools: [RECORD_EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "record_extraction" },
    messages: [
      {
        role: "user",
        content: `Article title: ${articleTitle}\n\nArticle body (HTML):\n${articleBodyHtml}`,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Model did not return a record_extraction tool call");
  }

  return extractionSchema.parse(toolUse.input);
}

export function createAnthropicClient(apiKey: string) {
  return new Anthropic({ apiKey });
}
