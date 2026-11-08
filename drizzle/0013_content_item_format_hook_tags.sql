-- Post format / opening-hook tags (src/db/schema.ts contentItems) for the
-- monthly social-performance review. Additive, nullable, no default —
-- every existing row stays untagged until the backfill script
-- (scripts/backfill-tags.ts) or a fresh generation fills it in.
ALTER TABLE "content_items" ADD COLUMN "format_tag" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "hook_type" text;