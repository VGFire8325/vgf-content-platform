-- Groundwork only: table for a later per-post engagement fetcher to
-- write to (src/db/schema.ts postStats). Nothing in the app writes to
-- this table yet — no fetcher exists.
CREATE TABLE IF NOT EXISTS "post_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publish_target_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"external_post_id" text NOT NULL,
	"posted_at" timestamp with time zone,
	"impressions" integer,
	"saves" integer,
	"clicks" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_stats" ADD CONSTRAINT "post_stats_publish_target_id_publish_targets_id_fk" FOREIGN KEY ("publish_target_id") REFERENCES "public"."publish_targets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Same lockdown as every other new table since 0002: no anon/authenticated
-- API access, server (service role) only.
ALTER TABLE "post_stats" ENABLE ROW LEVEL SECURITY;
