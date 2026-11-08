-- Results ingest for the monthly social-performance review
-- (POST /api/post-stats, GET /api/post-stats/pending). post_stats has
-- 0 rows today (groundwork table, migration 0011), so these NOT NULL +
-- default columns and the new unique index are safe to add with no
-- backfill needed. The unique index is what the ingest upserts on, so
-- a same-day re-capture updates in place instead of duplicating.
ALTER TABLE "post_stats" ADD COLUMN "outbound_clicks" integer;--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "reactions" integer;--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "comments" integer;--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "reposts" integer;--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "engagements" integer;--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "capture_source" text DEFAULT 'manual_chrome' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_stats" ADD COLUMN "captured_on" date DEFAULT current_date NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "post_stats_target_captured_on_unique" ON "post_stats" USING btree ("publish_target_id","captured_on");