import { z } from "zod";

import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";
import type { ContentRepository } from "@/lib/content/repository";

const contentIdSchema = z.string().uuid();

type ContentDetailHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "getContentRecord">>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createContentDetailHandler(
  dependencies: ContentDetailHandlerDependencies = {},
): (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> {
  const getRepository = dependencies.getRepository ?? createContentRepository;

  return async function handleContentDetail(
    _request: Request,
    context,
  ): Promise<Response> {
    const params = await context.params;
    const parsedId = contentIdSchema.safeParse(params.id);
    if (!parsedId.success) return jsonError("INVALID_CONTENT_ID", 400);

    try {
      const record = await (await getRepository()).getContentRecord(parsedId.data);
      if (!record) return jsonError("CONTENT_NOT_FOUND", 404);
      return Response.json(record);
    } catch (error) {
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      return jsonError("CONTENT_DETAIL_FAILED", 500);
    }
  };
}

export const GET = createContentDetailHandler();
