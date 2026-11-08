-- Reporting views for the monthly social-performance review. Read-only,
-- additive, nothing else in this app queries them through drizzle (not
-- modeled in src/db/schema.ts) — they exist for the review to read
-- directly (e.g. via Supabase), so a schema change here never needs a
-- drizzle-kit regenerate. Safe to run repeatedly: CREATE OR REPLACE VIEW
-- never touches table data, and both views only ever select, never write.

-- One row per published publish_target, with its latest post_stats
-- snapshot (by captured_on — the unique index on (publish_target_id,
-- captured_on) means there's at most one row per day, so "latest" is
-- unambiguous) and the content/article context a reviewer needs to
-- read results by topic, audience, format, and hook without a manual
-- join. A target with no capture yet still appears, with every stats
-- column null, so "not yet measured" stays visible rather than
-- silently dropped.
CREATE OR REPLACE VIEW post_performance AS
SELECT
  pt.id AS publish_target_id,
  ci.id AS content_item_id,
  ci.platform,
  ci.content_type,
  ci.topic_tag,
  ci.audience_tag,
  ci.format_tag,
  ci.hook_type,
  ci.platform_fit,
  -- The one field per platform that's the post's actual headline/
  -- opening line — same per-content-type dispatch as
  -- primaryTextForPost (app/api/cron/run-jobs/route.ts): Pinterest's
  -- title, Instagram's caption, or the first line of postText for
  -- LinkedIn/Facebook (a post body, not a single-field headline).
  CASE ci.content_type
    WHEN 'pinterest_pin' THEN ci.copy_fields ->> 'title'
    WHEN 'ig_carousel' THEN ci.copy_fields ->> 'caption'
    ELSE split_part(ci.copy_fields ->> 'postText', E'\n', 1)
  END AS headline,
  a.title AS article_title,
  a.handle AS article_handle,
  a.tags AS article_tags,
  pt.published_at,
  pt.external_post_url,
  latest.captured_on AS stats_captured_on,
  latest.impressions,
  latest.saves,
  latest.clicks,
  latest.outbound_clicks,
  latest.reactions,
  latest.comments,
  latest.reposts,
  latest.engagements
FROM publish_targets pt
JOIN content_items ci ON ci.id = pt.content_item_id
JOIN articles a ON a.id = ci.article_id
LEFT JOIN LATERAL (
  SELECT ps.*
  FROM post_stats ps
  WHERE ps.publish_target_id = pt.id
  ORDER BY ps.captured_on DESC
  LIMIT 1
) latest ON true
WHERE pt.status = 'published';

--> statement-breakpoint

-- Aggregates post_performance by platform and, separately, each of the
-- four tag dimensions (one row per platform x tag_type x tag_value, in
-- "long" format via UNION ALL rather than one wide group-by on all four
-- tags at once, which would fragment every combination into its own
-- near-empty bucket). zero_impressions_share counts a post with no
-- capture yet (impressions IS NULL) the same as a captured 0 — both
-- read as "no visibility to show for this post" from the review's
-- point of view, whether that's a real miss or just not measured yet.
CREATE OR REPLACE VIEW post_performance_by_tag AS
WITH tagged AS (
  SELECT platform, 'topic_tag' AS tag_type, topic_tag AS tag_value, impressions, saves, clicks FROM post_performance
  UNION ALL
  SELECT platform, 'audience_tag', audience_tag, impressions, saves, clicks FROM post_performance
  UNION ALL
  SELECT platform, 'format_tag', format_tag, impressions, saves, clicks FROM post_performance
  UNION ALL
  SELECT platform, 'hook_type', hook_type, impressions, saves, clicks FROM post_performance
)
SELECT
  platform,
  tag_type,
  tag_value,
  count(*) AS post_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY impressions) AS median_impressions,
  sum(impressions) AS total_impressions,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY saves) AS median_saves,
  sum(saves) AS total_saves,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY clicks) AS median_clicks,
  sum(clicks) AS total_clicks,
  avg((coalesce(impressions, 0) = 0)::int)::numeric AS zero_impressions_share
FROM tagged
GROUP BY platform, tag_type, tag_value
ORDER BY platform, tag_type, tag_value;
