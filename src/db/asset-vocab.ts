// Allowed values for asset_library's image-tagging columns (migration
// 0008). Plain text columns with CHECK constraints rather than pgEnums, so
// the read-only blog-writer agent can filter on simple strings and adding
// a value later is a one-line constraint change, not an enum migration.

export const ASSET_SETTINGS = ["installed", "product_only", "render", "detail", "diagram", "other"] as const;

export const ASSET_ROOMS = [
  "living_room",
  "bedroom",
  "kitchen",
  "dining_room",
  "bathroom",
  "basement",
  "office",
  "patio_outdoor",
  "entryway",
  "other",
  "none",
] as const;

export const ASSET_MOUNTINGS = [
  "wall_mounted",
  "built_in",
  "recessed",
  "mantel_surround",
  "freestanding",
  "insert",
  "tv_wall",
  "other",
  "unknown",
] as const;

export const ASSET_CONFIDENCES = ["high", "medium", "low"] as const;

export type AssetSetting = (typeof ASSET_SETTINGS)[number];
export type AssetRoom = (typeof ASSET_ROOMS)[number];
