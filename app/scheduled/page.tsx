import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { articles, contentItems, publishTargets } from "@/db/schema";
import { SCHEDULED_VIEW_STATUSES } from "@/lib/review";

export const dynamic = "force-dynamic";

// One line of preview text per content type — just enough to identify
// which post this is at a glance, not the full editing view that
// belongs on /review.
function copyPreview(item: typeof contentItems.$inferSelect): string {
  const copy = item.copyFields as Record<string, unknown>;
  switch (item.contentType) {
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

export default async function ScheduledPage() {
  const rows = await db
    .select({ item: contentItems, articleTitle: articles.title, scheduledAt: publishTargets.scheduledAt })
    .from(contentItems)
    .innerJoin(articles, eq(contentItems.articleId, articles.id))
    .leftJoin(
      publishTargets,
      and(eq(publishTargets.contentItemId, contentItems.id), inArray(publishTargets.status, ["scheduled", "publishing"])),
    )
    .where(inArray(contentItems.status, SCHEDULED_VIEW_STATUSES))
    .orderBy(asc(publishTargets.scheduledAt));

  return (
    <main>
      <h1>Scheduled</h1>
      <p>
        <a href="/review">Back to Review Queue</a>
        {" · "}
        <a href="/assets">Asset Library</a>
        {" · "}
        <a href="/connections">Connections &amp; Policy</a>
      </p>
      {rows.length === 0 ? (
        <p>Nothing scheduled right now.</p>
      ) : (
        <div className="items">
          {rows.map(({ item, articleTitle, scheduledAt }) => (
            <article key={item.id} className="item-card">
              <header>
                <span className="platform">{item.platform}</span>
                <span className={`status status-${item.status}`}>{item.status}</span>
                <span className="scheduled-time">
                  {scheduledAt ? scheduledAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Waiting for platform connection"}
                </span>
              </header>
              <div className="item-body">
                <strong>{articleTitle}</strong>
                <p>{copyPreview(item)}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
