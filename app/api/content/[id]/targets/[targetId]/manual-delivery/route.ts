import { z } from "zod";

import {
  PublishTargetConflictError,
  type ContentRepository,
} from "@/lib/content/repository";
import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";

const paramsSchema = z.object({
  contentItemId: z.string().uuid(),
  publicationTargetId: z.string().uuid(),
});

const inputSchema = z.object({
  remoteUrl: z.string().url().max(2_048),
  publishedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().min(1).max(1_000).optional(),
  idempotencyKey: z.string().uuid(),
});

type ManualDeliveryHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "recordManualPublicationDelivery">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createManualDeliveryHandler(
  dependencies: ManualDeliveryHandlerDependencies = {},
): (request: Request, context: { params: Promise<{ id: string; targetId: string }> }) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleManualDelivery(request, context) {
    const routeParams = await context.params;
    const parsedParams = paramsSchema.safeParse({
      contentItemId: routeParams.id,
      publicationTargetId: routeParams.targetId,
    });
    if (!parsedParams.success) return jsonError("INVALID_TARGET_ID", 400);

    const parsedInput = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsedInput.success) return jsonError("INVALID_MANUAL_DELIVERY", 400);

    try {
      const target = await (await getRepository()).recordManualPublicationDelivery({
        ...parsedParams.data,
        ...parsedInput.data,
      });
      return Response.json({ target });
    } catch (error) {
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      if (error instanceof PublishTargetConflictError) {
        return jsonError("TARGET_NOT_DELIVERABLE", 409);
      }
      return jsonError("MANUAL_DELIVERY_FAILED", 500);
    }
  };
}

export const POST = createManualDeliveryHandler();
