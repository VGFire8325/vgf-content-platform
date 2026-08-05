import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { platformConnections } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { PINTEREST_SCOPES, exchangePinterestCode } from "@/lib/platforms/pinterest";
import { storeSecret, updateSecret } from "@/lib/vault";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("pinterest_oauth_state")?.value;
  cookieStore.delete("pinterest_oauth_state");

  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("Invalid OAuth state or missing code", { status: 400 });
  }

  const { PINTEREST_APP_ID, PINTEREST_APP_SECRET, APP_BASE_URL } = requireEnv(
    "PINTEREST_APP_ID",
    "PINTEREST_APP_SECRET",
    "APP_BASE_URL",
  );
  const redirectUri = `${APP_BASE_URL}/api/oauth/pinterest/callback`;
  const tokens = await exchangePinterestCode(PINTEREST_APP_ID, PINTEREST_APP_SECRET, code, redirectUri);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  const [existing] = await db
    .select()
    .from(platformConnections)
    .where(eq(platformConnections.platform, "pinterest"))
    .limit(1);

  if (existing) {
    await updateSecret(db, existing.accessTokenVaultId, tokens.access_token);
    if (existing.refreshTokenVaultId) {
      await updateSecret(db, existing.refreshTokenVaultId, tokens.refresh_token);
    }
    await db
      .update(platformConnections)
      .set({ status: "connected", expiresAt })
      .where(eq(platformConnections.id, existing.id));
  } else {
    const accessTokenVaultId = await storeSecret(db, tokens.access_token, "pinterest_access_token");
    const refreshTokenVaultId = await storeSecret(db, tokens.refresh_token, "pinterest_refresh_token");
    await db.insert(platformConnections).values({
      platform: "pinterest",
      // Pinterest v5's token response doesn't include a stable account
      // id — fine for V1 since there's only ever one Pinterest
      // connection for this single-user tool.
      externalAccountId: "pinterest",
      displayName: "Pinterest",
      accessTokenVaultId,
      refreshTokenVaultId,
      scopes: PINTEREST_SCOPES.split(","),
      expiresAt,
      status: "connected",
    });
  }

  return Response.redirect(`${APP_BASE_URL}/review`, 302);
}
