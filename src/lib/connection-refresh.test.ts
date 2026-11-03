import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterConnectionsDueForRefresh,
  flagConnectionForReconnect,
  refreshConnection,
  reconnectAlertKey,
  type PlatformConnectionRow,
} from "./connection-refresh";

// refreshConnection/flagConnectionForReconnect touch Supabase Vault
// (vault.create_secret/update_secret/decrypted_secrets), which — per
// src/lib/vault.ts's own comment — isn't available against a plain
// local Postgres in this environment, only a real Supabase project.
// This fake `db` stands in for just the handful of drizzle calls these
// two functions make (execute, update().set().where(),
// insert().values().onConflictDoNothing().returning()), so the
// refresh-outcome branching and alert-opening logic can be exercised
// without a real database. It is not a drizzle replacement — just
// enough surface for these two call paths.
function fakeDb() {
  const updates: { table: string; values: Record<string, unknown> }[] = [];
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  let executeCalls = 0;

  const db = {
    execute: async (_query: unknown) => {
      executeCalls += 1;
      // readSecret's select is the only execute() call whose result is
      // actually read (for the refresh token value); updateSecret's
      // result is discarded, so one fixed row shape covers both.
      return [{ decrypted_secret: "stored-refresh-token", id: "secret-id" }];
    },
    update: (_table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table: "unknown", values });
          return [];
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            inserts.push({ table: "unknown", values });
            // Simulate a fresh insert succeeding (no existing open alert).
            return [{ id: "alert-1", ...values }];
          },
        }),
      }),
    }),
  };

  return { db, updates, inserts, executeCallCount: () => executeCalls };
}

function pinterestConnection(overrides: Partial<PlatformConnectionRow> = {}): PlatformConnectionRow {
  return {
    id: "conn-1",
    platform: "pinterest",
    externalAccountId: "ext-1",
    displayName: "Very Good Fireplaces",
    accessTokenVaultId: "access-vault-id",
    refreshTokenVaultId: "refresh-vault-id",
    scopes: [],
    expiresAt: new Date("2026-11-06T19:00:00Z"),
    status: "connected",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as PlatformConnectionRow;
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("filterConnectionsDueForRefresh keeps a connection within the 7-day renewal window", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const soon = pinterestConnection({ id: "a", expiresAt: new Date("2026-11-06T19:00:00Z") }); // ~6 days out
  const [due] = filterConnectionsDueForRefresh([soon], now);
  assert.equal(due?.id, "a");
});

test("filterConnectionsDueForRefresh leaves a token well outside the window alone", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const farOut = pinterestConnection({ id: "b", expiresAt: new Date("2026-12-30T06:40:00Z") }); // ~59 days out
  const due = filterConnectionsDueForRefresh([farOut], now);
  assert.deepEqual(due, []);
});

test("filterConnectionsDueForRefresh includes an already-past expiry", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const past = pinterestConnection({ id: "c", expiresAt: new Date("2026-10-20T00:00:00Z") });
  const [due] = filterConnectionsDueForRefresh([past], now);
  assert.equal(due?.id, "c");
});

test("filterConnectionsDueForRefresh skips a connection already flagged expired, even if its token is within the window", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const expired = pinterestConnection({ id: "d", status: "expired", expiresAt: new Date("2026-11-03T00:00:00Z") });
  const due = filterConnectionsDueForRefresh([expired], now);
  assert.deepEqual(due, []);
});

test("refreshConnection returns no_refresh_token when the connection has no stored refresh token", async () => {
  const { db } = fakeDb();
  const connection = pinterestConnection({ refreshTokenVaultId: null });
  const result = await refreshConnection(db as never, connection);
  assert.deepEqual(result, { ok: false, reason: "no_refresh_token" });
});

test("refreshConnection succeeds and persists both the new access and refresh tokens", async () => {
  const { db, updates } = fakeDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 2_592_000 }),
    }) as unknown as Response) as typeof fetch;

  try {
    const connection = pinterestConnection();
    const result = await withEnv({ PINTEREST_APP_ID: "app-id", PINTEREST_APP_SECRET: "app-secret" }, () =>
      refreshConnection(db as never, connection),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "new-access-token");
    // expiresAt updated on platform_connections — the only update() call
    // in the success path (vault writes go through execute(), not update()).
    assert.equal(updates.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshConnection returns 'rejected' when the platform rejects the refresh (invalid_grant), not 'transient'", async () => {
  const { db } = fakeDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "The refresh token is invalid or expired." }),
    }) as unknown as Response) as typeof fetch;

  try {
    const connection = pinterestConnection();
    const result = await withEnv({ PINTEREST_APP_ID: "app-id", PINTEREST_APP_SECRET: "app-secret" }, () =>
      refreshConnection(db as never, connection),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "rejected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshConnection returns 'transient' for a 5xx from the platform's OAuth endpoint", async () => {
  const { db } = fakeDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: false, status: 503, json: async () => ({ message: "Service unavailable" }) }) as unknown as Response) as typeof fetch;

  try {
    const connection = pinterestConnection();
    const result = await withEnv({ PINTEREST_APP_ID: "app-id", PINTEREST_APP_SECRET: "app-secret" }, () =>
      refreshConnection(db as never, connection),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "transient");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("flagConnectionForReconnect marks the connection expired and opens a reconnect alert naming the reason, no token value", async () => {
  const { db, updates, inserts } = fakeDb();
  const connection = pinterestConnection();
  await flagConnectionForReconnect(db as never, connection, { ok: false, reason: "rejected", message: "invalid_grant" });

  const connectionUpdate = updates.find((u) => u.values && "status" in u.values);
  assert.equal(connectionUpdate?.values.status, "expired");

  assert.equal(inserts.length, 1);
  const alertValues = inserts[0]!.values as { key: string; message: string };
  assert.equal(alertValues.key, reconnectAlertKey(connection.id));
  assert.ok(alertValues.message.includes("invalid_grant"));
  assert.ok(!alertValues.message.includes("stored-refresh-token"), "alert message must never contain a token value");
});

test("flagConnectionForReconnect does nothing for not_applicable", async () => {
  const { db, updates, inserts } = fakeDb();
  const connection = pinterestConnection();
  await flagConnectionForReconnect(db as never, connection, { ok: false, reason: "not_applicable" });
  assert.equal(updates.length, 0);
  assert.equal(inserts.length, 0);
});
