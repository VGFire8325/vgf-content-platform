-- Image tagging for asset_library. Additive only: new nullable columns,
-- a partial unique index on shopify_image_id (dedupe), a (setting, room)
-- index for the blog writer's lookups, and CHECK constraints for the
-- allowed values in src/db/asset-vocab.ts. Existing columns, rows and RLS
-- are untouched. Every statement is guarded, so re-running it is a no-op.
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "shopify_image_id" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "setting" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "room" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "mounting" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "brand" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "product_name" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "style" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "colors" text[];--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "quality" smallint;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "width_px" integer;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "height_px" integer;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "featured_ok" boolean;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "alt_text" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "confidence" text;--> statement-breakpoint
ALTER TABLE "asset_library" ADD COLUMN IF NOT EXISTS "tagged_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "asset_library_shopify_image_id_unique" ON "asset_library" USING btree ("shopify_image_id") WHERE "asset_library"."shopify_image_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_library_setting_room_idx" ON "asset_library" USING btree ("setting","room");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_setting_check') THEN
    ALTER TABLE "asset_library" ADD CONSTRAINT "asset_library_setting_check" CHECK ("asset_library"."setting" in ('installed', 'product_only', 'render', 'detail', 'diagram', 'other'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_room_check') THEN
    ALTER TABLE "asset_library" ADD CONSTRAINT "asset_library_room_check" CHECK ("asset_library"."room" in ('living_room', 'bedroom', 'kitchen', 'dining_room', 'bathroom', 'basement', 'office', 'patio_outdoor', 'entryway', 'other', 'none'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_mounting_check') THEN
    ALTER TABLE "asset_library" ADD CONSTRAINT "asset_library_mounting_check" CHECK ("asset_library"."mounting" in ('wall_mounted', 'built_in', 'recessed', 'mantel_surround', 'freestanding', 'insert', 'tv_wall', 'other', 'unknown'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_confidence_check') THEN
    ALTER TABLE "asset_library" ADD CONSTRAINT "asset_library_confidence_check" CHECK ("asset_library"."confidence" in ('high', 'medium', 'low'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_quality_check') THEN
    ALTER TABLE "asset_library" ADD CONSTRAINT "asset_library_quality_check" CHECK ("asset_library"."quality" between 1 and 5);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_featured_ok_check') THEN
    ALTER TABLE "asset_library" ADD CONSTRAINT "asset_library_featured_ok_check" CHECK ("asset_library"."featured_ok" is not true or ("asset_library"."setting" = 'installed' and "asset_library"."quality" >= 4 and "asset_library"."width_px" >= 800));
  END IF;
END $$;
