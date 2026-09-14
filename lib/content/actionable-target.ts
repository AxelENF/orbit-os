import type { ContentState } from "@/lib/content/state-machine";
import type { PublicationTarget } from "@/lib/content/repository";

/**
 * A content item needs human attention when either a PENDING_REVIEW
 * target exists once the item has reached REVIEW (the only state that
 * gates the approve control today), or any target is ERROR regardless
 * of content state (retry never depends on content.state — see
 * docs/superpowers/specs/2026-09-14-navigation-unification-design.md).
 */
export function hasActionableTarget(contentState: ContentState, targets: Pick<PublicationTarget, "status">[]): boolean {
  const hasPendingReview = targets.some((target) => target.status === "PENDING_REVIEW");
  const hasError = targets.some((target) => target.status === "ERROR");
  return (contentState === "REVIEW" && hasPendingReview) || hasError;
}
