import { z } from "zod";

import {
  CopyResultConflictError,
  type ContentRepository,
} from "@/lib/content/repository";
import {
  ContentAuthenticationError,
  ContentConfigurationError,
  createContentRepository,
} from "@/lib/content/repository-factory";
import {
  N8nPublishConfigurationError,
  requestN8nCopy,
} from "@/lib/integrations/n8n-client";

const MAX_REQUEST_BYTES = 256_000;

type CopyRequestHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "enqueueCopyJob">>;
  environment?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  createId?: () => string;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createCopyRequestHandler(
  dependencies: CopyRequestHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getRepository =
    dependencies.getRepository ?? createContentRepository;

  return async function handleCopyRequest(request: Request): Promise<Response> {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", 413);
    }

    let rawPayload: string;
    try {
      rawPayload = await request.text();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    if (new TextEncoder().encode(rawPayload).byteLength > MAX_REQUEST_BYTES) {
      return jsonError("REQUEST_TOO_LARGE", 413);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }

    try {
      const result = await requestN8nCopy(payload, {
        repository: await getRepository(),
        environment: dependencies.environment,
        fetchFn: dependencies.fetchFn,
        nowMs: dependencies.nowMs,
        createId: dependencies.createId,
      });
      return Response.json(result, { status: result.created ? 202 : 200 });
    } catch (error) {
      if (error instanceof z.ZodError) return jsonError("INVALID_REQUEST", 400);
      if (error instanceof ContentAuthenticationError) {
        return jsonError("AUTHENTICATION_REQUIRED", 401);
      }
      if (error instanceof ContentConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof CopyResultConflictError) {
        return jsonError("COPY_REQUEST_CONFLICT", 409);
      }
      if (error instanceof N8nPublishConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      return jsonError("COPY_REQUEST_FAILED", 500);
    }
  };
}

export const POST = createCopyRequestHandler();
