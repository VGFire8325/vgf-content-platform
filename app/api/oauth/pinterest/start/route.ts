import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";
import { buildPinterestAuthorizeUrl } from "@/lib/platforms/pinterest";

export const runtime = "nodejs";

export async function GET() {
  const { PINTEREST_APP_ID, APP_BASE_URL } = requireEnv("PINTEREST_APP_ID", "APP_BASE_URL");
  const state = randomBytes(16).toString("hex");
  const redirectUri = `${APP_BASE_URL}/api/oauth/pinterest/callback`;

  const cookieStore = await cookies();
  cookieStore.set("pinterest_oauth_state", state, { httpOnly: true, secure: true, maxAge: 600, path: "/" });

  return Response.redirect(buildPinterestAuthorizeUrl(PINTEREST_APP_ID, redirectUri, state), 302);
}
