CREATE TYPE "public"."asset_source_type" AS ENUM('asset_library', 'rendered_template');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."content_item_status" AS ENUM('draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('pinterest_pin', 'linkedin_post', 'fb_post', 'ig_carousel');--> statement-breakpoint
CREATE TYPE "public"."edit_field_target" AS ENUM('copy', 'image', 'headline', 'layout', 'all');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed_retryable', 'failed_final');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('extract_article', 'generate_content', 'render_image', 'publish_post', 'refresh_token');--> statement-breakpoint
CREATE TYPE "public"."library_source" AS ENUM('shopify_product', 'manual_upload');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('pinterest', 'linkedin', 'facebook', 'instagram');--> statement-breakpoint
CREATE TYPE "public"."policy_mode" AS ENUM('manual', 'trusted', 'autonomous');--> statement-breakpoint
CREATE TYPE "public"."publish_target_status" AS ENUM('scheduled', 'publishing', 'published', 'failed_retrying', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "article_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"core_subject" text NOT NULL,
	"audience" text NOT NULL,
	"search_intent" text NOT NULL,
	"key_takeaways" jsonb NOT NULL,
	"supported_claims" jsonb NOT NULL,
	"model_used" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopify_article_id" text NOT NULL,
	"shopify_blog_id" text NOT NULL,
	"title" text NOT NULL,
	"handle" text NOT NULL,
	"body_html" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"shopify_updated_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_shopify_article_id_unique" UNIQUE("shopify_article_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_library" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_url" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source" "library_source" NOT NULL,
	"shopify_product_id" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "platform" NOT NULL,
	"content_type" "content_type" NOT NULL,
	"mode" "policy_mode" DEFAULT 'manual' NOT NULL,
	"auto_publish_conditions" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"source_type" "asset_source_type" NOT NULL,
	"source_asset_id" uuid,
	"template_id" text,
	"render_params" jsonb,
	"file_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"content_type" "content_type" NOT NULL,
	"copy_fields" jsonb NOT NULL,
	"status" "content_item_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edit_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"instruction_text" text NOT NULL,
	"field_target" "edit_field_target" NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result_summary" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" "job_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "platform" NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"access_token_vault_id" uuid NOT NULL,
	"refresh_token_vault_id" uuid,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "connection_status" DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publish_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publish_target_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "publish_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"platform_connection_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"external_post_id" text,
	"external_post_url" text,
	"status" "publish_target_status" DEFAULT 'scheduled' NOT NULL,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_extractions" ADD CONSTRAINT "article_extractions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_items" ADD CONSTRAINT "content_items_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "edit_instructions" ADD CONSTRAINT "edit_instructions_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "publish_log" ADD CONSTRAINT "publish_log_publish_target_id_publish_targets_id_fk" FOREIGN KEY ("publish_target_id") REFERENCES "public"."publish_targets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_platform_connection_id_platform_connections_id_fk" FOREIGN KEY ("platform_connection_id") REFERENCES "public"."platform_connections"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
