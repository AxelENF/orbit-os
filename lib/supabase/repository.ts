import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { contentBriefSchema } from "@/lib/content/contracts";
import {
  CopyResultConflictError,
  PublishTargetConflictError,
  PUBLICATION_PLATFORMS,
  PUBLICATION_TARGET_STATUSES,
  type ContentItem,
  type ContentRepository,
  type CopyResultCallback,
  type CopyResultIngestion,
  type CopyResultRepository,
  type PublicationTarget,
  type PublishRequestPreparation,
  type PublishRequestPreparationInput,
  type PublishResultCallback,
  type PublishResultIngestion,
  type PublishResultRepository,
} from "@/lib/content/repository";
import { contentStateSchema } from "@/lib/content/state-machine";

const contentItemRowSchema = z.object({
  id: z.string().uuid(),
  business_line: z.string(),
  service: z.string(),
  niche: z.string(),
  content_type: z.string(),
  objective: z.string(),
  format: z.string(),
  cta: z.string(),
  human_description: z.string(),
  allowed_facts: z.array(z.string()),
  state: contentStateSchema,
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

  return {
    ...brief.data,
    id: parsedRow.data.id,
    state: parsedRow.data.state,
    createdAt: parsedRow.data.created_at,
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

class SupabaseCopyResultRepository
  implements
    Pick<CopyResultRepository, "ingestCopyResult">,
    Pick<PublishResultRepository, "ingestPublishResult">
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
        error.message === "COPY_RESULT_CONTENT_NOT_FOUND"
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
        error.message === "PUBLISH_IDEMPOTENCY_KEY_REUSED"
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
}

class SupabaseContentRepository
  extends SupabaseCopyResultRepository
  implements ContentRepository
{
  constructor(
    client: SupabaseClient,
    private readonly ownerId: string,
  ) {
    super(client);
  }

  async createContentItem(input: unknown): Promise<ContentItem> {
    const brief = contentBriefSchema.parse(input);
    const { data, error } = await this.client.rpc(
      "create_content_item_with_targets",
      {
        p_owner_id: this.ownerId,
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

  async listPublicationTargets(
    contentItemId: string,
  ): Promise<PublicationTarget[]> {
    const { data, error } = await this.client
      .from("publication_targets")
      .select("id, content_item_id, platform, status, remote_post_id, remote_url, published_at, last_error, updated_at")
      .eq("content_item_id", contentItemId)
      .eq("owner_id", this.ownerId)
      .order("platform");

    if (error) {
      throw new Error("Unable to list publication targets.");
    }

    return toPublicationTargets(data);
  }

  async preparePublishRequest(
    input: PublishRequestPreparationInput,
  ): Promise<PublishRequestPreparation> {
    const { data, error } = await this.client
      .from("publication_targets")
      .select("id, content_item_id, platform, status, remote_post_id, remote_url, published_at, last_error, updated_at")
      .eq("id", input.publicationTargetId)
      .eq("content_item_id", input.contentItemId)
      .eq("owner_id", this.ownerId)
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
      ownerId: this.ownerId,
      approvedAt: updatedAt ?? new Date().toISOString(),
      target: { ...target, status: "APPROVED" },
    };
  }
}

/** Server-only adapter. Its service-role client is never imported by the browser. */
export function createSupabaseRepository(
  client: SupabaseClient,
  ownerId: string,
): ContentRepository &
  Pick<CopyResultRepository, "ingestCopyResult"> &
  Pick<PublishResultRepository, "ingestPublishResult"> {
  return new SupabaseContentRepository(client, ownerId);
}

/** Service-role callback adapter; it never accepts owner identity from n8n. */
export function createSupabaseCallbackRepository(
  client: SupabaseClient,
): Pick<CopyResultRepository, "ingestCopyResult"> &
  Pick<PublishResultRepository, "ingestPublishResult"> {
  return new SupabaseCopyResultRepository(client);
}
