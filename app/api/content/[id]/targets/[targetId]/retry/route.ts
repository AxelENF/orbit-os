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

type RetryPublicationTargetHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "retryPublicationTarget">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createRetryPublicationTargetHandler(
  dependencies: RetryPublicationTargetHandlerDependencies = {},
): (request: Request, context: { params: Promise<{ id: string; targetId: string }> }) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleRetryPublicationTarget(request, context) {
    void request;
    const routeParams = await context.params;
    const parsedParams = paramsSchema.safeParse({
      contentItemId: routeParams.id,
      publicationTargetId: routeParams.targetId,
    });
    if (!parsedParams.success) return jsonError("INVALID_TARGET_ID", 400);

    try {
      const target = await (await getRepository()).retryPublicationTarget(
        parsedParams.data.contentItemId,
        parsedParams.data.publicationTargetId,
      );
      return Response.json({ target });
    } catch (error) {
      if (error instanceof ContentConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      if (error instanceof ContentAuthenticationError) return jsonError("AUTHENTICATION_REQUIRED", 401);
      if (error instanceof PublishTargetConflictError) return jsonError("TARGET_NOT_RETRYABLE", 409);
      return jsonError("PUBLICATION_TARGET_RETRY_FAILED", 500);
    }
  };
}

export const POST = createRetryPublicationTargetHandler();
