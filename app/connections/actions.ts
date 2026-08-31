"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { brandPolicies, platformEnum, policyModeEnum } from "@/db/schema";
import { PLATFORM_CONTENT_TYPES } from "@/lib/policy";

const CONNECTIONS_PATH = "/connections";

function requireString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required field '${key}'`);
  }
  return value;
}

export async function updatePolicyMode(formData: FormData) {
  const platform = requireString(formData, "platform") as (typeof platformEnum.enumValues)[number];
  const mode = requireString(formData, "mode") as (typeof policyModeEnum.enumValues)[number];

  if (!platformEnum.enumValues.includes(platform)) {
    throw new Error(`Unknown platform '${platform}'`);
  }
  if (!policyModeEnum.enumValues.includes(mode)) {
    throw new Error(`Unknown policy mode '${mode}'`);
  }
  const contentType = PLATFORM_CONTENT_TYPES[platform];

  const [existing] = await db
    .select()
    .from(brandPolicies)
    .where(and(eq(brandPolicies.platform, platform), eq(brandPolicies.contentType, contentType)))
    .limit(1);

  if (existing) {
    await db.update(brandPolicies).set({ mode, updatedAt: new Date() }).where(eq(brandPolicies.id, existing.id));
  } else {
    await db.insert(brandPolicies).values({ platform, contentType, mode });
  }
  revalidatePath(CONNECTIONS_PATH);
}
