import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { platformConnections } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { META_SCOPES, exchangeMetaCode, listConnectedPages, refreshMetaUserToken } from "@/lib/platforms/meta";
import { scheduleUnscheduledApprovedItems } from "@/lib/publish-scheduling";
import { storeSecret, updateSecret } from "@/lib/vault";

export const runtime = "nodejs";

async function upsertConnection(platform: "facebook" | "instagram", externalAccountId: string, displayName: string, accessToken: string) {
  const [existing] = await db.select().from(platformConnections).where(eq(platformConnections.platform, platform)).limit(1);
  if (existing) {
    await updateSecret(db, existing.accessTokenVaultId, accessToken);
    await db
      .update(platformConnections)
      .set({ status: "connected", externalAccountId, displayName })
      .where(eq(platformConnections.id, existing.id));
  } else {
    const accessTokenVaultId = await storeSecret(db, accessToken, `${platform}_access_token`);
    await db.insert(platformConnections).values({
      platform,
      externalAccountId,
      displayName,
      accessTokenVaultId,
      scopes: META_SCOPES.split(","),
      status: "connected",
    });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("meta_oauth_state")?.value;
  cookieStore.delete("meta_oauth_state");

  if (!code || !state || !expectedState || state !== expectedState) {
    return new Response("Invalid OAuth state or missing code", { status: 400 });
  }

  const { META_APP_ID, META_APP_SECRET, APP_BASE_URL } = requireEnv("META_APP_ID", "META_APP_SECRET", "APP_BASE_URL");
  const redirectUri = `${APP_BASE_URL}/api/oauth/meta/callback`;

  const shortLived = await exchangeMetaCode(META_APP_ID, META_APP_SECRET, code, redirectUri);
  const longLived = await refreshMetaUserToken(META_APP_ID, META_APP_SECRET, shortLived.access_token);
  const pages = await listConnectedPages(longLived.access_token);

  // Single-Page assumption: VGF has one Facebook Page, and this is a
  // single-user tool, so the first Page the connecting account
  // administers is the right one for V1. A multi-Page picker would be
  // easy to add later without a schema change if that ever stops being
  // true.
  const page = pages[0];
  if (!page) {
    return new Response(
      "No Facebook Page found for this account. Reconnect using the account that manages the VGF Page.",
      { status: 400 },
    );
  }

  await upsertConnection("facebook", page.id, page.name, page.access_token);
  if (page.instagram_business_account) {
    await upsertConnection(
      "instagram",
      page.instagram_business_account.id,
      `${page.name} (Instagram)`,
      page.access_token,
    );
  }

  // Only Facebook auto-schedules on approve (Instagram never does, per
  // scheduleApprovedItem — it needs a rendered carousel regardless of
  // connection status), so only Facebook has a catch-up gap to sweep.
  await scheduleUnscheduledApprovedItems(db, "facebook");

  return Response.redirect(`${APP_BASE_URL}/review`, 302);
}
