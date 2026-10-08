ALTER TABLE "content_items" ADD COLUMN "audience_tag" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "topic_tag" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "platform_fit" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "quality_flags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "destination_url" text;--> statement-breakpoint
ALTER TABLE "publish_targets" ADD COLUMN "utm" jsonb;