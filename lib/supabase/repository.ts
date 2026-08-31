import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { contentBriefSchema } from "@/lib/content/contracts";
import {
  PUBLICATION_PLATFORMS,
  PUBLICATION_TARGET_STATUSES,
  type ContentItem,
  type ContentRepository,
  type PublicationTarget,
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
  }));
}

class SupabaseContentRepository implements ContentRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly ownerId: string,
  ) {}

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
      .select("id, content_item_id, platform, status")
      .eq("content_item_id", contentItemId)
      .eq("owner_id", this.ownerId)
      .order("platform");

    if (error) {
      throw new Error("Unable to list publication targets.");
    }

    return toPublicationTargets(data);
  }
}

/** Server-only adapter. Its service-role client is never imported by the browser. */
export function createSupabaseRepository(
  client: SupabaseClient,
  ownerId: string,
): ContentRepository {
  return new SupabaseContentRepository(client, ownerId);
}
