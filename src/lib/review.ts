import type { contentItemStatusEnum, publishTargetStatusEnum } from "@/db/schema";

type ContentItemStatus = (typeof contentItemStatusEnum.enumValues)[number];
type PublishTargetStatus = (typeof publishTargetStatusEnum.enumValues)[number];

// The one automatic status transition on edit, per docs/PHASE_0_PLAN.md
// §4: editing an already-approved/scheduled item reverts it to
// in_review rather than silently re-publishing altered content. Every
// other status is left as-is — editing a draft/in_review/rejected/failed
// item doesn't change its status, since there was nothing to protect
// against.
export function nextStatusAfterEdit(currentStatus: ContentItemStatus): ContentItemStatus {
  if (currentStatus === "approved" || currentStatus === "scheduled") {
    return "in_review";
  }
  return currentStatus;
}

// Same condition, named for its other effect: whether an edit should
// cancel any publish_targets row still pending for this item.
export function shouldCancelPendingPublish(currentStatus: ContentItemStatus): boolean {
  return currentStatus === "approved" || currentStatus === "scheduled";
}

// publish_targets statuses that count as "still pending" and therefore
// cancelable — a publish that already succeeded or failed terminally
// isn't touched by a later edit.
export const CANCELABLE_PUBLISH_STATUSES: PublishTargetStatus[] = [
  "scheduled",
  "publishing",
  "failed_retrying",
];

// Review Queue default view: what's actually worth Brendan's attention.
// Published/rejected/failed items belong in the Publish Log screen, not
// here.
export const REVIEW_QUEUE_STATUSES: ContentItemStatus[] = ["in_review", "approved", "scheduled"];
