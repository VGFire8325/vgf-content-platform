import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { platformConnections } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { PlatformAuthError } from "@/lib/platforms/errors";
import { listBoards, refreshPinterestToken } from "@/lib/platforms/pinterest";
import { readSecret, updateSecret } from "@/lib/vault";

export const runtime = "nodejs";

// Temporary, read-only diagnostic for the Pinterest Standard-access
// cutover (2026-10): lets us review the real boards on the connected
// account — and map them to blog categories — before anything gets
// created or published. Never calls a Pinterest write endpoint. Gated
// on its own secret (not CRON_SECRET) so this one-off check doesn't
// need that credential's value handled outside the app. Safe to delete
// this route (and ADMIN_DIAGNOSTIC_SECRET) once the board-mapping work
// is done.
export async function GET(request: Request) {
  const { ADMIN_DIAGNOSTIC_SECRET } = requireEnv("ADMIN_DIAGNOSTIC_SECRET");
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${ADMIN_DIAGNOSTIC_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [connection] = await db
    .select()
    .from(platformConnections)
    .where(eq(platformConnections.platform, "pinterest"))
    .limit(1);
  if (!connection) {
    return new Response("No Pinterest connection found", { status: 404 });
  }

  const accessToken = await readSecret(db, connection.accessTokenVaultId);

  try {
    const boards = await listBoards(accessToken);
    return Response.json({ connectionStatus: connection.status, expiresAt: connection.expiresAt, boards });
  } catch (err) {
    if (!(err instanceof PlatformAuthError) || !connection.refreshTokenVaultId) {
      throw err;
    }
    // Same one-shot refresh-and-retry the publish path uses — the
    // access token is known expired (see run-jobs/route.ts's
    // attemptRefresh), so this is expected on the first call since
    // Sept 5's last rotation, not a surprise.
    const { PINTEREST_APP_ID, PINTEREST_APP_SECRET } = requireEnv("PINTEREST_APP_ID", "PINTEREST_APP_SECRET");
    const refreshToken = await readSecret(db, connection.refreshTokenVaultId);
    const tokens = await refreshPinterestToken(PINTEREST_APP_ID, PINTEREST_APP_SECRET, refreshToken);
    await updateSecret(db, connection.accessTokenVaultId, tokens.access_token);
    await updateSecret(db, connection.refreshTokenVaultId, tokens.refresh_token);
    await db
      .update(platformConnections)
      .set({ expiresAt: new Date(Date.now() + tokens.expires_in * 1000) })
      .where(eq(platformConnections.id, connection.id));

    const boards = await listBoards(tokens.access_token);
    return Response.json({ connectionStatus: "connected", refreshed: true, boards });
  }
}
