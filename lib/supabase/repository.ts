import { createHash, randomUUID } from "node:crypto";

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { contentBriefSchema } from "@/lib/content/contracts";
import { buildCampaignCode, campaignBriefSchema } from "@/lib/content/campaign";
import { validateFinalCopy } from "@/lib/content/final-copy";
import { aiasOrganizationProfileSchema, type AiasPlatform } from "@/lib/aias/contracts";
import { diagnosePublication } from "@/lib/aias/publication-diagnosis";
import {
  CopyResultConflictError,
  type CopyRequestPreparation,
  type CopyRequestPreparationInput,
  type CopyRequestRepository,
  PublishTargetConflictError,
  PUBLICATION_PLATFORMS,
  PUBLICATION_TARGET_STATUSES,
  type ContentAuditEvent,
  type ContentAsset,
  type ContentAssetUpload,
  type ContentItem,
  type ContentSummary,
  type FinalCopy,
  type FinalCopySubmission,
  type ContentRecord,
  type ContentRepository,
  type ManualPublicationDeliveryInput,
  type PublicationResult,
  type PublicationResultInput,
  type CopyResultCallback,
  type CopyResultIngestion,
  type CopyResultRepository,
  type PublicationTarget,
  type PublishRequestPreparation,
  type PublishRequestPreparationInput,
  type PublishResultCallback,
  type PublishResultIngestion,
  type PublishResultRepository,
  type StoredCopyDraft,
} from "@/lib/content/repository";
import type { OrganizationContext } from "@/lib/organizations/context";
import { contentStateSchema } from "@/lib/content/state-machine";
import type {
  ClaimedCopyJob,
  CopyJobClaim,
  CopyJobEnqueue,
  CopyJobWorkerRepository,
} from "@/lib/automation/jobs";

function createId(): string {
  return randomUUID();
}

const contentItemRowSchema = z.object({
  id: z.string().uuid(),
  asset_id: z.string().uuid().nullable().optional(),
  business_line: z.string(),
  service: z.string(),
  niche: z.string(),
  content_type: z.string(),
  objective: z.string(),
  format: z.string(),
  cta: z.string(),
  human_description: z.string(),
  allowed_facts: z.array(z.string()),
  campaign_name: z.string().nullable().optional(),
  offer: z.string().nullable().optional(),
  funnel_stage: z.string().nullable().optional(),
  destination: z.string().nullable().optional(),
  destination_value: z.string().nullable().optional(),
  campaign_code: z.string().nullable().optional(),
  selected_final_copy_id: z.string().uuid().nullable().optional(),
  state: contentStateSchema,
  created_at: z.string().datetime({ offset: true }),
});

const finalCopyRowSchema = z.object({
  id: z.string().uuid(),
  content_item_id: z.string().uuid(),
  selected_copy_draft_id: z.string().uuid().nullable().optional(),
  headline: z.string().min(1),
  body: z.string().min(1),
  cta: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  checksum: z.string().min(1),
  version: z.number().int().positive(),
  created_at: z.string().datetime({ offset: true }),
});

const publicationTargetRowSchema = z.object({
  id: z.string().uuid(),
  content_item_id: z.string().uuid(),
  platform: z.enum(PUBLICATION_PLATFORMS),
  status: z.enum(PUBLICATION_TARGET_STATUSES),
  remote_post_id: z.string().nullable().optional(),
  remote_url: z.string().nullable().optional(),
  published_at: z.string().datetime({ offset: true }).nullable().optional(),
  last_error: z.string().nullable().optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
});

const copyResultIngestionSchema = z.object({
  created: z.boolean(),
});

const publishResultIngestionSchema = z.object({
  created: z.boolean(),
});

const copyJobEnqueueSchema = z.object({
  created: z.boolean(),
  jobId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
});

const copyJobClaimSchema = z.union([
  z.object({ state: z.literal("NOT_CLAIMABLE") }),
  z.object({
    state: z.literal("CLAIMED"),
    job: z.object({
      id: z.string().uuid(),
      idempotencyKey: z.string().uuid(),
      leaseToken: z.string().uuid(),
      leaseExpiresAt: z.string().datetime({ offset: true }),
      contentItemId: z.string().uuid(),
      storagePath: z.string().min(1),
      brief: z.record(z.string(), z.unknown()),
    }),
  }),
]);

const copyDraftRowSchema = z.object({
  id: z.string().uuid(),
  content_item_id: z.string().uuid(),
  visual_analysis: z.record(z.string(), z.unknown()),
  headline: z.string().min(1),
  body: z.string().min(1),
  cta: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  created_at: z.string().datetime({ offset: true }),
});

const auditEventRowSchema = z.object({
  id: z.string().uuid(),
  content_item_id: z.string().uuid(),
  event_type: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime({ offset: true }),
});

const publicationResultRowSchema = z.object({
  id: z.string().uuid(),
  content_item_id: z.string().uuid(),
  publication_target_id: z.string().uuid(),
  observed_at: z.string().datetime({ offset: true }),
  reach: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  qualified_leads: z.number().int().nonnegative(),
  appointments: z.number().int().nonnegative(),
  spend_mxn: z.coerce.number().nonnegative(),
  revenue_mxn: z.coerce.number().nonnegative().nullable().optional(),
  note: z.string().nullable().optional(),
  created_at: z.string().datetime({ offset: true }),
});

const assetRowSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  checksum: z.string().min(1),
  bucket_id: z.literal("content-assets"),
  storage_path: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
});

function toContentItem(row: unknown): ContentItem {
  const parsedRow = contentItemRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw new Error("Supabase returned an invalid content item.");
  }

  const brief = contentBriefSchema.safeParse({
    businessLine: parsedRow.data.business_line,
    service: parsedRow.data.service,
    niche: parsedRow.data.niche,
    contentType: parsedRow.data.content_type,
    objective: parsedRow.data.objective,
    format: parsedRow.data.format,
    cta: parsedRow.data.cta,
    humanDescription: parsedRow.data.human_description,
    allowedFacts: parsedRow.data.allowed_facts,
  });
  if (!brief.success) {
    throw new Error("Supabase returned an invalid content brief.");
  }

  const campaign = campaignBriefSchema.safeParse({
    ...brief.data,
    campaignName: parsedRow.data.campaign_name,
    offer: parsedRow.data.offer,
    funnelStage: parsedRow.data.funnel_stage,
    destination: parsedRow.data.destination,
    destinationValue: parsedRow.data.destination_value,
  });

  return {
    ...brief.data,
    id: parsedRow.data.id,
    state: parsedRow.data.state,
    createdAt: parsedRow.data.created_at,
    ...(parsedRow.data.asset_id ? { assetId: parsedRow.data.asset_id } : {}),
    ...(parsedRow.data.selected_final_copy_id
      ? { selectedFinalCopyId: parsedRow.data.selected_final_copy_id }
      : {}),
    ...(campaign.success && parsedRow.data.campaign_code
      ? {
          campaign: {
            campaignName: campaign.data.campaignName,
            offer: campaign.data.offer,
            funnelStage: campaign.data.funnelStage,
            destination: campaign.data.destination,
            destinationValue: campaign.data.destinationValue,
            campaignCode: parsedRow.data.campaign_code,
          },
        }
      : {}),
  };
}

function toFinalCopy(row: unknown): FinalCopy {
  const parsedRow = finalCopyRowSchema.safeParse(row);
  if (!parsedRow.success) throw new Error("Supabase returned an invalid final copy.");
  return {
    id: parsedRow.data.id,
    contentItemId: parsedRow.data.content_item_id,
    ...(parsedRow.data.selected_copy_draft_id
      ? { selectedCopyDraftId: parsedRow.data.selected_copy_draft_id }
      : {}),
    headline: parsedRow.data.headline,
    body: parsedRow.data.body,
    cta: parsedRow.data.cta,
    hashtags: parsedRow.data.hashtags,
    checksum: parsedRow.data.checksum,
    version: parsedRow.data.version,
    createdAt: parsedRow.data.created_at,
  };
}

function toContentAsset(row: unknown, signedUrl?: string): ContentAsset {
  const parsedRow = assetRowSchema.safeParse(row);
  if (!parsedRow.success) throw new Error("Supabase returned an invalid content asset.");
  return {
    id: parsedRow.data.id,
    filename: parsedRow.data.filename,
    mimeType: parsedRow.data.mime_type,
    width: parsedRow.data.width,
    height: parsedRow.data.height,
    checksum: parsedRow.data.checksum,
    createdAt: parsedRow.data.created_at,
    ...(signedUrl ? { signedUrl } : {}),
  };
}

function toPublicationTargets(rows: unknown): PublicationTarget[] {
  const parsedRows = z.array(publicationTargetRowSchema).safeParse(rows);
  if (!parsedRows.success) {
    throw new Error("Supabase returned invalid publication targets.");
  }

  return parsedRows.data.map((row) => ({
    id: row.id,
    contentItemId: row.content_item_id,
    platform: row.platform,
    status: row.status,
    ...(row.remote_post_id ? { remotePostId: row.remote_post_id } : {}),
    ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  }));
}

function toPublicationResults(rows: unknown): PublicationResult[] {
  const parsedRows = z.array(publicationResultRowSchema).safeParse(rows);
  if (!parsedRows.success) throw new Error("Supabase returned invalid publication results.");
  return parsedRows.data.map((row) => ({
    id: row.id,
    contentItemId: row.content_item_id,
    publicationTargetId: row.publication_target_id,
    observedAt: row.observed_at,
    reach: row.reach,
    impressions: row.impressions,
    conversations: row.conversations,
    qualifiedLeads: row.qualified_leads,
    appointments: row.appointments,
    spendMxn: row.spend_mxn,
    ...(row.revenue_mxn === null || row.revenue_mxn === undefined ? {} : { revenueMxn: row.revenue_mxn }),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
  }));
}

function toCopyDrafts(rows: unknown): StoredCopyDraft[] {
  const parsedRows = z.array(copyDraftRowSchema).safeParse(rows);
  if (!parsedRows.success) {
    throw new Error("Supabase returned invalid copy drafts.");
  }

  return parsedRows.data.map((row) => ({
    id: row.id,
    contentItemId: row.content_item_id,
    visualAnalysis: row.visual_analysis,
    headline: row.headline,
    body: row.body,
    cta: row.cta,
    hashtags: row.hashtags,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: row.created_at,
  }));
}

function auditEventStatus(
  type: string,
  metadata: Record<string, unknown>,
): ContentAuditEvent["status"] {
  if (metadata.outcome === "ERROR" || type.endsWith("_FAILED")) return "warning";
  if (type.endsWith("_RECEIVED") || type === "TARGET_APPROVED") return "success";
  return "info";
}

function auditEventMessage(
  type: string,
  metadata: Record<string, unknown>,
): string {
  if (type === "CONTENT_CREATED") return "Contenido creado con brief y destinos independientes.";
  if (type === "COPY_REQUEST_QUEUED") return "Solicitud de copy enviada a n8n.";
  if (type === "COPY_CALLBACK_RECEIVED") return "Callback de copy recibido con alternativas estructuradas.";
  if (type === "TARGET_APPROVED") {
    return `${String(metadata.platform ?? "Destino")} aprobado de forma independiente.`;
  }
  if (type === "PUBLISH_CALLBACK_RECEIVED") {
    return metadata.outcome === "ERROR"
      ? "Callback de publicación recibido con error sanitizado."
      : "Publicación remota confirmada por callback.";
  }
  return type.replaceAll("_", " ");
}

function toAuditEvents(rows: unknown): ContentAuditEvent[] {
  const parsedRows = z.array(auditEventRowSchema).safeParse(rows);
  if (!parsedRows.success) {
    throw new Error("Supabase returned invalid audit events.");
  }

  return parsedRows.data.map((row) => ({
    id: row.id,
    contentItemId: row.content_item_id,
    type: row.event_type,
    status: auditEventStatus(row.event_type, row.metadata),
    message: auditEventMessage(row.event_type, row.metadata),
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

class SupabaseCopyResultRepository
  implements
    Pick<CopyResultRepository, "ingestCopyResult">,
    Pick<PublishResultRepository, "ingestPublishResult">,
    CopyJobWorkerRepository
{
  constructor(protected readonly client: SupabaseClient) {}

  async ingestCopyResult(
    input: CopyResultCallback,
  ): Promise<CopyResultIngestion> {
    const { data, error } = await this.client.rpc(
      "ingest_copy_result_callback",
      {
        p_content_item_id: input.contentItemId,
        p_idempotency_key: input.idempotencyKey,
        p_visual_analysis: input.visualAnalysis,
        p_drafts: input.drafts,
        p_warnings: input.warnings,
        p_provider: input.provider ?? null,
        p_model: input.model ?? null,
      },
    );

    if (error) {
      if (
        error.message === "COPY_RESULT_INVALID_STATE" ||
        error.message === "COPY_RESULT_CONTENT_NOT_FOUND" ||
        error.message === "COPY_REQUEST_NOT_FOUND" ||
        error.message === "COPY_REQUEST_IDEMPOTENCY_KEY_REUSED"
      ) {
        throw new CopyResultConflictError();
      }
      throw new Error("Unable to ingest the copy result.");
    }

    const result = copyResultIngestionSchema.safeParse(data);
    if (!result.success) {
      throw new Error("Supabase returned an invalid copy result ingestion.");
    }
    return result.data;
  }

  async ingestPublishResult(
    input: PublishResultCallback,
  ): Promise<PublishResultIngestion> {
    const errorResult = input.error;
    const { data, error } = await this.client.rpc(
      "ingest_publish_result_callback",
      {
        p_content_item_id: input.contentItemId,
        p_publication_target_id: input.publicationTargetId,
        p_platform: input.platform,
        p_idempotency_key: input.idempotencyKey,
        p_remote_post_id: errorResult ? null : input.remotePostId,
        p_remote_url: errorResult ? null : input.remoteUrl,
        p_published_at: errorResult ? null : input.publishedAt,
        p_error_code: errorResult?.code ?? null,
        p_error_message: errorResult?.message ?? null,
      },
    );

    if (error) {
      if (
        error.message === "PUBLISH_TARGET_NOT_APPROVED" ||
        error.message === "PUBLISH_TARGET_NOT_FOUND" ||
        error.message === "PUBLISH_TARGET_MISMATCH" ||
        error.message === "PUBLISH_IDEMPOTENCY_KEY_REUSED" ||
        error.message === "PUBLISH_REQUEST_NOT_FOUND"
      ) {
        throw new PublishTargetConflictError();
      }
      throw new Error("Unable to ingest the publish result.");
    }

    const result = publishResultIngestionSchema.safeParse(data);
    if (!result.success) {
      throw new Error("Supabase returned an invalid publish result ingestion.");
    }
    return result.data;
  }

  async claimCopyJob(input: {
    jobId: string;
    idempotencyKey: string;
  }): Promise<CopyJobClaim> {
    const { data, error } = await this.client.rpc("claim_copy_automation_job", {
      p_job_id: input.jobId,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      if (error.message === "COPY_JOB_ASSET_NOT_FOUND") {
        throw new CopyResultConflictError();
      }
      throw new Error("Unable to claim the copy job.");
    }
    const claim = copyJobClaimSchema.safeParse(data);
    if (!claim.success) throw new Error("Supabase returned an invalid copy job claim.");
    if (claim.data.state === "NOT_CLAIMABLE") return claim.data;

    const signed = await this.client.storage
      .from("content-assets")
      .createSignedUrl(claim.data.job.storagePath, 10 * 60);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error("Unable to create a signed copy-job asset URL.");
    }
    const job: ClaimedCopyJob = {
      id: claim.data.job.id,
      idempotencyKey: claim.data.job.idempotencyKey,
      leaseToken: claim.data.job.leaseToken,
      leaseExpiresAt: claim.data.job.leaseExpiresAt,
      contentItemId: claim.data.job.contentItemId,
      assetUrl: signed.data.signedUrl,
      brief: claim.data.job.brief,
    };
    return { state: "CLAIMED", job };
  }

  async completeCopyJob(input: {
    jobId: string;
    idempotencyKey: string;
    leaseToken: string;
    result: Omit<CopyResultCallback, "contentItemId" | "idempotencyKey">;
  }): Promise<{ created: boolean }> {
    const { data, error } = await this.client.rpc("complete_copy_automation_job", {
      p_job_id: input.jobId,
      p_idempotency_key: input.idempotencyKey,
      p_lease_token: input.leaseToken,
      p_result: input.result,
    });
    if (error) {
      if (
        error.message === "COPY_JOB_NOT_FOUND" ||
        error.message === "COPY_JOB_LEASE_INVALID"
      ) {
        throw new CopyResultConflictError();
      }
      throw new Error("Unable to complete the copy job.");
    }
    const result = copyResultIngestionSchema.safeParse(data);
    if (!result.success) throw new Error("Supabase returned an invalid copy job completion.");
    return result.data;
  }
}

class SupabaseContentRepository
  extends SupabaseCopyResultRepository
  implements ContentRepository, CopyRequestRepository
{
  constructor(
    client: SupabaseClient,
    private readonly organization: OrganizationContext,
  ) {
    super(client);
  }

  async createContentItem(input: unknown): Promise<ContentItem> {
    const brief = contentBriefSchema.parse(input);
    const { data, error } = await this.client.rpc(
      "create_content_item_with_targets",
      {
        p_owner_id: this.organization.userId,
        p_organization_id: this.organization.organizationId,
        p_business_line: brief.businessLine,
        p_service: brief.service,
        p_niche: brief.niche,
        p_content_type: brief.contentType,
        p_objective: brief.objective,
        p_format: brief.format,
        p_cta: brief.cta,
        p_human_description: brief.humanDescription,
        p_allowed_facts: brief.allowedFacts,
      },
    );

    if (error) {
      throw new Error("Unable to create the content item.");
    }

    return toContentItem(data);
  }

  async createContentItemWithAssets(input: {
    brief: unknown;
    assets: ContentAssetUpload[];
  }): Promise<ContentItem> {
    const brief = contentBriefSchema.parse(input.brief);
    const campaign = campaignBriefSchema.safeParse(input.brief);
    const coverAsset = input.assets[0];
    if (!coverAsset) throw new Error("At least one content asset is required.");
    const storage = this.client.storage.from("content-assets");
    const uploadedPaths: string[] = [];
    const preparedAssets = input.assets.map((asset) => {
      const safeFilename = asset.filename
        .normalize("NFKC")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .slice(0, 120) || "creative";
      return {
        asset,
        storagePath: `${this.organization.organizationId}/${asset.id}/${safeFilename}`,
      };
    });

    try {
      for (const { asset, storagePath: path } of preparedAssets) {
        const upload = await storage.upload(path, asset.bytes, {
          contentType: asset.mimeType,
          upsert: false,
        });
        if (upload.error) throw new Error("Unable to upload the content asset.");
        uploadedPaths.push(path);
      }

      const baseArguments = {
        p_owner_id: this.organization.userId,
        p_organization_id: this.organization.organizationId,
        p_assets: preparedAssets.map(({ asset, storagePath }, position) => ({
          assetId: asset.id,
          position,
          storagePath,
          filename: asset.filename,
          mimeType: asset.mimeType,
          width: asset.width,
          height: asset.height,
          checksum: asset.checksum,
        })),
        p_business_line: brief.businessLine,
        p_service: brief.service,
        p_niche: brief.niche,
        p_content_type: brief.contentType,
        p_objective: brief.objective,
        p_format: brief.format,
        p_cta: brief.cta,
        p_human_description: brief.humanDescription,
        p_allowed_facts: brief.allowedFacts,
      };
      const { data, error } = await this.client.rpc(
        "create_content_item_with_assets_in_organization",
        {
          ...baseArguments,
          p_campaign_name: campaign.success ? campaign.data.campaignName : null,
          p_offer: campaign.success ? campaign.data.offer : null,
          p_funnel_stage: campaign.success ? campaign.data.funnelStage : null,
          p_destination: campaign.success ? campaign.data.destination : null,
          p_destination_value: campaign.success ? campaign.data.destinationValue : null,
          p_campaign_code: campaign.success
            ? buildCampaignCode(campaign.data.campaignName, coverAsset.id)
            : null,
        },
      );

      if (error) throw new Error("Unable to create the content item with asset.");
      return toContentItem(data);
    } catch (error) {
      if (uploadedPaths.length > 0) await storage.remove(uploadedPaths);
      throw error;
    }
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

  async listPublicationTargets(
    contentItemId: string,
  ): Promise<PublicationTarget[]> {
    const { data, error } = await this.client
      .from("publication_targets")
      .select("id, content_item_id, platform, status, remote_post_id, remote_url, published_at, last_error, updated_at")
      .eq("content_item_id", contentItemId)
      .eq("organization_id", this.organization.organizationId)
      .order("platform");

    if (error) {
      throw new Error("Unable to list publication targets.");
    }

    return toPublicationTargets(data);
  }

  async listContentItems(): Promise<ContentItem[]> {
    const { data, error } = await this.client
      .from("content_items")
      .select("id, asset_id, business_line, service, niche, content_type, objective, format, cta, human_description, allowed_facts, campaign_name, offer, funnel_stage, destination, destination_value, campaign_code, selected_final_copy_id, state, created_at")
      .eq("organization_id", this.organization.organizationId)
      .order("created_at", { ascending: false });

    if (error) throw new Error("Unable to list content items.");
    const parsedRows = z.array(contentItemRowSchema).safeParse(data);
    if (!parsedRows.success) throw new Error("Supabase returned invalid content items.");
    return parsedRows.data.map(toContentItem);
  }

  async listContentSummaries(): Promise<ContentSummary[]> {
    const { data, error } = await this.client
      .from("content_items")
      .select("id, asset_id, service, niche, content_type, objective, campaign_name, offer, funnel_stage, destination, destination_value, campaign_code, state, created_at")
      .eq("organization_id", this.organization.organizationId)
      .order("created_at", { ascending: false });

    if (error) throw new Error("Unable to list content summaries.");
    const rows = z.array(contentItemRowSchema.partial({
      business_line: true,
      format: true,
      cta: true,
      human_description: true,
      allowed_facts: true,
    })).safeParse(data);
    if (!rows.success) throw new Error("Supabase returned invalid content summaries.");
    return rows.data.map((row) => {
      const brief = contentBriefSchema.pick({
        service: true,
        niche: true,
        contentType: true,
        objective: true,
      }).safeParse({
        service: row.service,
        niche: row.niche,
        contentType: row.content_type,
        objective: row.objective,
      });
      if (!brief.success) throw new Error("Supabase returned an invalid content summary.");
      const campaign = campaignBriefSchema.pick({
        campaignName: true,
        offer: true,
        funnelStage: true,
        destination: true,
        destinationValue: true,
      }).safeParse({
        campaignName: row.campaign_name,
        offer: row.offer,
        funnelStage: row.funnel_stage,
        destination: row.destination,
        destinationValue: row.destination_value,
      });
      return {
        id: row.id,
        state: row.state,
        createdAt: row.created_at,
        ...brief.data,
        ...(row.asset_id ? { assetId: row.asset_id } : {}),
        ...(campaign.success && row.campaign_code
          ? { campaign: { ...campaign.data, campaignCode: row.campaign_code } }
          : {}),
      };
    });
  }

  async getContentRecord(contentItemId: string): Promise<ContentRecord | null> {
    const content = await this.getContentItem(contentItemId);
    if (!content) return null;

    const [targetsResult, draftsResult, auditResult, resultsResult, finalCopyResult, assetResult] = await Promise.all([
      this.client
        .from("publication_targets")
        .select("id, content_item_id, platform, status, remote_post_id, remote_url, published_at, last_error, updated_at")
        .eq("content_item_id", contentItemId)
        .eq("organization_id", this.organization.organizationId)
        .order("platform"),
      this.client
        .from("copy_drafts")
        .select("id, content_item_id, visual_analysis, headline, body, cta, hashtags, provider, model, created_at")
        .eq("content_item_id", contentItemId)
        .eq("organization_id", this.organization.organizationId)
        .order("revision"),
      this.client
        .from("audit_events")
        .select("id, content_item_id, event_type, metadata, created_at")
        .eq("content_item_id", contentItemId)
        .eq("organization_id", this.organization.organizationId)
        .order("created_at", { ascending: true }),
      this.client
        .from("publication_result_snapshots")
        .select("id, content_item_id, publication_target_id, observed_at, reach, impressions, conversations, qualified_leads, appointments, spend_mxn, revenue_mxn, note, created_at")
        .eq("content_item_id", contentItemId)
        .eq("organization_id", this.organization.organizationId)
        .order("observed_at", { ascending: false }),
      content.selectedFinalCopyId
        ? this.client
            .from("final_copy_versions")
            .select("id, content_item_id, selected_copy_draft_id, headline, body, cta, hashtags, checksum, version, created_at")
            .eq("id", content.selectedFinalCopyId)
            .eq("content_item_id", contentItemId)
            .eq("organization_id", this.organization.organizationId)
            .order("version", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      content.assetId
        ? this.client
            .from("assets")
            .select("id, filename, mime_type, width, height, checksum, bucket_id, storage_path, created_at")
            .eq("id", content.assetId)
            .eq("organization_id", this.organization.organizationId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (targetsResult.error || draftsResult.error || auditResult.error || resultsResult.error || finalCopyResult.error || assetResult.error) {
      throw new Error("Unable to read the content record.");
    }

    let asset: ContentAsset | undefined;
    if (assetResult.data) {
      const parsedAsset = assetRowSchema.safeParse(assetResult.data);
      if (!parsedAsset.success) throw new Error("Supabase returned an invalid content asset.");
      const signed = await this.client.storage
        .from(parsedAsset.data.bucket_id)
        .createSignedUrl(parsedAsset.data.storage_path, 10 * 60);
      if (signed.error || !signed.data?.signedUrl) {
        throw new Error("Unable to create a signed content asset URL.");
      }
      asset = toContentAsset(parsedAsset.data, signed.data.signedUrl);
    }

    return {
      content,
      ...(asset ? { asset } : {}),
      targets: toPublicationTargets(targetsResult.data),
      drafts: toCopyDrafts(draftsResult.data),
      auditEvents: toAuditEvents(auditResult.data),
      publicationResults: toPublicationResults(resultsResult.data),
      ...(finalCopyResult.data ? { finalCopy: toFinalCopy(finalCopyResult.data) } : {}),
    };
  }

  async submitFinalCopyForReview(
    contentItemId: string,
    input: FinalCopySubmission,
  ): Promise<FinalCopy> {
    const content = await this.getContentItem(contentItemId);
    if (!content || !content.campaign) throw new CopyResultConflictError();
    const validation = validateFinalCopy(input, content);
    if (!validation.ok) throw new CopyResultConflictError();

    const hashtags = (input.hashtags ?? []).map((tag) => tag.trim());
    const checksum = createHash("sha256")
      .update(
        JSON.stringify({
          contentItemId,
          selectedCopyDraftId: input.selectedCopyDraftId ?? null,
          headline: input.headline.trim(),
          body: input.body.trim(),
          cta: input.cta.trim(),
          hashtags,
        }),
      )
      .digest("hex");
    const { data, error } = await this.client.rpc("submit_final_copy_for_review", {
      p_owner_id: this.organization.userId,
      p_organization_id: this.organization.organizationId,
      p_content_item_id: contentItemId,
      p_selected_copy_draft_id: input.selectedCopyDraftId ?? null,
      p_headline: input.headline.trim(),
      p_body: input.body.trim(),
      p_cta: input.cta.trim(),
      p_checksum: checksum,
      p_hashtags: hashtags,
    });
    if (error) {
      if (
        error.message === "FINAL_COPY_SUBMISSION_INVALID_STATE" ||
        error.message === "FINAL_COPY_CONTENT_NOT_FOUND" ||
        error.message === "FINAL_COPY_CAMPAIGN_REQUIRED" ||
        error.message === "FINAL_COPY_DRAFT_MISMATCH"
      ) {
        throw new CopyResultConflictError();
      }
      throw new Error("Unable to submit final copy for review.");
    }
    return toFinalCopy(data);
  }

  async applyPublicationDiagnosisForContentItem(contentItemId: string, finalCopy: FinalCopy): Promise<void> {
    const { data: brandProfile, error: brandProfileError } = await this.client
      .from("organization_brand_profiles")
      .select("aias_profile")
      .eq("organization_id", this.organization.organizationId)
      .maybeSingle();
    if (brandProfileError) throw new Error("Unable to read the organization's AIAS profile.");
    const organizationProfile = aiasOrganizationProfileSchema.parse(brandProfile?.aias_profile ?? {});
    const signal = [finalCopy.headline, finalCopy.body, finalCopy.cta, ...finalCopy.hashtags].join(" ");

    const { data: targets, error: targetsError } = await this.client
      .from("publication_targets")
      .select("id, platform")
      .eq("content_item_id", contentItemId)
      .eq("organization_id", this.organization.organizationId);
    if (targetsError) throw new Error("Unable to read publication targets for diagnosis.");

    for (const target of targets ?? []) {
      const diagnosis = diagnosePublication({
        profile: organizationProfile,
        signal,
        channel: target.platform.toLowerCase() as AiasPlatform,
      });
      const { error: diagnosisError } = await this.client.rpc("apply_publication_diagnosis", {
        p_organization_id: this.organization.organizationId,
        p_content_item_id: contentItemId,
        p_publication_target_id: target.id,
        p_quality_level: diagnosis.qualityLevel,
        p_findings: diagnosis.findings,
        p_idempotency_key: createId(),
      });
      if (diagnosisError) throw new Error(`Unable to apply publication diagnosis for target ${target.id}.`);
    }
  }

  async approvePublicationTarget(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<PublicationTarget & { status: "APPROVED" }> {
    const { data, error } = await this.client.rpc("approve_publication_target", {
      p_owner_id: this.organization.userId,
      p_organization_id: this.organization.organizationId,
      p_content_item_id: contentItemId,
      p_publication_target_id: publicationTargetId,
    });

    if (error) {
      if (
        error.message === "TARGET_NOT_FOUND" ||
        error.message === "TARGET_NOT_REVIEWABLE" ||
        error.message === "CONTENT_NOT_REVIEWABLE"
      ) {
        throw new PublishTargetConflictError();
      }
      throw new Error("Unable to approve the publication target.");
    }

    const target = toPublicationTargets([data])[0];
    if (!target || target.status !== "APPROVED") {
      throw new Error("Supabase returned an invalid approved target.");
    }
    return { ...target, status: "APPROVED" };
  }

  async retryPublicationTarget(
    contentItemId: string,
    publicationTargetId: string,
  ): Promise<PublicationTarget & { status: "APPROVED" }> {
    const { data, error } = await this.client.rpc("retry_publish_target", {
      p_organization_id: this.organization.organizationId,
      p_actor_id: this.organization.userId,
      p_content_item_id: contentItemId,
      p_publication_target_id: publicationTargetId,
    });

    if (error) {
      if (
        error.message === "RETRY_TARGET_NOT_FOUND" ||
        error.message === "RETRY_TARGET_NOT_IN_ERROR" ||
        error.message === "ORGANIZATION_ACTOR_FORBIDDEN"
      ) {
        throw new PublishTargetConflictError();
      }
      throw new Error("Unable to retry the publication target.");
    }

    const target = toPublicationTargets([data])[0];
    if (!target || target.contentItemId !== contentItemId || target.status !== "APPROVED") {
      throw new PublishTargetConflictError();
    }
    return { ...target, status: "APPROVED" };
  }

  async recordManualPublicationDelivery(
    input: ManualPublicationDeliveryInput,
  ): Promise<PublicationTarget & { status: "PUBLISHED" }> {
    const { data, error } = await this.client.rpc(
      "record_manual_publication_delivery",
      {
        p_organization_id: this.organization.organizationId,
        p_owner_id: this.organization.userId,
        p_content_item_id: input.contentItemId,
        p_publication_target_id: input.publicationTargetId,
        p_remote_url: input.remoteUrl,
        p_published_at: input.publishedAt,
        p_note: input.note ?? null,
        p_idempotency_key: input.idempotencyKey,
      },
    );

    if (error) {
      if (
        error.message === "MANUAL_DELIVERY_CONTENT_NOT_APPROVED" ||
        error.message === "MANUAL_DELIVERY_TARGET_NOT_FOUND" ||
        error.message === "MANUAL_DELIVERY_TARGET_NOT_APPROVED" ||
        error.message === "MANUAL_DELIVERY_IDEMPOTENCY_KEY_REUSED" ||
        error.message === "MANUAL_DELIVERY_ALREADY_RECORDED"
      ) {
        throw new PublishTargetConflictError();
      }
      throw new Error("Unable to record the manual publication delivery.");
    }

    const target = toPublicationTargets([data])[0];
    if (!target || target.status !== "PUBLISHED") {
      throw new Error("Supabase returned an invalid manual publication delivery.");
    }
    return { ...target, status: "PUBLISHED" };
  }

  async recordPublicationResult(input: PublicationResultInput): Promise<PublicationResult> {
    const { data, error } = await this.client.rpc("record_publication_result", {
      p_organization_id: this.organization.organizationId,
      p_owner_id: this.organization.userId,
      p_content_item_id: input.contentItemId,
      p_publication_target_id: input.publicationTargetId,
      p_observed_at: input.observedAt,
      p_reach: input.reach,
      p_impressions: input.impressions,
      p_conversations: input.conversations,
      p_qualified_leads: input.qualifiedLeads,
      p_appointments: input.appointments,
      p_spend_mxn: input.spendMxn,
      p_revenue_mxn: input.revenueMxn ?? null,
      p_note: input.note ?? null,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      if (error.message.startsWith("PUBLICATION_RESULT_")) throw new PublishTargetConflictError();
      throw new Error("Unable to record the publication result.");
    }
    const result = toPublicationResults([data])[0];
    if (!result) throw new Error("Supabase returned an invalid publication result.");
    return result;
  }

  async getContentItem(contentItemId: string): Promise<ContentItem | null> {
    const { data, error } = await this.client
      .from("content_items")
        .select("id, asset_id, business_line, service, niche, content_type, objective, format, cta, human_description, allowed_facts, campaign_name, offer, funnel_stage, destination, destination_value, campaign_code, selected_final_copy_id, state, created_at")
      .eq("id", contentItemId)
      .eq("organization_id", this.organization.organizationId)
      .maybeSingle();

    if (error) throw new Error("Unable to read the content item.");
    return data ? toContentItem(data) : null;
  }

  async prepareCopyRequest(
    input: CopyRequestPreparationInput,
  ): Promise<CopyRequestPreparation> {
    if (!(await this.getContentItem(input.contentItemId))) {
      throw new CopyResultConflictError();
    }
    const { data, error } = await this.client.rpc("prepare_copy_request", {
      p_content_item_id: input.contentItemId,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) {
      if (
        error.message === "COPY_REQUEST_CONTENT_NOT_FOUND" ||
        error.message === "COPY_REQUEST_INVALID_STATE" ||
        error.message === "COPY_REQUEST_IDEMPOTENCY_KEY_REUSED"
      ) {
        throw new CopyResultConflictError();
      }
      throw new Error("Unable to prepare the copy request.");
    }

    const result = z
      .object({
        created: z.boolean(),
        ownerId: z.string().uuid(),
        contentItem: z.unknown(),
      })
      .safeParse(data);
    if (!result.success) {
      throw new Error("Supabase returned an invalid copy request preparation.");
    }

    return {
      created: result.data.created,
      status: "READY",
      ownerId: result.data.ownerId,
      contentItem: toContentItem(result.data.contentItem),
    };
  }

  async enqueueCopyJob(input: {
    contentItemId: string;
    idempotencyKey: string;
  }): Promise<CopyJobEnqueue> {
    const { data, error } = await this.client.rpc("enqueue_copy_automation_job", {
      p_organization_id: this.organization.organizationId,
      p_actor_id: this.organization.userId,
      p_content_item_id: input.contentItemId,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) {
      if (
        error.message === "COPY_JOB_CONTENT_NOT_FOUND" ||
        error.message === "COPY_JOB_ASSET_REQUIRED" ||
        error.message === "COPY_JOB_INVALID_STATE" ||
        error.message === "COPY_JOB_IDEMPOTENCY_KEY_REUSED"
      ) {
        throw new CopyResultConflictError();
      }
      throw new Error("Unable to enqueue the copy job.");
    }
    const result = copyJobEnqueueSchema.safeParse(data);
    if (!result.success) throw new Error("Supabase returned an invalid copy job enqueue.");
    return result.data;
  }

  async preparePublishRequest(
    input: PublishRequestPreparationInput,
  ): Promise<PublishRequestPreparation> {
    const { data, error } = await this.client
      .from("publication_targets")
      .select("id, content_item_id, platform, status, remote_post_id, remote_url, published_at, last_error, updated_at")
      .eq("id", input.publicationTargetId)
      .eq("content_item_id", input.contentItemId)
      .eq("organization_id", this.organization.organizationId)
      .maybeSingle();

    if (error || !data) throw new PublishTargetConflictError();
    const target = toPublicationTargets([data])[0];
    if (!target || target.status !== "APPROVED") {
      throw new PublishTargetConflictError();
    }

    const updatedAt = publicationTargetRowSchema.parse(data).updated_at;
    return {
      created: true,
      status: "READY",
      ownerId: this.organization.userId,
      approvedAt: updatedAt ?? new Date().toISOString(),
      target: { ...target, status: "APPROVED" },
    };
  }
}

/** Server-only adapter. Its service-role client is never imported by the browser. */
export function createSupabaseRepository(
  client: SupabaseClient,
  organization: OrganizationContext,
): ContentRepository &
  Pick<CopyResultRepository, "ingestCopyResult"> &
  Pick<PublishResultRepository, "ingestPublishResult"> &
  CopyJobWorkerRepository {
  return new SupabaseContentRepository(client, organization);
}

/** Service-role callback adapter; it never accepts owner identity from n8n. */
export function createSupabaseCallbackRepository(
  client: SupabaseClient,
): Pick<CopyResultRepository, "ingestCopyResult"> &
  Pick<PublishResultRepository, "ingestPublishResult"> &
  CopyJobWorkerRepository {
  return new SupabaseCopyResultRepository(client);
}
