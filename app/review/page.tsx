import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { articles, contentItems } from "@/db/schema";
import { REVIEW_QUEUE_STATUSES } from "@/lib/review";
import {
  applyInstruction,
  approveAllInReview,
  approveContentItem,
  regenerateField,
  rejectContentItem,
  updateContentItemCopy,
} from "./actions";

export const dynamic = "force-dynamic";

type ContentItemRow = typeof contentItems.$inferSelect;

const REGENERABLE_FIELDS: Record<string, { key: string; label: string }[]> = {
  pinterest_pin: [
    { key: "title", label: "Title" },
    { key: "description", label: "Description" },
  ],
  linkedin_post: [{ key: "postText", label: "Post text" }],
  fb_post: [{ key: "postText", label: "Post text" }],
  ig_carousel: [{ key: "caption", label: "Caption" }],
};

function CopyFieldsForm({ item }: { item: ContentItemRow }) {
  const copy = item.copyFields as Record<string, unknown>;
  const flaggedClaims = (copy.flaggedClaims as string[] | undefined) ?? [];

  const fields = Object.entries(copy).filter(([key]) => key !== "flaggedClaims");

  return (
    <div className="item-body">
      {flaggedClaims.length > 0 && (
        <div className="flag-warning">
          <strong>Unsupported claims flagged — check against the article before approving:</strong>
          <ul>
            {flaggedClaims.map((claim) => (
              <li key={claim}>{claim}</li>
            ))}
          </ul>
        </div>
      )}

      <form action={updateContentItemCopy} className="copy-form">
        <input type="hidden" name="id" value={item.id} />
        {fields.map(([key, value]) => (
          <label key={key} className="field">
            <span>{key}</span>
            <textarea
              name={`field:${key}`}
              defaultValue={Array.isArray(value) ? value.join("\n") : String(value ?? "")}
              rows={Array.isArray(value) ? Math.min(value.length + 1, 8) : 3}
            />
          </label>
        ))}
        <button type="submit">Save edit</button>
      </form>

      <form action={applyInstruction} className="instruction-form">
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="fieldTarget" value="all" />
        <label>
          <span>Free-text instruction (e.g. "make this less promotional")</span>
          <textarea name="instructionText" rows={2} placeholder="Instruction..." />
        </label>
        <button type="submit">Apply &amp; re-render</button>
      </form>

      <div className="regen-buttons">
        {(REGENERABLE_FIELDS[item.contentType] ?? []).map(({ key, label }) => (
          <form action={regenerateField} key={key}>
            <input type="hidden" name="id" value={item.id} />
            <input type="hidden" name="field" value={key} />
            <button type="submit">Regenerate {label.toLowerCase()}</button>
          </form>
        ))}
        <span className="stub-note">Image regeneration and layout edits land with the image-compositor milestone.</span>
      </div>

      <div className="approve-reject">
        <form action={approveContentItem}>
          <input type="hidden" name="id" value={item.id} />
          <button type="submit" className="approve">Approve</button>
        </form>
        <form action={rejectContentItem}>
          <input type="hidden" name="id" value={item.id} />
          <button type="submit" className="reject">Reject</button>
        </form>
      </div>
    </div>
  );
}

export default async function ReviewPage() {
  const rows = await db
    .select({ item: contentItems, articleTitle: articles.title })
    .from(contentItems)
    .innerJoin(articles, eq(contentItems.articleId, articles.id))
    .where(inArray(contentItems.status, REVIEW_QUEUE_STATUSES))
    .orderBy(asc(articles.title), asc(contentItems.platform));

  const grouped = new Map<string, { articleTitle: string; items: ContentItemRow[] }>();
  for (const row of rows) {
    const key = row.item.articleId;
    if (!grouped.has(key)) {
      grouped.set(key, { articleTitle: row.articleTitle, items: [] });
    }
    grouped.get(key)?.items.push(row.item);
  }

  if (grouped.size === 0) {
    return (
      <main>
        <h1>Review Queue</h1>
        <p>Nothing waiting on review right now.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Review Queue</h1>
      {[...grouped.entries()].map(([articleId, group]) => (
        <section key={articleId} className="article-group">
          <div className="article-header">
            <h2>{group.articleTitle}</h2>
            <form action={approveAllInReview}>
              <input type="hidden" name="articleId" value={articleId} />
              <button type="submit">Approve all</button>
            </form>
          </div>
          <div className="items">
            {group.items.map((item) => (
              <article key={item.id} className="item-card">
                <header>
                  <span className="platform">{item.platform}</span>
                  <span className={`status status-${item.status}`}>{item.status}</span>
                </header>
                <CopyFieldsForm item={item} />
              </article>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
