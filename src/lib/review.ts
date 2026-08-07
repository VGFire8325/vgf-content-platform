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

// Review Queue: strictly the to-do list — items still waiting on a
// decision. Everything else has somewhere else to live: approved/
// scheduled items are on the Scheduled screen (app/scheduled/page.tsx),
// published/rejected/failed items are Publish Log history. An item
// leaves this list the moment it's approved, not when it publishes.
export const REVIEW_QUEUE_STATUSES: ContentItemStatus[] = ["in_review"];

// Scheduled screen: items past review but not yet resolved one way or
// the other — either actively counting down to a publish_targets slot
// ("scheduled") or approved and waiting on a platform connection before
// one gets created ("approved", see scheduleApprovedItem in
// app/review/actions.ts).
export const SCHEDULED_VIEW_STATUSES: ContentItemStatus[] = ["approved", "scheduled"];
