CREATE TABLE IF NOT EXISTS "sync_cursors" (
	"key" text PRIMARY KEY NOT NULL,
	"cutoff" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_cursors" ENABLE ROW LEVEL SECURITY;
