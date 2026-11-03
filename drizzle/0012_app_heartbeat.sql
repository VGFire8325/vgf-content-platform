CREATE TABLE IF NOT EXISTS "app_heartbeat" (
	"app" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_post_at" timestamp with time zone,
	"posts_last_7d" integer,
	"queue_pending" integer,
	"queue_oldest_pending_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Unlike every other table in this schema (locked down with RLS + zero
-- policies, per 0002/0007/0009's comments — no anon/authenticated API
-- access at all), this one is meant to be read from outside the app by
-- an external monitor. Checked live against this project (2026-10):
-- there is no distinct "monitoring" Postgres role or RLS policy on
-- orders/alerts today — both are under that same zero-policy lockdown,
-- so whatever currently reads them does so with a role that bypasses
-- RLS entirely (service_role, or this app's own DATABASE_URL/postgres
-- role), not a scoped SELECT grant. service_role is the one of those
-- that's meant for exactly this (external, server-side, non-superuser)
-- use, so it's named explicitly below for both read and write — write
-- is also explicit here (rather than relying on RLS bypass, like every
-- other table's writes) so "only the service role may write" holds as
-- a real, visible policy, not just an implicit consequence of nothing
-- else having a path in. If the real external monitor authenticates as
-- something else, grant that role SELECT instead/as well.
ALTER TABLE "app_heartbeat" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- This table (and these three policies) were already applied by hand
-- directly against production on 2026-10-20, ahead of this migration
-- being renumbered 0011 -> 0012 to resolve a collision with
-- 0011_post_stats.sql merged in the meantime. CREATE POLICY has no
-- IF NOT EXISTS, so each one is wrapped the same way this repo already
-- wraps a possibly-pre-existing FK constraint (0007/0009): on a fresh
-- database this creates the policy; against production, where it
-- already exists, Postgres raises duplicate_object (42710) and the
-- block swallows it instead of failing the migration.
DO $$ BEGIN
 CREATE POLICY "app_heartbeat_service_role_select" ON "app_heartbeat" FOR SELECT TO "service_role" USING (true);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE POLICY "app_heartbeat_service_role_write" ON "app_heartbeat" FOR INSERT TO "service_role" WITH CHECK (true);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE POLICY "app_heartbeat_service_role_update" ON "app_heartbeat" FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
