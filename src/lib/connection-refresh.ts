import { and, eq, inArray, sql } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { jobs, platformConnections } from "@/db/schema";
import { requireEnv } from "@/lib/env";
import { openAlert, resolveAlert } from "@/lib/alerts";
import { enqueueJob } from "@/lib/jobs";
import { PlatformAuthError, PlatformValidationError } from "@/lib/platforms/errors";
import { refreshLinkedInToken } from "@/lib/platforms/linkedin";
import { refreshMetaUserToken } from "@/lib/platforms/meta";
import { refreshPinterestToken } from "@/lib/platforms/pinterest";
import { readSecret, updateSecret } from "@/lib/vault";

export type PlatformConnectionRow = typeof platformConnections.$inferSelect;
type DB = typeof DbClient;

export function reconnectAlertKey(connectionId: string): string {
  return `platform_connection_reconnect:${connectionId}`;
}

export type RefreshResult =
  | { ok: true; accessToken: string }
  // "rejected": the platform's OAuth endpoint actively rejected the
  // refresh (invalid_grant, revoked token, etc, classified as a 4xx) —
  // retrying with the same refresh token can't succeed. "transient": a
  // 5xx/network failure talking to the OAuth endpoint — worth retrying
  // on the job's normal backoff.
  | { ok: false; reason: "not_applicable" | "no_refresh_token" | "rejected" | "transient"; message?: string };

// One refresh attempt for a connection — the single place Pinterest/
// LinkedIn/Meta token rotation happens, shared by the proactive daily
// cron (app/api/cron/refresh-connections/route.ts), the pre-publish
// freshness guard, and the post-auth-failure retry in run-jobs, so the
// three callers can't drift on how a token actually gets rotated and
// persisted. Never logs or returns anything but the new access token
// itself — a caught error's message is the platform's own rejection
// reason (e.g. "invalid_grant"), never a token value.
export async function refreshConnection(db: DB, connection: PlatformConnectionRow): Promise<RefreshResult> {
  try {
    if (connection.platform === "pinterest") {
      if (!connection.refreshTokenVaultId) return { ok: false, reason: "no_refresh_token" };
      const { PINTEREST_APP_ID, PINTEREST_APP_SECRET } = requireEnv("PINTEREST_APP_ID", "PINTEREST_APP_SECRET");
      const refreshToken = await readSecret(db, connection.refreshTokenVaultId);
      const tokens = await refreshPinterestToken(PINTEREST_APP_ID, PINTEREST_APP_SECRET, refreshToken);
      await updateSecret(db, connection.accessTokenVaultId, tokens.access_token);
      await updateSecret(db, connection.refreshTokenVaultId, tokens.refresh_token);
      await db
        .update(platformConnections)
        .set({ expiresAt: new Date(Date.now() + tokens.expires_in * 1000) })
        .where(eq(platformConnections.id, connection.id));
      return { ok: true, accessToken: tokens.access_token };
    }
    if (connection.platform === "facebook" || connection.platform === "instagram") {
      const { META_APP_ID, META_APP_SECRET } = requireEnv("META_APP_ID", "META_APP_SECRET");
      const currentToken = await readSecret(db, connection.accessTokenVaultId);
      const refreshed = await refreshMetaUserToken(META_APP_ID, META_APP_SECRET, currentToken);
      await updateSecret(db, connection.accessTokenVaultId, refreshed.access_token);
      return { ok: true, accessToken: refreshed.access_token };
    }
    if (connection.platform === "linkedin") {
      // No refresh_token stored means this specific connection didn't
      // get one (not necessarily a tier limitation — see the OAuth
      // callback route's comment) — same "give up, flag reconnect"
      // outcome as any other unrefreshable connection either way.
      if (!connection.refreshTokenVaultId) return { ok: false, reason: "no_refresh_token" };
      const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET } = requireEnv("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET");
      const refreshToken = await readSecret(db, connection.refreshTokenVaultId);
      const tokens = await refreshLinkedInToken(LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, refreshToken);
      await updateSecret(db, connection.accessTokenVaultId, tokens.access_token);
      if (tokens.refresh_token) {
        await updateSecret(db, connection.refreshTokenVaultId, tokens.refresh_token);
      }
      await db
        .update(platformConnections)
        .set({ expiresAt: new Date(Date.now() + tokens.expires_in * 1000) })
        .where(eq(platformConnections.id, connection.id));
      return { ok: true, accessToken: tokens.access_token };
    }
    return { ok: false, reason: "not_applicable" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // classifyPinterestError/classifyLinkedInError already separated
    // "the platform rejected this" (4xx — PlatformAuthError/
    // PlatformValidationError) from "transient infrastructure failure"
    // (5xx/429/network — plain Error) — preserve that distinction here
    // instead of collapsing every failure into "give up."
    if (err instanceof PlatformAuthError || err instanceof PlatformValidationError) {
      return { ok: false, reason: "rejected", message };
    }
    return { ok: false, reason: "transient", message };
  }
}

// Definitive refresh failure (missing or rejected refresh token): flip
// the connection to `expired` (so /connections renders its Reconnect
// link) and open one alert per connection, deduplicated by key so a
// condition checked repeatedly doesn't pile up rows. Does nothing for
// `not_applicable` — a platform this helper doesn't refresh was never
// actionable here.
export async function flagConnectionForReconnect(
  db: DB,
  connection: PlatformConnectionRow,
  result: Extract<RefreshResult, { ok: false }>,
): Promise<void> {
  if (result.reason === "not_applicable") return;
  await db.update(platformConnections).set({ status: "expired" }).where(eq(platformConnections.id, connection.id));
  const reasonText = result.reason === "no_refresh_token" ? "no refresh token stored for this connection" : (result.message ?? "refresh rejected");
  await openAlert(db, {
    key: reconnectAlertKey(connection.id),
    severity: "urgent",
    message: `${connection.platform} connection (${connection.displayName}) needs reconnecting: ${reasonText}. Click Reconnect on /connections.`,
  });
}

// Successful refresh clears any open "needs reconnect" alert for this
// connection — the condition that opened it no longer holds.
export async function resolveReconnectAlert(db: DB, connectionId: string): Promise<void> {
  await resolveAlert(db, reconnectAlertKey(connectionId));
}

// A connection's token is "due" for the proactive daily sweep once it's
// within this window of expiry (or already past it) — independent of
// runPublishPost's own 24h pre-publish guard, which only fires right
// before an actual publish. Only "connected" connections are swept: one
// already flagged "expired" is waiting on a human Reconnect click, and
// retrying the same bad/missing refresh token on a schedule wouldn't
// change that.
export const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Pure filter (unit-testable without a database) — the actual row fetch
// lives in enqueueDueRefreshJobs below.
export function filterConnectionsDueForRefresh(
  connections: PlatformConnectionRow[],
  now: Date = new Date(),
): PlatformConnectionRow[] {
  return connections.filter(
    (c) => c.status === "connected" && c.expiresAt !== null && c.expiresAt.getTime() - now.getTime() < RENEWAL_WINDOW_MS,
  );
}

// Enqueues one refresh_token job per due connection, skipping a
// connection that already has a pending/running refresh_token job so a
// daily sweep never piles up duplicates against the same connection
// (the 5-minute run-jobs cron normally drains the previous day's job
// long before this runs again). Returns the connection ids enqueued vs.
// skipped — platform connection ids only, never a token value.
export async function enqueueDueRefreshJobs(db: DB, now: Date = new Date()): Promise<{ enqueued: string[]; skipped: string[] }> {
  const connections = await db.select().from(platformConnections);
  const due = filterConnectionsDueForRefresh(connections, now);
  const enqueued: string[] = [];
  const skipped: string[] = [];
  for (const connection of due) {
    const [existingJob] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.jobType, "refresh_token"),
          inArray(jobs.status, ["pending", "running"]),
          sql`${jobs.payload}->>'connectionId' = ${connection.id}`,
        ),
      )
      .limit(1);
    if (existingJob) {
      skipped.push(connection.id);
      continue;
    }
    await enqueueJob(db, "refresh_token", { connectionId: connection.id }, now);
    enqueued.push(connection.id);
  }
  return { enqueued, skipped };
}
