-- drizzle-kit generate also re-emitted 0003/0004's statements here (the
-- local meta/journal was already out of sync with production before
-- this change — those two migrations were applied without updating the
-- local snapshot). Trimmed to just this migration's actual change; the
-- sync_cursors table and articles.shopify_published_at already exist.
ALTER TABLE "content_items" ADD COLUMN "campaign" text;
