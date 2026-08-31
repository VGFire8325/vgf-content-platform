import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { platformConnections } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { LINKEDIN_SCOPES, exchangeLinkedInCode, listAdministeredOrganizations } from "@/lib/platforms/linkedin";
import { storeSecret, updateSecret } from "@/lib/vault";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("linkedin_oauth_state")?.value;
  cookieStore.delete("linkedin_oauth_state");

  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("Invalid OAuth state or missing code", { status: 400 });
  }

  const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, APP_BASE_URL } = requireEnv(
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "APP_BASE_URL",
  );
  const redirectUri = `${APP_BASE_URL}/api/oauth/linkedin/callback`;
  const tokens = await exchangeLinkedInCode(LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, code, redirectUri);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Single-org assumption: VGF has one LinkedIn Page, and this is a
  // single-user tool, so the first organization the connecting account
  // administers is the right one — same pattern as Meta's "first Page."
  const organizations = await listAdministeredOrganizations(tokens.access_token);
  const organization = organizations[0];
  if (!organization) {
    return new Response(
      "No LinkedIn organization found for this account. Reconnect using the account that administers the VGF Page.",
      { status: 400 },
    );
  }

  const [existing] = await db
    .select()
    .from(platformConnections)
    .where(eq(platformConnections.platform, "linkedin"))
    .limit(1);

  if (existing) {
    await updateSecret(db, existing.accessTokenVaultId, tokens.access_token);
    if (tokens.refresh_token && existing.refreshTokenVaultId) {
      await updateSecret(db, existing.refreshTokenVaultId, tokens.refresh_token);
    }
    await db
      .update(platformConnections)
      .set({ status: "connected", expiresAt, externalAccountId: organization.urn, displayName: organization.name })
      .where(eq(platformConnections.id, existing.id));
  } else {
    const accessTokenVaultId = await storeSecret(db, tokens.access_token, "linkedin_access_token");
    // Whether a refresh_token shows up here isn't reliably tied to
    // Standard Tier approval — the live production connection got one
    // while still on Development Tier (confirmed against the real
    // token response, not assumed). Handled the same either way:
    // present or absent, this stays optional and the connection just
    // needs re-authorizing when the access token expires if it's null.
    const refreshTokenVaultId = tokens.refresh_token
      ? await storeSecret(db, tokens.refresh_token, "linkedin_refresh_token")
      : null;
    await db.insert(platformConnections).values({
      platform: "linkedin",
      externalAccountId: organization.urn,
      displayName: organization.name,
      accessTokenVaultId,
      refreshTokenVaultId,
      scopes: LINKEDIN_SCOPES.split(" "),
      expiresAt,
      status: "connected",
    });
  }

  return Response.redirect(`${APP_BASE_URL}/review`, 302);
}
