import type { ContentBrief } from "@/lib/content/contracts";
import type { ContentState } from "@/lib/content/state-machine";

export const PUBLICATION_PLATFORMS = ["FACEBOOK", "INSTAGRAM"] as const;
export const PUBLICATION_TARGET_STATUSES = ["PENDING_REVIEW", "APPROVED"] as const;
export const AUTOMATION_RUN_KINDS = [
  "COPY_REQUEST",
  "COPY_CALLBACK",
  "PUBLISH_REQUEST",
  "PUBLISH_CALLBACK",
] as const;

export type PublicationPlatform = (typeof PUBLICATION_PLATFORMS)[number];
export type PublicationTargetStatus = (typeof PUBLICATION_TARGET_STATUSES)[number];
export type AutomationRunKind = (typeof AUTOMATION_RUN_KINDS)[number];

/** A kind plus key is unique; the corresponding callback may reuse the key. */
export type AutomationRunIdempotency = {
  kind: AutomationRunKind;
  idempotencyKey: string;
};

export type ContentItem = ContentBrief & {
  id: string;
  state: ContentState;
  createdAt: string;
};

export type PublicationTarget = {
  id: string;
  contentItemId: string;
  platform: PublicationPlatform;
  status: PublicationTargetStatus;
};

export type CopyResultCallback = {
  contentItemId: string;
  idempotencyKey: string;
  visualAnalysis: Record<string, unknown>;
  drafts: Array<{
    headline: string;
    body: string;
    cta: string;
  }>;
  warnings: string[];
  provider?: string;
  model?: string;
};

export type StoredCopyDraft = CopyResultCallback["drafts"][number] & {
  id: string;
  contentItemId: string;
  visualAnalysis: Record<string, unknown>;
  provider?: string;
  model?: string;
  createdAt: string;
};

export type ContentAuditEvent = {
  id: string;
  contentItemId: string;
  type: string;
  status: "info" | "success" | "warning";
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CopyResultIngestion = {
  created: boolean;
};

/** Persistence needed by signed n8n copy callbacks. */
export interface CopyResultRepository {
  getContentItem(contentItemId: string): Promise<ContentItem | null>;
  beginCopyGeneration(contentItemId: string): Promise<ContentItem>;
  ingestCopyResult(input: CopyResultCallback): Promise<CopyResultIngestion>;
  listCopyDrafts(contentItemId: string): Promise<StoredCopyDraft[]>;
  listAuditEvents(contentItemId: string): Promise<ContentAuditEvent[]>;
}

export class CopyResultConflictError extends Error {
  constructor() {
    super("The copy result cannot be applied to the current content state.");
    this.name = "CopyResultConflictError";
  }
}

/**
 * Persistence boundary for the portal. UI and routes depend on this contract,
 * never directly on a specific database client.
 */
export interface ContentRepository {
  createContentItem(input: unknown): Promise<ContentItem>;
  listPublicationTargets(contentItemId: string): Promise<PublicationTarget[]>;
}
