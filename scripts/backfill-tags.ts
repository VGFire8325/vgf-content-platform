// One-time backfill for content_items generated before the Spec 4 tags
// (audienceTag/topicTag) or the 2026-11 format/hook tags existed —
// fills in whichever of the four is still null on an already-published
// item, using the exact same deterministic heuristics generation-time
// tagging uses (src/lib/tagging.ts), so the backfilled values are drawn
// from the identical taxonomy, not a separately invented one.
//
// Dry run by default: prints what it would write (id, article title,
// platform, proposed tags) and writes nothing. Pass --apply to write.
// Never overwrites a tag that's already non-null — only fills gaps.
//
// Run with:
//   DATABASE_URL=... npx tsx scripts/backfill-tags.ts          # dry run
//   DATABASE_URL=... npx tsx scripts/backfill-tags.ts --apply  # writes
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../src/db/client";
import { articleExtractions, articles, contentItems } from "../src/db/schema";
import { extractOpeningLine } from "../src/lib/repost-policy";
import { inferAudienceTag, inferFormatTag, inferHookType, inferTopicTag } from "../src/lib/tagging";

const APPLY = process.argv.includes("--apply");

type ContentType = (typeof contentItems.$inferSelect)["contentType"];

// Same per-contentType field as primaryTextForPost (app/api/cron/run-jobs/route.ts)
// and copyPreview (app/scheduled/page.tsx), read from the already-stored
// copyFields instead of a freshly generated post.
function primaryText(contentType: ContentType, copy: Record<string, unknown>): string {
  switch (contentType) {
    case "pinterest_pin":
      return String(copy.title ?? "");
    case "linkedin_post":
    case "fb_post":
      return String(copy.postText ?? "");
    case "ig_carousel":
      return String(copy.caption ?? "");
    default:
      return "";
  }
}

async function main() {
  const rows = await db
    .select({ item: contentItems, articleTitle: articles.title, articleId: articles.id, articleTags: articles.tags })
    .from(contentItems)
    .innerJoin(articles, eq(contentItems.articleId, articles.id))
    .where(
      and(
        eq(contentItems.status, "published"),
        or(
          isNull(contentItems.topicTag),
          isNull(contentItems.audienceTag),
          isNull(contentItems.formatTag),
          isNull(contentItems.hookType),
        ),
      ),
    );

  console.log(`${rows.length} published content_item(s) missing at least one tag.\n`);

  let wouldWrite = 0;
  let skippedNoExtraction = 0;

  for (const { item, articleTitle, articleId, articleTags } of rows) {
    const copy = item.copyFields as Record<string, unknown>;
    const text = primaryText(item.contentType, copy);

    const proposed: Partial<typeof contentItems.$inferInsert> = {};

    if (item.formatTag === null) {
      proposed.formatTag = inferFormatTag(item.contentType, text);
    }
    if (item.hookType === null) {
      proposed.hookType = inferHookType(extractOpeningLine(text));
    }

    if (item.topicTag === null || item.audienceTag === null) {
      const [extraction] = await db
        .select()
        .from(articleExtractions)
        .where(eq(articleExtractions.articleId, articleId))
        .orderBy(desc(articleExtractions.createdAt))
        .limit(1);

      if (extraction) {
        if (item.topicTag === null) {
          proposed.topicTag = inferTopicTag({ tags: articleTags }, extraction);
        }
        if (item.audienceTag === null) {
          proposed.audienceTag = inferAudienceTag(extraction);
        }
      } else if (item.topicTag === null || item.audienceTag === null) {
        skippedNoExtraction += 1;
        console.log(`  SKIP (no article_extractions row found) ${item.id}  "${articleTitle}"  [${item.platform}]`);
      }
    }

    if (Object.keys(proposed).length === 0) continue;

    wouldWrite += 1;
    console.log(`  ${item.id}  "${articleTitle}"  [${item.platform}]  ->  ${JSON.stringify(proposed)}`);

    if (APPLY) {
      await db.update(contentItems).set(proposed).where(eq(contentItems.id, item.id));
    }
  }

  console.log(
    `\n${wouldWrite} item(s) ${APPLY ? "updated" : "would be updated"}` +
      (skippedNoExtraction > 0 ? `; ${skippedNoExtraction} skipped (no article_extractions row to infer topic/audience from)` : "") +
      (APPLY ? "." : " — pass --apply to write."),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
