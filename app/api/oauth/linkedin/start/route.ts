import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";
import { buildLinkedInAuthorizeUrl } from "@/lib/platforms/linkedin";

export const runtime = "nodejs";

export async function GET() {
  const { LINKEDIN_CLIENT_ID, APP_BASE_URL } = requireEnv("LINKEDIN_CLIENT_ID", "APP_BASE_URL");
  const state = randomBytes(16).toString("hex");
  const redirectUri = `${APP_BASE_URL}/api/oauth/linkedin/callback`;

  const cookieStore = await cookies();
  cookieStore.set("linkedin_oauth_state", state, { httpOnly: true, secure: true, maxAge: 600, path: "/" });

  return Response.redirect(buildLinkedInAuthorizeUrl(LINKEDIN_CLIENT_ID, redirectUri, state), 302);
}
