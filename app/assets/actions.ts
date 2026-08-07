"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { assetLibrary } from "@/db/schema";
import { uploadLibraryAsset } from "@/lib/storage";

const ASSETS_PATH = "/assets";

function parseTags(raw: FormData | string | null): string[] {
  const value = typeof raw === "string" ? raw : "";
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export async function uploadAsset(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose an image file to upload");
  }
  const tags = parseTags(formData.get("tags") as string | null);
  const notes = (formData.get("notes") as string | null)?.trim() || null;

  const buffer = Buffer.from(await file.arrayBuffer());
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileUrl = await uploadLibraryAsset(buffer, `library/${randomUUID()}-${safeName}`, file.type || "application/octet-stream");

  await db.insert(assetLibrary).values({
    fileUrl,
    tags,
    source: "manual_upload",
    notes,
  });
  revalidatePath(ASSETS_PATH);
}

export async function updateAssetTags(formData: FormData) {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    throw new Error("Missing asset id");
  }
  const tags = parseTags(formData.get("tags") as string | null);
  await db.update(assetLibrary).set({ tags }).where(eq(assetLibrary.id, id));
  revalidatePath(ASSETS_PATH);
}

export async function deleteAsset(formData: FormData) {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    throw new Error("Missing asset id");
  }
  await db.delete(assetLibrary).where(eq(assetLibrary.id, id));
  revalidatePath(ASSETS_PATH);
}
