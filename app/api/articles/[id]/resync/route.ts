import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { articles } from "@/db/schema";
import { enqueueJob } from "@/lib/jobs";

export const runtime = "nodejs";

// Manual escape hatch referenced in docs/PHASE_0_PLAN.md §1: force
// re-extraction of an article even though its content_hash hasn't
// changed (e.g. the brand prompt changed and Brendan wants a re-run).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [existing] = await db.select().from(articles).where(eq(articles.id, id)).limit(1);
  if (!existing) {
    return new Response("Article not found", { status: 404 });
  }

  await db.update(articles).set({ status: "new" }).where(eq(articles.id, existing.id));
  await enqueueJob(db, "extract_article", { articleId: existing.id });

  return Response.json({ status: "resync_queued", articleId: existing.id });
}
