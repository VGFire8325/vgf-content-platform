import type { contentTypeEnum, platformEnum, policyModeEnum } from "@/db/schema";

type Platform = (typeof platformEnum.enumValues)[number];
type ContentType = (typeof contentTypeEnum.enumValues)[number];
export type PolicyMode = (typeof policyModeEnum.enumValues)[number];

// Every publish-destination platform maps to exactly one content_type
// (see the platform/content_type enums in src/db/schema.ts) — this is
// the fixed set of rows the Connections/Policy screen manages, one per
// platform, whether or not brand_policies has a row for it yet.
export const PLATFORM_CONTENT_TYPES: Record<Platform, ContentType> = {
  pinterest: "pinterest_pin",
  linkedin: "linkedin_post",
  facebook: "fb_post",
  instagram: "ig_carousel",
};

export const POLICY_MODES: PolicyMode[] = ["manual", "trusted", "autonomous"];

export const POLICY_MODE_LABELS: Record<PolicyMode, string> = {
  manual: "Manual — every item waits in the Review Queue for a human approve",
  trusted: "Trusted — not enforced yet, see note below",
  autonomous: "Autonomous — not enforced yet, see note below",
};
