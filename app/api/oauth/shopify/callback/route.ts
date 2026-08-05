import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { shopifyConnection } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { exchangeShopifyCode, isValidMyshopifyDomain, verifyShopifyOAuthCallback } from "@/lib/platforms/shopify";
import { storeSecret, updateSecret } from "@/lib/vault";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const shop = url.searchParams.get("shop");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("shopify_oauth_state")?.value;
  cookieStore.delete("shopify_oauth_state");

  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_MYSHOPIFY_DOMAIN, APP_BASE_URL } = requireEnv(
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
    "SHOPIFY_MYSHOPIFY_DOMAIN",
    "APP_BASE_URL",
  );

  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("Invalid OAuth state or missing code", { status: 400 });
  }
  // Both checks matter: the format check per Shopify's own guidance
  // against a crafted domain, and the exact-match check because this
  // app is wired to exactly one store — a callback for any other shop
  // (even a legitimate Shopify domain) isn't one this app should act on.
  if (!shop || !isValidMyshopifyDomain(shop) || shop !== SHOPIFY_MYSHOPIFY_DOMAIN) {
    return new Response("Unexpected shop domain", { status: 400 });
  }
  if (!verifyShopifyOAuthCallback(url.searchParams, SHOPIFY_CLIENT_SECRET)) {
    return new Response("Invalid OAuth callback signature", { status: 400 });
  }

  const tokens = await exchangeShopifyCode(shop, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, code);

  const [existing] = await db.select().from(shopifyConnection).limit(1);
  if (existing) {
    await updateSecret(db, existing.accessTokenVaultId, tokens.access_token);
    await db
      .update(shopifyConnection)
      .set({ shopDomain: shop, scope: tokens.scope, connectedAt: new Date() })
      .where(eq(shopifyConnection.id, existing.id));
  } else {
    const accessTokenVaultId = await storeSecret(db, tokens.access_token, "shopify_access_token");
    await db.insert(shopifyConnection).values({
      shopDomain: shop,
      accessTokenVaultId,
      scope: tokens.scope,
    });
  }

  return Response.redirect(`${APP_BASE_URL}/review`, 302);
}
