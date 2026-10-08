// Spec 5 (measurability) export — joins publish_targets to content_items
// and articles so a monthly review can match platform metrics (from
// Pinterest/LinkedIn's own analytics) back to what was actually posted:
// the platform's post/pin id, when it published, which article and
// slug, the destination URL and UTM values used, and the audience/
// content-type tags. Read-only (SELECT only) — no writes, no calls to
// the LinkedIn/Pinterest/Anthropic APIs.
//
// Run with:
//   DATABASE_URL=... npx tsx scripts/export-published-content.ts [--csv] [--since=2026-09-01]
import { and, eq, gte } from "drizzle-orm";
import { db } from "../src/db/client";
import { articles, contentItems, publishTargets } from "../src/db/schema";

interface ExportRow {
  platform: string;
  contentItemId: string;
  externalPostId: string | null;
  externalPostUrl: string | null;
  publishedAt: string | null;
  articleSlug: string;
  articleTitle: string;
  destinationUrl: string | null;
  utm: Record<string, string> | null;
  audienceTag: string | null;
  topicTag: string | null;
  platformFit: string | null;
}

function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function toCsv(rows: ExportRow[]): string {
  const headers = Object.keys(rows[0] ?? ({} as ExportRow)) as (keyof ExportRow)[];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => toCsvValue(row[h])).join(","));
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asCsv = args.includes("--csv");
  const sinceArg = args.find((a) => a.startsWith("--since="))?.split("=")[1];
  const since = sinceArg ? new Date(sinceArg) : null;

  const rows = await db
    .select({
      platform: contentItems.platform,
      contentItemId: contentItems.id,
      externalPostId: publishTargets.externalPostId,
      externalPostUrl: publishTargets.externalPostUrl,
      publishedAt: publishTargets.publishedAt,
      articleSlug: articles.handle,
      articleTitle: articles.title,
      destinationUrl: publishTargets.destinationUrl,
      utm: publishTargets.utm,
      audienceTag: contentItems.audienceTag,
      topicTag: contentItems.topicTag,
      platformFit: contentItems.platformFit,
    })
    .from(publishTargets)
    .innerJoin(contentItems, eq(publishTargets.contentItemId, contentItems.id))
    .innerJoin(articles, eq(contentItems.articleId, articles.id))
    .where(
      and(
        eq(publishTargets.status, "published"),
        since ? gte(publishTargets.publishedAt, since) : undefined,
      ),
    );

  const exportRows: ExportRow[] = rows.map((r) => ({
    ...r,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    utm: r.utm as Record<string, string> | null,
  }));

  if (asCsv) {
    console.log(toCsv(exportRows));
  } else {
    console.log(JSON.stringify(exportRows, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
