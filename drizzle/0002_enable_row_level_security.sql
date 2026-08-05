-- Locks down the PostgREST-exposed anon/authenticated API for every app
-- table. All real access goes through Drizzle over DATABASE_URL (the
-- `postgres` role, which bypasses RLS on Supabase) or the service-role
-- Storage client in src/lib/storage.ts (service_role also bypasses RLS) —
-- neither is affected by this change. No policies are defined on purpose:
-- there is no legitimate anon/authenticated access path to these tables,
-- so enabling RLS with zero policies fully denies that API surface.

ALTER TABLE "article_extractions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "articles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_library" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "edit_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shopify_connection" ENABLE ROW LEVEL SECURITY;
