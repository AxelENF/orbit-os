import { z } from "zod";

import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";
import { CopyResultConflictError, type ContentRepository } from "@/lib/content/repository";

const contentIdSchema = z.string().uuid();
const requestSchema = z.object({ idempotencyKey: z.string().uuid() });

type CopyRetryHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "enqueueCopyJob">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * Requeues an existing asset through the portal-owned copy worker. The caller
 * supplies a stable idempotency key, so retrying an uncertain HTTP response
 * cannot create a second job for the same explicit action.
 */
export function createCopyRetryHandler(
  dependencies: CopyRetryHandlerDependencies = {},
): (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleCopyRetry(request, context): Promise<Response> {
    const params = await context.params;
    const contentId = contentIdSchema.safeParse(params.id);
    if (!contentId.success) return jsonError("INVALID_CONTENT_ID", 400);

    const payload = requestSchema.safeParse(await request.json().catch(() => null));
    if (!payload.success) return jsonError("INVALID_COPY_RETRY_REQUEST", 400);

    try {
      const job = await (await getRepository()).enqueueCopyJob({
        contentItemId: contentId.data,
        idempotencyKey: payload.data.idempotencyKey,
      });
      return Response.json({ job }, { status: 202 });
    } catch (error) {
      if (error instanceof CopyResultConflictError) {
        return jsonError("COPY_RETRY_CONFLICT", 409);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      return jsonError("COPY_RETRY_FAILED", 500);
    }
  };
}

export const POST = createCopyRetryHandler();
