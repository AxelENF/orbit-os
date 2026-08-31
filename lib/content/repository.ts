import type { ContentBrief } from "@/lib/content/contracts";

export const PUBLICATION_PLATFORMS = ["FACEBOOK", "INSTAGRAM"] as const;
export const PUBLICATION_TARGET_STATUSES = ["PENDING_REVIEW"] as const;

export type PublicationPlatform = (typeof PUBLICATION_PLATFORMS)[number];
export type PublicationTargetStatus = (typeof PUBLICATION_TARGET_STATUSES)[number];

export type ContentItem = ContentBrief & {
  id: string;
  state: "DRAFT";
  createdAt: string;
};

export type PublicationTarget = {
  id: string;
  contentItemId: string;
  platform: PublicationPlatform;
  status: PublicationTargetStatus;
};

/**
 * Persistence boundary for the portal. UI and routes depend on this contract,
 * never directly on a specific database client.
 */
export interface ContentRepository {
  createContentItem(input: unknown): Promise<ContentItem>;
  listPublicationTargets(contentItemId: string): Promise<PublicationTarget[]>;
}
