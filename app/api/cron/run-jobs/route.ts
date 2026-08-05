import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { articleExtractions, articles, jobs } from "@/db/schema";
import { createAnthropicClient, extractArticle } from "@/lib/anthropic";
import { requireEnv } from "@/lib/env";
import { claimDueJobs, markJobFailed, markJobSucceeded } from "@/lib/jobs";

export const runtime = "nodejs";

class NonRetryableJobError extends Error {}

type Job = typeof jobs.$inferSelect;

async function runExtractArticle(job: Job) {
  const { articleId } = job.payload as { articleId: string };
  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
  if (!article) {
    throw new NonRetryableJobError(`Article ${articleId} not found`);
  }

  const { ANTHROPIC_API_KEY } = requireEnv("ANTHROPIC_API_KEY");
  const client = createAnthropicClient(ANTHROPIC_API_KEY);
  const extraction = await extractArticle(client, article.title, article.bodyHtml);

  await db.insert(articleExtractions).values({
    articleId: article.id,
    coreSubject: extraction.coreSubject,
    audience: extraction.audience,
    searchIntent: extraction.searchIntent,
    keyTakeaways: extraction.keyTakeaways,
    supportedClaims: extraction.supportedClaims,
    modelUsed: "claude-sonnet-5",
  });
  await db.update(articles).set({ status: "processed" }).where(eq(articles.id, article.id));
}

async function dispatch(job: Job) {
  switch (job.jobType) {
    case "extract_article":
      return runExtractArticle(job);
    case "generate_content":
    case "render_image":
    case "publish_post":
    case "refresh_token":
      // Not yet built — see docs/PHASE_0_PLAN.md Phase 1 milestones.
      throw new NonRetryableJobError(`Job type '${job.jobType}' has no handler yet`);
    default:
      throw new NonRetryableJobError(`Unknown job type '${job.jobType}'`);
  }
}

export async function POST(request: Request) {
  const { CRON_SECRET } = requireEnv("CRON_SECRET");
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const claimed = await claimDueJobs(db, 5);
  const results = [];

  for (const job of claimed) {
    try {
      await dispatch(job);
      await markJobSucceeded(db, job.id);
      results.push({ id: job.id, jobType: job.jobType, outcome: "succeeded" });
    } catch (error) {
      const nonRetryable = error instanceof NonRetryableJobError;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await markJobFailed(db, job, message, nonRetryable);
      results.push({ id: job.id, jobType: job.jobType, outcome, error: message });
    }
  }

  return Response.json({ claimed: claimed.length, results });
}
