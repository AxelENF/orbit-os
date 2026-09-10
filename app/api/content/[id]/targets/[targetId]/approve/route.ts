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

const targetIdSchema = z.string().uuid();

type ApproveTargetHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "approvePublicationTarget">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createApproveTargetHandler(
  dependencies: ApproveTargetHandlerDependencies = {},
): (request: Request, context: { params: Promise<{ id: string; targetId: string }> }) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleApproveTarget(
    _request: Request,
    context,
  ): Promise<Response> {
    const params = await context.params;
    const parsedIds = z
      .object({ contentItemId: z.string().uuid(), publicationTargetId: targetIdSchema })
      .safeParse({ contentItemId: params.id, publicationTargetId: params.targetId });
    if (!parsedIds.success) return jsonError("INVALID_TARGET_ID", 400);

    try {
      const target = await (await getRepository()).approvePublicationTarget(
        parsedIds.data.contentItemId,
        parsedIds.data.publicationTargetId,
      );
      return Response.json({ target });
    } catch (error) {
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      if (error instanceof PublishTargetConflictError) {
        return jsonError("TARGET_NOT_REVIEWABLE", 409);
      }
      return jsonError("TARGET_APPROVAL_FAILED", 500);
    }
  };
}

export const POST = createApproveTargetHandler();
