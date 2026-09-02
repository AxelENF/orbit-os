import {
  PUBLICATION_PLATFORMS,
  CopyResultConflictError,
  type ContentAuditEvent,
  type CopyResultCallback,
  type CopyResultIngestion,
  type CopyResultRepository,
  type ContentItem,
  type ContentRepository,
  type PublicationTarget,
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

export class DemoContentRepository implements ContentRepository, CopyResultRepository {
  private readonly contentItems = new Map<string, ContentItem>();
  private readonly targetsByContentItem = new Map<string, PublicationTarget[]>();
  private readonly copyDraftsByContentItem = new Map<string, StoredCopyDraft[]>();
  private readonly auditEventsByContentItem = new Map<string, ContentAuditEvent[]>();
  private readonly callbackKeys = new Set<string>();

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
