import type {
  CampaignBrief,
  CampaignDestination,
  CampaignFunnelStage,
} from "@/lib/content/campaign";
import type { ContentBrief } from "@/lib/content/contracts";
import type { ContentState } from "@/lib/content/state-machine";
import type { CopyJobRepository } from "@/lib/automation/jobs";

export const PUBLICATION_PLATFORMS = ["FACEBOOK", "INSTAGRAM"] as const;
export const PUBLICATION_TARGET_STATUSES = [
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "SCHEDULED",
  "PUBLISHED",
  "ERROR",
] as const;
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
  assetId?: string;
  selectedFinalCopyId?: string;
  campaign?: CampaignContext;
};

/** Lightweight list projection; detail screens request full records separately. */
export type ContentSummary = Pick<
  ContentItem,
  "id" | "state" | "createdAt" | "assetId" | "campaign"
> &
  Pick<ContentBrief, "service" | "niche" | "contentType" | "objective">;

export type CampaignContext = Pick<
  CampaignBrief,
  "campaignName" | "offer" | "destination" | "destinationValue"
> & {
  funnelStage: CampaignFunnelStage;
  destination: CampaignDestination;
  campaignCode: string;
};

export type FinalCopy = {
  id: string;
  contentItemId: string;
  selectedCopyDraftId?: string;
  headline: string;
  body: string;
  cta: string;
  checksum: string;
  version: number;
  createdAt: string;
};

export type FinalCopySubmission = {
  selectedCopyDraftId?: string;
  headline: string;
  body: string;
  cta: string;
};

export type ContentAsset = {
  id: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  checksum: string;
  createdAt: string;
  signedUrl?: string;
};

export type ContentAssetUpload = {
  id: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  checksum: string;
  bytes: Uint8Array;
};

export type PublicationTarget = {
  id: string;
  contentItemId: string;
  platform: PublicationPlatform;
  status: PublicationTargetStatus;
  remotePostId?: string;
  remoteUrl?: string;
  publishedAt?: string;
  lastError?: string;
};

export type PublishRequestPreparationInput = {
  contentItemId: string;
  publicationTargetId: string;
  idempotencyKey: string;
};

export type PublishRequestPreparation = {
  created: boolean;
  status: "READY" | "DRY_RUN_QUEUED";
  ownerId: string;
  approvedAt: string;
  target: PublicationTarget & { status: "APPROVED" };
};

export type CopyRequestPreparationInput = {
  contentItemId: string;
  idempotencyKey: string;
};

export type CopyRequestPreparation = {
  created: boolean;
  status: "READY" | "DRY_RUN_QUEUED";
  ownerId: string;
  contentItem: ContentItem;
};

type PublishResultIdentity = {
  contentItemId: string;
  publicationTargetId: string;
  platform: PublicationPlatform;
  idempotencyKey: string;
};

export type PublishResultCallback = PublishResultIdentity &
  (
    | {
        remotePostId: string;
        remoteUrl: string;
        publishedAt: string;
        error?: never;
      }
    | {
        remotePostId?: never;
        remoteUrl?: never;
        publishedAt?: never;
        error: {
          code: string;
          message: string;
        };
      }
  );

export type PublishResultIngestion = {
  created: boolean;
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

export type ContentRecord = {
  content: ContentItem;
  asset?: ContentAsset;
  targets: PublicationTarget[];
  drafts: StoredCopyDraft[];
  auditEvents: ContentAuditEvent[];
  finalCopy?: FinalCopy;
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

/** Persistence needed before sending a signed n8n copy request. */
export interface CopyRequestRepository {
  getContentItem(contentItemId: string): Promise<ContentItem | null>;
  prepareCopyRequest(
    input: CopyRequestPreparationInput,
  ): Promise<CopyRequestPreparation>;
}

export interface PublishRequestRepository {
  preparePublishRequest(
    input: PublishRequestPreparationInput,
  ): Promise<PublishRequestPreparation>;
}

/** Persistence needed by signed n8n publish callbacks. */
export interface PublishResultRepository {
  ingestPublishResult(
    input: PublishResultCallback,
  ): Promise<PublishResultIngestion>;
}

export class CopyResultConflictError extends Error {
  constructor() {
    super("The copy result cannot be applied to the current content state.");
    this.name = "CopyResultConflictError";
  }
}

export class PublishTargetConflictError extends Error {
  constructor() {
    super("The publication target is not approved for this operation.");
    this.name = "PublishTargetConflictError";
  }
}

/**
 * Persistence boundary for the portal. UI and routes depend on this contract,
 * never directly on a specific database client.
 */
export interface ContentRepository
  extends PublishRequestRepository,
    CopyRequestRepository,
    CopyJobRepository {
  createContentItem(input: unknown): Promise<ContentItem>;
  createContentItemWithAsset(input: {
    brief: unknown;
    asset: ContentAssetUpload;
  }): Promise<ContentItem>;
  listContentItems(): Promise<ContentItem[]>;
  listContentSummaries(): Promise<ContentSummary[]>;
  getContentRecord(contentItemId: string): Promise<ContentRecord | null>;
  listPublicationTargets(contentItemId: string): Promise<PublicationTarget[]>;
  approvePublicationTarget(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<PublicationTarget & { status: "APPROVED" }>;
  submitFinalCopyForReview(
    contentItemId: string,
    input: FinalCopySubmission,
  ): Promise<FinalCopy>;
}
