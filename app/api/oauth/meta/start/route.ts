import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";
import { buildMetaAuthorizeUrl } from "@/lib/platforms/meta";

export const runtime = "nodejs";

export async function GET() {
  const { META_APP_ID, APP_BASE_URL } = requireEnv("META_APP_ID", "APP_BASE_URL");
  const state = randomBytes(16).toString("hex");
  const redirectUri = `${APP_BASE_URL}/api/oauth/meta/callback`;

  const cookieStore = await cookies();
  cookieStore.set("meta_oauth_state", state, { httpOnly: true, secure: true, maxAge: 600, path: "/" });

  return Response.redirect(buildMetaAuthorizeUrl(META_APP_ID, redirectUri, state), 302);
}
