import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Verifies the X-Shopify-Hmac-Sha256 header against the raw request body.
// Must run against the raw bytes, before any JSON parsing.
export function verifyShopifyHmac(rawBody: string, hmacHeader: string | null, secret: string): boolean {
  if (!hmacHeader) return false;

  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  const computedBuf = Buffer.from(computed, "base64");
  const providedBuf = Buffer.from(hmacHeader, "base64");
  if (computedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(computedBuf, providedBuf);
}

// Shape of Shopify's Article webhook payload (articles/create, articles/update).
// This is the legacy REST resource shape, which is what Shopify webhooks
// send regardless of which Admin API version the rest of the app uses.
export const shopifyArticleWebhookSchema = z.object({
  id: z.number(),
  blog_id: z.number(),
  title: z.string(),
  handle: z.string(),
  body_html: z.string().nullable(),
  tags: z.string(), // comma-separated
  published_at: z.string().nullable(),
  updated_at: z.string(),
});

export type ShopifyArticleWebhookPayload = z.infer<typeof shopifyArticleWebhookSchema>;
