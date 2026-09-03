import {
  PUBLICATION_PLATFORMS,
  CopyResultConflictError,
  PublishTargetConflictError,
  type ContentAuditEvent,
  type CopyResultCallback,
  type CopyResultIngestion,
  type CopyResultRepository,
  type ContentItem,
  type ContentRepository,
  type PublicationTarget,
  type PublishRequestPreparation,
  type PublishRequestPreparationInput,
  type PublishRequestRepository,
  type PublishResultCallback,
  type PublishResultIngestion,
  type PublishResultRepository,
  type StoredCopyDraft,
} from "@/lib/content/repository";
import { transitionContentState, type ContentState } from "@/lib/content/state-machine";
import { parseContentBrief } from "@/lib/content/validation";

function createId(): string {
  return crypto.randomUUID();
}

type DemoRepositoryOptions = {
  initialContentState?: "DRAFT" | "UPLOADED";
};

export class DemoContentRepository
  implements
    ContentRepository,
    CopyResultRepository,
    PublishRequestRepository,
    PublishResultRepository
{
  private readonly contentItems = new Map<string, ContentItem>();
  private readonly targetsByContentItem = new Map<string, PublicationTarget[]>();
  private readonly copyDraftsByContentItem = new Map<string, StoredCopyDraft[]>();
  private readonly auditEventsByContentItem = new Map<string, ContentAuditEvent[]>();
  private readonly callbackKeys = new Set<string>();
  private readonly publishRequestTargetsByKey = new Map<string, string>();
  private readonly publishCallbackTargetsByKey = new Map<string, string>();

  constructor(private readonly options: DemoRepositoryOptions = {}) {}

  async createContentItem(input: unknown): Promise<ContentItem> {
    const brief = parseContentBrief(input);
    const item: ContentItem = {
      ...brief,
      id: createId(),
      state: this.options.initialContentState ?? "DRAFT",
      createdAt: new Date().toISOString(),
    };

    this.contentItems.set(item.id, item);

    this.targetsByContentItem.set(
      item.id,
      PUBLICATION_PLATFORMS.map((platform) => ({
        id: createId(),
        contentItemId: item.id,
        platform,
        status: "PENDING_REVIEW",
      })),
    );

    return item;
  }

  async listPublicationTargets(
    contentItemId: string,
  ): Promise<PublicationTarget[]> {
    return [...(this.targetsByContentItem.get(contentItemId) ?? [])];
  }

  async approvePublicationTarget(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<PublicationTarget> {
    const targets = this.targetsByContentItem.get(contentItemId);
    const target = targets?.find((candidate) => candidate.id === publicationTargetId);
    if (!target) throw new PublishTargetConflictError();

    const approved: PublicationTarget = { ...target, status: "APPROVED" };
    this.targetsByContentItem.set(
      contentItemId,
      targets!.map((candidate) =>
        candidate.id === publicationTargetId ? approved : candidate,
      ),
    );
    return { ...approved };
  }

  async preparePublishRequest(
    input: PublishRequestPreparationInput,
  ): Promise<PublishRequestPreparation> {
    const targets = this.targetsByContentItem.get(input.contentItemId);
    const target = targets?.find(
      (candidate) => candidate.id === input.publicationTargetId,
    );
    if (!target || target.status !== "APPROVED") {
      throw new PublishTargetConflictError();
    }

    const requestKey = `PUBLISH_REQUEST:${input.idempotencyKey}`;
    const priorTargetId = this.publishRequestTargetsByKey.get(requestKey);
    if (priorTargetId && priorTargetId !== target.id) {
      throw new PublishTargetConflictError();
    }

    const created = !priorTargetId;
    if (created) {
      this.publishRequestTargetsByKey.set(requestKey, target.id);
      const event: ContentAuditEvent = {
        id: createId(),
        contentItemId: input.contentItemId,
        type: "DRY_RUN_QUEUED",
        status: "info",
        message: "Approved target queued in demo mode; no network request was sent.",
        metadata: {
          platform: target.platform,
          publicationTargetId: target.id,
        },
        createdAt: new Date().toISOString(),
      };
      this.auditEventsByContentItem.set(input.contentItemId, [
        ...(this.auditEventsByContentItem.get(input.contentItemId) ?? []),
        event,
      ]);
    }

    return {
      created,
      status: "DRY_RUN_QUEUED",
      ownerId: "00000000-0000-4000-8000-000000000000",
      approvedAt: new Date().toISOString(),
      target: { ...target, status: "APPROVED" },
    };
  }

  async ingestPublishResult(
    input: PublishResultCallback,
  ): Promise<PublishResultIngestion> {
    const callbackKey = `PUBLISH_CALLBACK:${input.idempotencyKey}`;
    const priorTargetId = this.publishCallbackTargetsByKey.get(callbackKey);
    if (priorTargetId) {
      if (priorTargetId !== input.publicationTargetId) {
        throw new PublishTargetConflictError();
      }
      return { created: false };
    }

    const targets = this.targetsByContentItem.get(input.contentItemId);
    const target = targets?.find(
      (candidate) => candidate.id === input.publicationTargetId,
    );
    if (
      !target ||
      target.platform !== input.platform ||
      target.status !== "APPROVED"
    ) {
      throw new PublishTargetConflictError();
    }

    const callbackError = input.error;
    const nextTarget: PublicationTarget =
      callbackError
        ? {
            ...target,
            status: "ERROR",
            lastError: callbackError.message,
          }
        : {
            ...target,
            status: "PUBLISHED",
            remotePostId: input.remotePostId,
            remoteUrl: input.remoteUrl,
            publishedAt: input.publishedAt,
          };
    this.targetsByContentItem.set(
      input.contentItemId,
      targets!.map((candidate) =>
        candidate.id === input.publicationTargetId ? nextTarget : candidate,
      ),
    );
    this.publishCallbackTargetsByKey.set(callbackKey, input.publicationTargetId);

    const event: ContentAuditEvent = {
      id: createId(),
      contentItemId: input.contentItemId,
      type: "PUBLISH_CALLBACK_RECEIVED",
      status: callbackError ? "warning" : "success",
      message:
        callbackError
          ? "Publish callback recorded a sanitized platform error."
          : "Publish callback recorded a remote publication.",
      metadata: {
        platform: input.platform,
        publicationTargetId: input.publicationTargetId,
        outcome: callbackError ? "ERROR" : "PUBLISHED",
        ...(callbackError ? { errorCode: callbackError.code } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    this.auditEventsByContentItem.set(input.contentItemId, [
      ...(this.auditEventsByContentItem.get(input.contentItemId) ?? []),
      event,
    ]);

    return { created: true };
  }

  async beginCopyGeneration(contentItemId: string): Promise<ContentItem> {
    const item = this.contentItems.get(contentItemId);
    if (!item) throw new CopyResultConflictError();

    const next: ContentItem = {
      ...item,
      state: transitionContentState(item.state, "GENERATING"),
    };
    this.contentItems.set(contentItemId, next);
    return { ...next };
  }

  async ingestCopyResult(input: CopyResultCallback): Promise<CopyResultIngestion> {
    const callbackKey = `COPY_CALLBACK:${input.idempotencyKey}`;
    if (this.callbackKeys.has(callbackKey)) return { created: false };

    const item = this.contentItems.get(input.contentItemId);
    if (!item || item.state !== "GENERATING") throw new CopyResultConflictError();

    const nextState: ContentState = transitionContentState(item.state, "DRAFT");
    const drafts = input.drafts.map((draft) => ({
      ...draft,
      id: createId(),
      contentItemId: input.contentItemId,
      visualAnalysis: structuredClone(input.visualAnalysis),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      createdAt: new Date().toISOString(),
    }));
    const event: ContentAuditEvent = {
      id: createId(),
      contentItemId: input.contentItemId,
      type: "COPY_CALLBACK_RECEIVED",
      status: "success",
      message: "Copy callback accepted with two alternatives.",
      metadata: {
        draftCount: drafts.length,
        warningCount: input.warnings.length,
      },
      createdAt: new Date().toISOString(),
    };

    this.copyDraftsByContentItem.set(input.contentItemId, drafts);
    this.auditEventsByContentItem.set(input.contentItemId, [
      ...(this.auditEventsByContentItem.get(input.contentItemId) ?? []),
      event,
    ]);
    this.contentItems.set(input.contentItemId, { ...item, state: nextState });
    this.callbackKeys.add(callbackKey);

    return { created: true };
  }

  async getContentItem(contentItemId: string): Promise<ContentItem | null> {
    const item = this.contentItems.get(contentItemId);
    return item ? { ...item } : null;
  }

  async listCopyDrafts(contentItemId: string): Promise<StoredCopyDraft[]> {
    return structuredClone(this.copyDraftsByContentItem.get(contentItemId) ?? []);
  }

  async listAuditEvents(contentItemId: string): Promise<ContentAuditEvent[]> {
    return structuredClone(this.auditEventsByContentItem.get(contentItemId) ?? []);
  }
}

/** Creates isolated in-memory demo storage and never makes network calls. */
export function createDemoRepository(
  options: DemoRepositoryOptions = {},
): DemoContentRepository {
  return new DemoContentRepository(options);
}
