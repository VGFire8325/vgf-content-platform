import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";
import { buildShopifyAuthorizeUrl } from "@/lib/platforms/shopify";

export const runtime = "nodejs";

export async function GET() {
  const { SHOPIFY_CLIENT_ID, SHOPIFY_MYSHOPIFY_DOMAIN, APP_BASE_URL } = requireEnv(
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_MYSHOPIFY_DOMAIN",
    "APP_BASE_URL",
  );
  const state = randomBytes(16).toString("hex");
  const redirectUri = `${APP_BASE_URL}/api/oauth/shopify/callback`;

  const cookieStore = await cookies();
  cookieStore.set("shopify_oauth_state", state, { httpOnly: true, secure: true, maxAge: 600, path: "/" });

  return Response.redirect(
    buildShopifyAuthorizeUrl(SHOPIFY_MYSHOPIFY_DOMAIN, SHOPIFY_CLIENT_ID, redirectUri, state),
    302,
  );
}
