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

const nonnegativeInteger = z.number().int().nonnegative();
const inputSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  reach: nonnegativeInteger,
  impressions: nonnegativeInteger,
  conversations: nonnegativeInteger,
  qualifiedLeads: nonnegativeInteger,
  appointments: nonnegativeInteger,
  spendMxn: z.number().nonnegative(),
  revenueMxn: z.number().nonnegative().optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
  idempotencyKey: z.string().uuid(),
});

type PublicationResultHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "recordPublicationResult">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createPublicationResultHandler(
  dependencies: PublicationResultHandlerDependencies = {},
): (request: Request, context: { params: Promise<{ id: string; targetId: string }> }) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handlePublicationResult(request, context) {
    const routeParams = await context.params;
    const parsedParams = paramsSchema.safeParse({
      contentItemId: routeParams.id,
      publicationTargetId: routeParams.targetId,
    });
    if (!parsedParams.success) return jsonError("INVALID_TARGET_ID", 400);
    const parsedInput = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsedInput.success) return jsonError("INVALID_PUBLICATION_RESULT", 400);

    try {
      const result = await (await getRepository()).recordPublicationResult({
        ...parsedParams.data,
        ...parsedInput.data,
      });
      return Response.json({ result }, { status: 201 });
    } catch (error) {
      if (error instanceof ContentConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      if (error instanceof ContentAuthenticationError) return jsonError("AUTHENTICATION_REQUIRED", 401);
      if (error instanceof PublishTargetConflictError) return jsonError("TARGET_NOT_PUBLISHED", 409);
      return jsonError("PUBLICATION_RESULT_FAILED", 500);
    }
  };
}

export const POST = createPublicationResultHandler();
