"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { articleExtractions, contentAssets, contentItems, editInstructions, editFieldTargetEnum, publishTargets } from "@/db/schema";
import { createAnthropicClient } from "@/lib/anthropic";
import { editPlatformPost, groundPosts, type PlatformPost } from "@/lib/generation";
import { requireEnv } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";
import { CANCELABLE_PUBLISH_STATUSES, nextStatusAfterEdit, shouldCancelPendingPublish } from "@/lib/review";
import { PINTEREST_TEMPLATE_IDS, type PinterestTemplateId } from "@/lib/templates/pinterest";

const REVIEW_PATH = "/review";
type FieldTarget = (typeof editFieldTargetEnum.enumValues)[number];

function requireString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required field '${key}'`);
  }
  return value;
}

async function cancelPendingPublishes(contentItemId: string) {
  await db
    .update(publishTargets)
    .set({ status: "canceled" })
    .where(
      and(
        eq(publishTargets.contentItemId, contentItemId),
        inArray(publishTargets.status, CANCELABLE_PUBLISH_STATUSES),
      ),
    );
}

export async function approveContentItem(formData: FormData) {
  const id = requireString(formData, "id");
  await db.update(contentItems).set({ status: "approved", updatedAt: new Date() }).where(eq(contentItems.id, id));
  revalidatePath(REVIEW_PATH);
}

export async function rejectContentItem(formData: FormData) {
  const id = requireString(formData, "id");
  await db.update(contentItems).set({ status: "rejected", updatedAt: new Date() }).where(eq(contentItems.id, id));
  revalidatePath(REVIEW_PATH);
}

// Approve all in_review items, optionally scoped to one article's batch.
export async function approveAllInReview(formData: FormData) {
  const articleId = formData.get("articleId");
  const conditions = [eq(contentItems.status, "in_review")];
  if (typeof articleId === "string" && articleId) {
    conditions.push(eq(contentItems.articleId, articleId));
  }
  await db
    .update(contentItems)
    .set({ status: "approved", updatedAt: new Date() })
    .where(and(...conditions));
  revalidatePath(REVIEW_PATH);
}

// Direct field edit (the inline copy-edit form) — no model call, just
// updates the row. Still goes through nextStatusAfterEdit/
// shouldCancelPendingPublish so a post-approval edit gets the same
// safety behavior as an AI-assisted one.
export async function updateContentItemCopy(formData: FormData) {
  const id = requireString(formData, "id");
  const [current] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!current) {
    throw new Error(`content_item ${id} not found`);
  }

  const edits: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("field:") || typeof value !== "string") continue;
    const field = key.slice("field:".length);
    edits[field] = field === "slides" ? value.split("\n").map((s) => s.trim()).filter(Boolean) : value;
  }

  const copyFields = { ...(current.copyFields as Record<string, unknown>), ...edits };
  await db
    .update(contentItems)
    .set({
      copyFields,
      status: nextStatusAfterEdit(current.status),
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(contentItems.id, id));

  if (shouldCancelPendingPublish(current.status)) {
    await cancelPendingPublishes(id);
  }
  revalidatePath(REVIEW_PATH);
}

// Shared core for the free-text instruction box and the "regenerate
// just X" buttons — both are a model-assisted edit of one field target,
// just with a different source for the instruction text.
async function applyEditToItem(id: string, instructionText: string, fieldTarget: FieldTarget) {
  if (fieldTarget === "image" || fieldTarget === "layout") {
    throw new Error(
      "Image/layout editing isn't available yet — that lands with the image-compositor milestone.",
    );
  }

  const [current] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!current) {
    throw new Error(`content_item ${id} not found`);
  }

  const { ANTHROPIC_API_KEY } = requireEnv("ANTHROPIC_API_KEY");
  const client = createAnthropicClient(ANTHROPIC_API_KEY);

  const currentPost = current.copyFields as unknown as PlatformPost;
  const editedPost = await editPlatformPost(client, current.platform, currentPost, instructionText);

  const [latestExtraction] = await db
    .select()
    .from(articleExtractions)
    .where(eq(articleExtractions.articleId, current.articleId))
    .orderBy(desc(articleExtractions.createdAt))
    .limit(1);
  const supportedClaims = (latestExtraction?.supportedClaims as string[] | undefined) ?? [];
  const [flaggedClaims] = await groundPosts(client, current.platform, [editedPost], supportedClaims);

  await db
    .update(contentItems)
    .set({
      copyFields: { ...editedPost, flaggedClaims: flaggedClaims ?? [] },
      status: nextStatusAfterEdit(current.status),
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(contentItems.id, id));

  if (shouldCancelPendingPublish(current.status)) {
    await cancelPendingPublishes(id);
  }

  await db.insert(editInstructions).values({
    contentItemId: id,
    instructionText,
    fieldTarget,
    resultSummary: "Applied and re-grounded against the article's supported claims.",
  });
}

export async function applyInstruction(formData: FormData) {
  const id = requireString(formData, "id");
  const instructionText = requireString(formData, "instructionText");
  const fieldTarget = (formData.get("fieldTarget") as FieldTarget | null) ?? "all";
  await applyEditToItem(id, instructionText, fieldTarget);
  revalidatePath(REVIEW_PATH);
}

// "Regenerate just the headline/caption/etc." — a canned instruction
// through the same model-assisted edit path, logged the same way.
export async function regenerateField(formData: FormData) {
  const id = requireString(formData, "id");
  const field = requireString(formData, "field");
  await applyEditToItem(id, `Regenerate the ${field} for this post. Keep everything else the same.`, "copy");
  revalidatePath(REVIEW_PATH);
}

// "Regenerate with a different template variant" — the one image
// action the plan actually calls for in V1 (§1: no full template
// editor). Cycles to the next fixed Pinterest layout and re-enqueues a
// render_image job; the cron runner picks it up like any other job.
export async function regenerateImage(formData: FormData) {
  const id = requireString(formData, "id");
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!item) {
    throw new Error(`content_item ${id} not found`);
  }
  if (item.platform !== "pinterest" || item.contentType !== "pinterest_pin") {
    throw new Error("Image regeneration is only available for Pinterest pins right now.");
  }

  const [latestAsset] = await db
    .select()
    .from(contentAssets)
    .where(eq(contentAssets.contentItemId, id))
    .orderBy(desc(contentAssets.createdAt))
    .limit(1);
  const currentIndex = latestAsset?.templateId
    ? PINTEREST_TEMPLATE_IDS.indexOf(latestAsset.templateId as PinterestTemplateId)
    : -1;
  const nextTemplateId = PINTEREST_TEMPLATE_IDS[(currentIndex + 1) % PINTEREST_TEMPLATE_IDS.length];

  await enqueueJob(db, "render_image", { contentItemId: id, templateId: nextTemplateId });
  revalidatePath(REVIEW_PATH);
}
