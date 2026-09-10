import { z } from "zod";

import { createCampaignPreflight } from "@/lib/content/preflight";
import type { ContentRepository } from "@/lib/content/repository";
import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";

const contentIdSchema = z.string().uuid();

type CampaignPreflightHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "getContentRecord">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createCampaignPreflightHandler(
  dependencies: CampaignPreflightHandlerDependencies = {},
): (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleCampaignPreflight(_request, context): Promise<Response> {
    const params = await context.params;
    const contentItemId = contentIdSchema.safeParse(params.id);
    if (!contentItemId.success) return jsonError("INVALID_CONTENT_ID", 400);
    try {
      const record = await (await getRepository()).getContentRecord(contentItemId.data);
      if (!record) return jsonError("CONTENT_NOT_FOUND", 404);
      const campaign = record.content.campaign;
      if (!campaign) return jsonError("CAMPAIGN_CONTEXT_REQUIRED", 409);
      const finalCopy = record.finalCopy;
      const result = createCampaignPreflight({
        campaign: {
          businessLine: record.content.businessLine,
          service: record.content.service,
          niche: record.content.niche,
          contentType: record.content.contentType,
          objective: record.content.objective,
          format: record.content.format,
          cta: record.content.cta,
          humanDescription: record.content.humanDescription,
          allowedFacts: record.content.allowedFacts,
          campaignName: campaign.campaignName,
          offer: campaign.offer,
          funnelStage: campaign.funnelStage,
          destination: campaign.destination,
          destinationValue: campaign.destinationValue,
        },
        asset: {
          mimeType: record.asset?.mimeType ?? "",
          width: record.asset?.width ?? 0,
          height: record.asset?.height ?? 0,
        },
        finalCopy: finalCopy
          ? { headline: finalCopy.headline, body: finalCopy.body, cta: finalCopy.cta }
          : { headline: "", body: "", cta: "" },
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof ContentConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      if (error instanceof ContentAuthenticationError) return jsonError("AUTHENTICATION_REQUIRED", 401);
      return jsonError("CAMPAIGN_PREFLIGHT_FAILED", 500);
    }
  };
}

export const GET = createCampaignPreflightHandler();
