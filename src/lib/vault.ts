import { sql } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";

// Wraps Supabase Vault (docs/PHASE_0_PLAN.md §3 — decided over
// app-level encryption specifically so there's no separate encryption
// key for the app to manage). Vault is a Postgres extension bundled by
// Supabase's platform, not available in a plain local Postgres, so
// unlike the rest of this codebase this module could not be
// integration-tested against a real database in this environment — it
// needs Brendan's actual Supabase project. Verified by typecheck only.

export async function storeSecret(db: typeof DbClient, value: string, name: string): Promise<string> {
  const result = await db.execute(sql`select vault.create_secret(${value}, ${name}) as id`);
  const row = (result as unknown as { id: string }[])[0];
  if (!row) {
    throw new Error("vault.create_secret returned no row");
  }
  return row.id;
}

export async function updateSecret(db: typeof DbClient, secretId: string, value: string): Promise<void> {
  await db.execute(sql`select vault.update_secret(${secretId}::uuid, ${value})`);
}

export async function readSecret(db: typeof DbClient, secretId: string): Promise<string> {
  const result = await db.execute(
    sql`select decrypted_secret from vault.decrypted_secrets where id = ${secretId}::uuid`,
  );
  const row = (result as unknown as { decrypted_secret: string }[])[0];
  if (!row) {
    throw new Error(`Vault secret ${secretId} not found`);
  }
  return row.decrypted_secret;
}
