import { createHash } from "node:crypto";

// Used to skip no-op article re-triggers (docs/PHASE_0_PLAN.md §1) — a
// Shopify `articles/update` webhook fires on any save, including a typo
// fix, so we only re-extract when the actual content changed.
export function hashArticleContent(bodyHtml: string): string {
  return createHash("sha256").update(bodyHtml, "utf8").digest("hex");
}
