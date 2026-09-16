import {
  PUBLICATION_PLATFORMS,
  CopyResultConflictError,
  type CopyRequestPreparation,
  type CopyRequestPreparationInput,
  type CopyRequestRepository,
  PublishTargetConflictError,
  type ContentAuditEvent,
  type ContentAssetUpload,
  type CopyResultCallback,
  type CopyResultIngestion,
  type CopyResultRepository,
  type ContentItem,
  type ContentSummary,
  type FinalCopy,
  type FinalCopySubmission,
  type ContentRepository,
  type ManualPublicationDeliveryInput,
  type PublicationResult,
  type PublicationResultInput,
  type PublicationTarget,
  type PublishRequestPreparation,
  type PublishRequestPreparationInput,
  type PublishRequestRepository,
  type PublishResultCallback,
  type PublishResultIngestion,
  type PublishResultRepository,
  type StoredCopyDraft,
} from "@/lib/content/repository";
import { hasActionableTarget } from "@/lib/content/actionable-target";
import { buildCampaignCode, campaignBriefSchema } from "@/lib/content/campaign";
import { validateFinalCopy } from "@/lib/content/final-copy";
import { transitionContentState, type ContentState } from "@/lib/content/state-machine";
import { parseContentBrief } from "@/lib/content/validation";
import type {
  ClaimedCopyJob,
  CopyJobClaim,
  CopyJobEnqueue,
  CopyJobWorkerRepository,
} from "@/lib/automation/jobs";

function createId(): string {
  return crypto.randomUUID();
}

type DemoRepositoryOptions = {
  initialContentState?: ContentState;
  now?: () => Date;
};

type DemoCopyJob = {
  id: string;
  contentItemId: string;
  idempotencyKey: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED";
  leaseToken?: string;
  leaseExpiresAt?: Date;
  attempts: number;
};

const DEMO_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";
const COPY_LEASE_MS = 10 * 60 * 1_000;

function storedBriefForJob(item: ContentItem): Record<string, unknown> {
  const brief = {
    businessLine: item.businessLine,
    service: item.service,
    niche: item.niche,
    contentType: item.contentType,
    objective: item.objective,
    format: item.format,
    cta: item.cta,
    humanDescription: item.humanDescription,
    allowedFacts: item.allowedFacts,
  };
  return item.campaign
    ? { ...brief, ...item.campaign }
    : brief;
}

export class DemoContentRepository
  implements
    ContentRepository,
    CopyResultRepository,
    CopyRequestRepository,
    CopyJobWorkerRepository,
    PublishRequestRepository,
    PublishResultRepository
{
  private readonly contentItems = new Map<string, ContentItem>();
  private readonly targetsByContentItem = new Map<string, PublicationTarget[]>();
  private readonly copyDraftsByContentItem = new Map<string, StoredCopyDraft[]>();
  private readonly auditEventsByContentItem = new Map<string, ContentAuditEvent[]>();
  private readonly finalCopyByContentItem = new Map<string, FinalCopy>();
  private readonly assetsById = new Map<string, {
    id: string;
    filename: string;
    mimeType: string;
    width: number;
    height: number;
    checksum: string;
    createdAt: string;
  }>();
  private readonly callbackKeys = new Set<string>();
  private readonly publishRequestTargetsByKey = new Map<string, string>();
  private readonly copyRequestItemsByKey = new Map<string, string>();
  private readonly publishCallbackTargetsByKey = new Map<string, string>();
  private readonly manualDeliveryTargetsByKey = new Map<string, string>();
  private readonly publicationResultsByContentItem = new Map<string, PublicationResult[]>();
  private readonly publicationResultTargetByKey = new Map<string, string>();
  private readonly copyJobsById = new Map<string, DemoCopyJob>();
  private readonly copyJobIdByIdempotencyKey = new Map<string, string>();

  constructor(private readonly options: DemoRepositoryOptions = {}) {}

  async createContentItem(input: unknown): Promise<ContentItem> {
    const brief = parseContentBrief(input);
    const campaign = campaignBriefSchema.safeParse(input);
    const id = createId();
    const createdAt = new Date().toISOString();
    const item: ContentItem = {
      ...brief,
      id,
      state: this.options.initialContentState ?? "DRAFT",
      createdAt,
      ...(campaign.success
        ? {
            campaign: {
              campaignName: campaign.data.campaignName,
              offer: campaign.data.offer,
              funnelStage: campaign.data.funnelStage,
              destination: campaign.data.destination,
              destinationValue: campaign.data.destinationValue,
              campaignCode: buildCampaignCode(
                campaign.data.campaignName,
                id,
                new Date(createdAt),
              ),
            },
          }
        : {}),
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

  async createContentItemWithAssets(input: {
    brief: unknown;
    assets: ContentAssetUpload[];
  }): Promise<ContentItem> {
    const coverAsset = input.assets[0];
    if (!coverAsset) throw new Error("At least one content asset is required.");
    const created = await this.createContentItem(input.brief);
    const uploaded: ContentItem = {
      ...created,
      assetId: coverAsset.id,
      state: "UPLOADED",
    };
    for (const asset of input.assets) {
      this.assetsById.set(asset.id, {
        id: asset.id,
        filename: asset.filename,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        checksum: asset.checksum,
        createdAt: new Date().toISOString(),
      });
    }
    this.contentItems.set(uploaded.id, uploaded);
    return { ...uploaded };
  }

  async createContentItemWithAsset(input: {
    brief: unknown;
    asset: ContentAssetUpload;
  }): Promise<ContentItem> {
    return this.createContentItemWithAssets({
      brief: input.brief,
      assets: [input.asset],
    });
  }

  async downloadOrganizationLogo(): Promise<Buffer | null> {
    return null;
  }

  async listPublicationTargets(
    contentItemId: string,
  ): Promise<PublicationTarget[]> {
    return structuredClone(this.targetsByContentItem.get(contentItemId) ?? []);
  }

  async checkPublicationTargetOwnership(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<{ target: { id: string; status: string } | null; failed: boolean }> {
    const targets = this.targetsByContentItem.get(contentItemId) ?? [];
    const target = targets.find((candidate) => candidate.id === publicationTargetId);
    return { target: target ? { id: target.id, status: target.status } : null, failed: false };
  }

  async listContentItems(): Promise<ContentItem[]> {
    return structuredClone([...this.contentItems.values()]);
  }

  async listContentSummaries(): Promise<ContentSummary[]> {
    return structuredClone(
      [...this.contentItems.values()].map((item) => ({
        id: item.id,
        state: item.state,
        createdAt: item.createdAt,
        service: item.service,
        niche: item.niche,
        contentType: item.contentType,
        objective: item.objective,
        hasActionableTarget: hasActionableTarget(item.state, this.targetsByContentItem.get(item.id) ?? []),
        ...(item.assetId ? { assetId: item.assetId } : {}),
        ...(item.campaign ? { campaign: item.campaign } : {}),
      })),
    );
  }

  async getContentRecord(contentItemId: string) {
    const content = await this.getContentItem(contentItemId);
    if (!content) return null;

    const [targets, drafts, auditEvents] = await Promise.all([
      this.listPublicationTargets(contentItemId),
      this.listCopyDrafts(contentItemId),
      this.listAuditEvents(contentItemId),
    ]);

    const finalCopy = this.finalCopyByContentItem.get(contentItemId);
    return {
      content,
      targets,
      drafts,
      auditEvents,
      publicationResults: structuredClone(this.publicationResultsByContentItem.get(contentItemId) ?? []),
      ...(finalCopy ? { finalCopy: structuredClone(finalCopy) } : {}),
    };
  }

  async submitFinalCopyForReview(
    contentItemId: string,
    input: FinalCopySubmission,
  ): Promise<FinalCopy> {
    const item = this.contentItems.get(contentItemId);
    if (!item || item.state !== "DRAFT" || !item.campaign) {
      throw new CopyResultConflictError();
    }
    if (this.finalCopyByContentItem.has(contentItemId)) {
      throw new CopyResultConflictError();
    }
    const validation = validateFinalCopy(input, item);
    if (!validation.ok) {
      throw new CopyResultConflictError();
    }
    const selectedCopyDraftId = input.selectedCopyDraftId;
    if (
      selectedCopyDraftId &&
      !(this.copyDraftsByContentItem.get(contentItemId) ?? []).some(
        (draft) => draft.id === selectedCopyDraftId,
      )
    ) {
      throw new CopyResultConflictError();
    }

    const finalCopy: FinalCopy = {
      id: createId(),
      contentItemId,
      ...(selectedCopyDraftId ? { selectedCopyDraftId } : {}),
      headline: input.headline.trim(),
      body: input.body.trim(),
      cta: input.cta.trim(),
      hashtags: input.hashtags ?? [],
      checksum: `${item.campaign.campaignCode}:${input.headline.trim()}:${input.body.trim()}:${input.cta.trim()}`,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    this.finalCopyByContentItem.set(contentItemId, finalCopy);
    this.contentItems.set(contentItemId, {
      ...item,
      state: transitionContentState(item.state, "REVIEW"),
      selectedFinalCopyId: finalCopy.id,
    });
    this.auditEventsByContentItem.set(contentItemId, [
      ...(this.auditEventsByContentItem.get(contentItemId) ?? []),
      {
        id: createId(),
        contentItemId,
        type: "FINAL_COPY_SUBMITTED",
        status: "success",
        message: "Copy final enviado a revisión humana.",
        metadata: { finalCopyId: finalCopy.id, version: finalCopy.version },
        createdAt: finalCopy.createdAt,
      },
    ]);
    return structuredClone(finalCopy);
  }

  async applyPublicationDiagnosisForContentItem(
    contentItemId: string,
    finalCopy: FinalCopy,
  ): Promise<void> {
    void contentItemId;
    void finalCopy;
  }

  async approvePublicationTarget(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<PublicationTarget & { status: "APPROVED" }> {
    const item = this.contentItems.get(contentItemId);
    if (!item || item.state !== "REVIEW") {
      throw new PublishTargetConflictError();
    }

    const targets = this.targetsByContentItem.get(contentItemId);
    const target = targets?.find((candidate) => candidate.id === publicationTargetId);
    if (!target || !["PENDING_REVIEW", "APPROVED"].includes(target.status)) {
      throw new PublishTargetConflictError();
    }

    if (target.status === "APPROVED") {
      return { ...target, status: "APPROVED" };
    }

    const approved: PublicationTarget = { ...target, status: "APPROVED" };
    this.targetsByContentItem.set(
      contentItemId,
      targets!.map((candidate) =>
      candidate.id === publicationTargetId ? approved : candidate,
      ),
    );

    const allTargetsApproved = targets!.every((candidate) =>
      candidate.id === publicationTargetId
        ? true
        : candidate.status === "APPROVED",
    );
    if (allTargetsApproved) {
      this.contentItems.set(contentItemId, {
        ...item,
        state: transitionContentState(item.state, "APPROVED"),
      });
    }

    const event: ContentAuditEvent = {
      id: createId(),
      contentItemId,
      type: "TARGET_APPROVED",
      status: "success",
      message: `${target.platform} aprobado de forma independiente en modo demo local.`,
      metadata: { publicationTargetId, platform: target.platform },
      createdAt: new Date().toISOString(),
    };
    this.auditEventsByContentItem.set(contentItemId, [
      ...(this.auditEventsByContentItem.get(contentItemId) ?? []),
      event,
    ]);

    return { ...approved, status: "APPROVED" };
  }

  async retryPublicationTarget(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<PublicationTarget & { status: "APPROVED" }> {
    const targets = this.targetsByContentItem.get(contentItemId);
    const target = targets?.find((candidate) => candidate.id === publicationTargetId);
    if (!target || target.status !== "ERROR") throw new PublishTargetConflictError();

    const retried: PublicationTarget = { ...target, status: "APPROVED" };
    delete retried.lastError;
    this.targetsByContentItem.set(
      contentItemId,
      targets!.map((candidate) => candidate.id === publicationTargetId ? retried : candidate),
    );
    return { ...retried, status: "APPROVED" };
  }

  async recordManualPublicationDelivery(
    input: ManualPublicationDeliveryInput,
  ): Promise<PublicationTarget & { status: "PUBLISHED" }> {
    const deliveryKey = `MANUAL_PUBLICATION:${input.idempotencyKey}`;
    const priorTargetId = this.manualDeliveryTargetsByKey.get(deliveryKey);
    if (priorTargetId) {
      if (priorTargetId !== input.publicationTargetId) throw new PublishTargetConflictError();
      const existing = this.targetsByContentItem
        .get(input.contentItemId)
        ?.find((candidate) => candidate.id === input.publicationTargetId);
      if (!existing || existing.status !== "PUBLISHED") throw new PublishTargetConflictError();
      return { ...existing, status: "PUBLISHED" };
    }

    const item = this.contentItems.get(input.contentItemId);
    const targets = this.targetsByContentItem.get(input.contentItemId);
    const target = targets?.find((candidate) => candidate.id === input.publicationTargetId);
    if (!item || item.state !== "APPROVED" || !target || target.status !== "APPROVED") {
      throw new PublishTargetConflictError();
    }

    const delivered: PublicationTarget = {
      ...target,
      status: "PUBLISHED",
      remoteUrl: input.remoteUrl,
      publishedAt: input.publishedAt,
    };
    const nextTargets = targets!.map((candidate) =>
      candidate.id === target.id ? delivered : candidate,
    );
    this.targetsByContentItem.set(input.contentItemId, nextTargets);
    this.manualDeliveryTargetsByKey.set(deliveryKey, target.id);

    if (nextTargets.every((candidate) => candidate.status === "PUBLISHED")) {
      this.contentItems.set(input.contentItemId, {
        ...item,
        state: transitionContentState(item.state, "PUBLISHED"),
      });
    }

    const event: ContentAuditEvent = {
      id: createId(),
      contentItemId: input.contentItemId,
      type: "MANUAL_PUBLICATION_RECORDED",
      status: "success",
      message: `${target.platform} registrado como publicado manualmente en modo demo local.`,
      metadata: {
        publicationTargetId: target.id,
        platform: target.platform,
        source: "manual",
        ...(input.note ? { note: input.note } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    this.auditEventsByContentItem.set(input.contentItemId, [
      ...(this.auditEventsByContentItem.get(input.contentItemId) ?? []),
      event,
    ]);
    return { ...delivered, status: "PUBLISHED" };
  }

  async recordPublicationResult(input: PublicationResultInput): Promise<PublicationResult> {
    const resultKey = `PUBLICATION_RESULT:${input.idempotencyKey}`;
    const priorTargetId = this.publicationResultTargetByKey.get(resultKey);
    if (priorTargetId) {
      if (priorTargetId !== input.publicationTargetId) throw new PublishTargetConflictError();
      const existing = (this.publicationResultsByContentItem.get(input.contentItemId) ?? [])
        .find((candidate) => candidate.publicationTargetId === input.publicationTargetId);
      if (!existing) throw new PublishTargetConflictError();
      return structuredClone(existing);
    }

    const target = this.targetsByContentItem.get(input.contentItemId)
      ?.find((candidate) => candidate.id === input.publicationTargetId);
    if (!target || target.status !== "PUBLISHED") throw new PublishTargetConflictError();
    const metrics = [
      input.reach,
      input.impressions,
      input.conversations,
      input.qualifiedLeads,
      input.appointments,
      input.spendMxn,
      ...(input.revenueMxn === undefined ? [] : [input.revenueMxn]),
    ];
    if (metrics.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new PublishTargetConflictError();
    }

    const result: PublicationResult = {
      id: createId(),
      contentItemId: input.contentItemId,
      publicationTargetId: input.publicationTargetId,
      observedAt: input.observedAt,
      reach: input.reach,
      impressions: input.impressions,
      conversations: input.conversations,
      qualifiedLeads: input.qualifiedLeads,
      appointments: input.appointments,
      spendMxn: input.spendMxn,
      ...(input.revenueMxn === undefined ? {} : { revenueMxn: input.revenueMxn }),
      ...(input.note ? { note: input.note } : {}),
      createdAt: new Date().toISOString(),
    };
    this.publicationResultTargetByKey.set(resultKey, input.publicationTargetId);
    this.publicationResultsByContentItem.set(input.contentItemId, [
      ...(this.publicationResultsByContentItem.get(input.contentItemId) ?? []),
      result,
    ]);
    this.auditEventsByContentItem.set(input.contentItemId, [
      ...(this.auditEventsByContentItem.get(input.contentItemId) ?? []),
      {
        id: createId(),
        contentItemId: input.contentItemId,
        type: "PUBLICATION_RESULT_RECORDED",
        status: "success",
        message: `${target.platform} recibió un resultado manual de seguimiento en modo demo local.`,
        metadata: {
          publicationTargetId: target.id,
          platform: target.platform,
          source: "manual",
        },
        createdAt: new Date().toISOString(),
      },
    ]);
    return structuredClone(result);
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

  async prepareCopyRequest(
    input: CopyRequestPreparationInput,
  ): Promise<CopyRequestPreparation> {
    const item = this.contentItems.get(input.contentItemId);
    if (!item) throw new CopyResultConflictError();

    const requestKey = `COPY_REQUEST:${input.idempotencyKey}`;
    const priorItemId = this.copyRequestItemsByKey.get(requestKey);
    if (priorItemId && priorItemId !== input.contentItemId) {
      throw new CopyResultConflictError();
    }

    if (priorItemId) {
      return {
        created: false,
        status: "DRY_RUN_QUEUED",
        ownerId: "00000000-0000-4000-8000-000000000000",
        contentItem: { ...item },
      };
    }

    const next: ContentItem = {
      ...item,
      state: transitionContentState(item.state, "GENERATING"),
    };
    this.contentItems.set(input.contentItemId, next);
    this.copyRequestItemsByKey.set(requestKey, input.contentItemId);

    const event: ContentAuditEvent = {
      id: createId(),
      contentItemId: input.contentItemId,
      type: "COPY_REQUEST_QUEUED",
      status: "info",
      message: "Copy request queued in demo mode; no network request was sent.",
      metadata: { idempotencyKey: input.idempotencyKey },
      createdAt: new Date().toISOString(),
    };
    this.auditEventsByContentItem.set(input.contentItemId, [
      ...(this.auditEventsByContentItem.get(input.contentItemId) ?? []),
      event,
    ]);

    return {
      created: true,
      status: "DRY_RUN_QUEUED",
      ownerId: "00000000-0000-4000-8000-000000000000",
      contentItem: { ...next },
    };
  }

  async enqueueCopyJob(input: {
    contentItemId: string;
    idempotencyKey: string;
  }): Promise<CopyJobEnqueue> {
    const item = this.contentItems.get(input.contentItemId);
    if (!item?.assetId || !this.assetsById.has(item.assetId)) {
      throw new CopyResultConflictError();
    }

    const priorJobId = this.copyJobIdByIdempotencyKey.get(input.idempotencyKey);
    if (priorJobId) {
      const prior = this.copyJobsById.get(priorJobId);
      if (!prior || prior.contentItemId !== input.contentItemId) {
        throw new CopyResultConflictError();
      }
      return { created: false, jobId: prior.id, idempotencyKey: prior.idempotencyKey };
    }

    if (!(["UPLOADED", "DRAFT", "ERROR"] as const).includes(item.state as "UPLOADED" | "DRAFT" | "ERROR")) {
      throw new CopyResultConflictError();
    }
    const job: DemoCopyJob = {
      id: createId(),
      contentItemId: item.id,
      idempotencyKey: input.idempotencyKey,
      status: "QUEUED",
      attempts: 0,
    };
    this.copyJobsById.set(job.id, job);
    this.copyJobIdByIdempotencyKey.set(job.idempotencyKey, job.id);
    this.copyRequestItemsByKey.set(`COPY_REQUEST:${job.idempotencyKey}`, item.id);
    this.contentItems.set(item.id, {
      ...item,
      state: transitionContentState(item.state, "GENERATING"),
    });
    this.auditEventsByContentItem.set(item.id, [
      ...(this.auditEventsByContentItem.get(item.id) ?? []),
      {
        id: createId(),
        contentItemId: item.id,
        type: "COPY_JOB_QUEUED",
        status: "info",
        message: "Copy job queued for the portal-owned worker.",
        metadata: { jobId: job.id, idempotencyKey: job.idempotencyKey },
        createdAt: this.now().toISOString(),
      },
    ]);
    return { created: true, jobId: job.id, idempotencyKey: job.idempotencyKey };
  }

  async claimCopyJob(input: {
    jobId: string;
    idempotencyKey: string;
  }): Promise<CopyJobClaim> {
    const job = this.copyJobsById.get(input.jobId);
    if (!job || job.idempotencyKey !== input.idempotencyKey || job.status === "COMPLETED") {
      return { state: "NOT_CLAIMABLE" };
    }
    const now = this.now();
    if (job.status === "PROCESSING" && job.leaseExpiresAt && job.leaseExpiresAt > now) {
      return { state: "NOT_CLAIMABLE" };
    }
    const item = this.contentItems.get(job.contentItemId);
    const asset = item?.assetId ? this.assetsById.get(item.assetId) : undefined;
    if (!item || !asset) return { state: "NOT_CLAIMABLE" };

    const leaseToken = createId();
    const leaseExpiresAt = new Date(now.getTime() + COPY_LEASE_MS);
    const claimed: DemoCopyJob = {
      ...job,
      status: "PROCESSING",
      leaseToken,
      leaseExpiresAt,
      attempts: job.attempts + 1,
    };
    this.copyJobsById.set(job.id, claimed);
    const payload: ClaimedCopyJob = {
      id: claimed.id,
      idempotencyKey: claimed.idempotencyKey,
      leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      contentItemId: item.id,
      assetUrl: `https://demo.snapgad.invalid/content-assets/${DEMO_ORGANIZATION_ID}/${asset.id}/${encodeURIComponent(asset.filename)}`,
      brief: storedBriefForJob(item),
    };
    return { state: "CLAIMED", job: payload };
  }

  async completeCopyJob(input: {
    jobId: string;
    idempotencyKey: string;
    leaseToken: string;
    result: Omit<CopyResultCallback, "contentItemId" | "idempotencyKey">;
  }): Promise<{ created: boolean }> {
    const job = this.copyJobsById.get(input.jobId);
    if (!job || job.idempotencyKey !== input.idempotencyKey) {
      throw new CopyResultConflictError();
    }
    if (job.status === "COMPLETED") return { created: false };
    if (
      job.status !== "PROCESSING" ||
      job.leaseToken !== input.leaseToken ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= this.now()
    ) {
      throw new CopyResultConflictError();
    }
    const created = await this.ingestCopyResult({
      contentItemId: job.contentItemId,
      idempotencyKey: job.idempotencyKey,
      ...input.result,
    });
    this.copyJobsById.set(job.id, {
      ...job,
      status: "COMPLETED",
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return created;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
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

    if (
      this.publishRequestTargetsByKey.get(`PUBLISH_REQUEST:${input.idempotencyKey}`) !==
      input.publicationTargetId
    ) {
      throw new PublishTargetConflictError();
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

    if (this.copyRequestItemsByKey.get(`COPY_REQUEST:${input.idempotencyKey}`) !== input.contentItemId) {
      throw new CopyResultConflictError();
    }

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
