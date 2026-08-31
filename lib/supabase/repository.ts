import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ContentBrief } from "@/lib/content/contracts";
import {
  PUBLICATION_PLATFORMS,
  type ContentItem,
  type ContentRepository,
  type PublicationTarget,
} from "@/lib/content/repository";
import { parseContentBrief } from "@/lib/content/validation";

type ContentItemRow = {
  id: string;
  business_line: ContentBrief["businessLine"];
  service: ContentBrief["service"];
  niche: ContentBrief["niche"];
  content_type: ContentBrief["contentType"];
  objective: ContentBrief["objective"];
  format: ContentBrief["format"];
  cta: string;
  human_description: string;
  allowed_facts: string[];
  state: "DRAFT";
  created_at: string;
};

type PublicationTargetRow = {
  id: string;
  content_item_id: string;
  platform: PublicationTarget["platform"];
  status: PublicationTarget["status"];
};

function toContentItem(row: ContentItemRow): ContentItem {
  return {
    id: row.id,
    businessLine: row.business_line,
    service: row.service,
    niche: row.niche,
    contentType: row.content_type,
    objective: row.objective,
    format: row.format,
    cta: row.cta,
    humanDescription: row.human_description,
    allowedFacts: row.allowed_facts,
    state: row.state,
    createdAt: row.created_at,
  };
}

function toPublicationTarget(row: PublicationTargetRow): PublicationTarget {
  return {
    id: row.id,
    contentItemId: row.content_item_id,
    platform: row.platform,
    status: row.status,
  };
}

class SupabaseContentRepository implements ContentRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly ownerId: string,
  ) {}

  async createContentItem(input: unknown): Promise<ContentItem> {
    const brief = parseContentBrief(input);
    const { data, error } = await this.client
      .from("content_items")
      .insert({
        owner_id: this.ownerId,
        business_line: brief.businessLine,
        service: brief.service,
        niche: brief.niche,
        content_type: brief.contentType,
        objective: brief.objective,
        format: brief.format,
        cta: brief.cta,
        human_description: brief.humanDescription,
        allowed_facts: brief.allowedFacts,
        state: "DRAFT",
      })
      .select()
      .single();

    if (error) {
      throw new Error("Unable to create the content item.");
    }

    const item = toContentItem(data as ContentItemRow);
    const { error: targetsError } = await this.client
      .from("publication_targets")
      .insert(
        PUBLICATION_PLATFORMS.map((platform) => ({
          owner_id: this.ownerId,
          content_item_id: item.id,
          platform,
          status: "PENDING_REVIEW",
        })),
      );

    if (targetsError) {
      throw new Error("Unable to create publication targets.");
    }

    return item;
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

    return (data as PublicationTargetRow[]).map(toPublicationTarget);
  }
}

/** Server-only adapter. Its service-role client is never imported by the browser. */
export function createSupabaseRepository(
  client: SupabaseClient,
  ownerId: string,
): ContentRepository {
  return new SupabaseContentRepository(client, ownerId);
}
