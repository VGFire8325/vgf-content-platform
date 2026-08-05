import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify's authorization code grant — the standard OAuth flow every
// Shopify app (public or custom) uses to get a per-store Admin API
// token. As of Jan 1, 2026, apps created in the Dev Dashboard no longer
// get a static token handed to them in the admin, and the simpler
// client_credentials grant only works for stores in the same Shopify
// Organization as the app (dev stores, mainly) — it fails with
// `shop_not_permitted` against a real paid store like VGF's, which is
// why this app needs the full authorization code grant instead, not a
// shortcut. See docs/PHASE_0_PLAN.md "What Brendan Must Do" for context.

// read_content is the only scope this app has ever needed (§7 of the
// plan) — read access to blog articles.
export const SHOPIFY_SCOPES = "read_content";

const MYSHOPIFY_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

// Guards against a spoofed `shop` query param on the OAuth callback —
// Shopify's own docs call this out explicitly, since the callback
// otherwise trusts whatever domain is in the URL.
export function isValidMyshopifyDomain(shop: string): boolean {
  return MYSHOPIFY_DOMAIN_PATTERN.test(shop);
}

export function buildShopifyAuthorizeUrl(shopDomain: string, clientId: string, redirectUri: string, state: string): string {
  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

// The OAuth callback's query string is itself signed — a different
// mechanism from the webhook HMAC in shopify-webhook.ts (that one signs
// the raw POST body with a base64 digest; this one signs the sorted
// query params with a hex digest). Every field except `hmac` is
// included, sorted alphabetically by key and joined as `key=value&...`.
export function verifyShopifyOAuthCallback(searchParams: URLSearchParams, clientSecret: string): boolean {
  const hmac = searchParams.get("hmac");
  if (!hmac) return false;

  const pairs: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac") continue;
    pairs.push(`${key}=${value}`);
  }
  const message = pairs.sort().join("&");

  const computed = createHmac("sha256", clientSecret).update(message, "utf8").digest("hex");
  const computedBuf = Buffer.from(computed, "hex");
  const providedBuf = Buffer.from(hmac, "hex");
  if (computedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(computedBuf, providedBuf);
}

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
}

export async function exchangeShopifyCode(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<ShopifyTokenResponse> {
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (json as { error_description?: string; error?: string } | null)?.error_description ?? `Shopify OAuth error (HTTP ${response.status})`;
    throw new Error(message);
  }
  return json as ShopifyTokenResponse;
}
