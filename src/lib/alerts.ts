import { and, eq, isNull } from "drizzle-orm";
import type { db as DbClient } from "@/db/client";
import { alerts } from "@/db/schema";

// Shared alert plumbing: one OPEN row per key (partial unique index
// alerts_open_key_unique), deduplicated on re-detection so a condition
// checked hourly doesn't produce a new row (or a new email) every hour.
// Typical use from a check:
//
//   const { alert } = await openAlert(db, { key, severity, message });
//   if (!alert.emailedAt) { await send(...); await markAlertEmailed(db, alert.id); }
//
// and from whatever fixes the condition: await resolveAlert(db, key).

export type AlertRow = typeof alerts.$inferSelect;
export type AlertSeverity = "info" | "warning" | "urgent";
type DbOrTx = typeof DbClient | Parameters<Parameters<typeof DbClient.transaction>[0]>[0];

export async function openAlert(
  db: DbOrTx,
  input: { key: string; severity: AlertSeverity; message: string },
  now: Date = new Date(),
): Promise<{ alert: AlertRow; created: boolean }> {
  const [inserted] = await db
    .insert(alerts)
    .values({ key: input.key, severity: input.severity, message: input.message, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { alert: inserted, created: true };

  const [existing] = await db
    .update(alerts)
    .set({ lastSeenAt: now, message: input.message, severity: input.severity })
    .where(and(eq(alerts.key, input.key), isNull(alerts.resolvedAt)))
    .returning();
  if (!existing) {
    // Resolved between our insert and update — vanishingly rare; the next
    // check run will reopen it.
    throw new Error(`Alert '${input.key}' changed state concurrently; retry`);
  }
  return { alert: existing, created: false };
}

export async function markAlertEmailed(db: DbOrTx, id: string, now: Date = new Date()): Promise<void> {
  await db.update(alerts).set({ emailedAt: now }).where(eq(alerts.id, id));
}

// Returns how many open alerts were resolved (0 or 1).
export async function resolveAlert(db: DbOrTx, key: string, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(alerts)
    .set({ resolvedAt: now })
    .where(and(eq(alerts.key, key), isNull(alerts.resolvedAt)))
    .returning({ id: alerts.id });
  return rows.length;
}

export async function listOpenAlerts(db: DbOrTx): Promise<AlertRow[]> {
  return db.select().from(alerts).where(isNull(alerts.resolvedAt));
}
