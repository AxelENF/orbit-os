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
import {
  N8nPublishConfigurationError,
  N8nPublishDeliveryError,
  requestN8nPublish,
} from "@/lib/integrations/n8n-client";

const MAX_REQUEST_BYTES = 256_000;

type PublishRequestHandlerDependencies = {
  getRepository?: () => Promise<Pick<ContentRepository, "preparePublishRequest">>;
  environment?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  createId?: () => string;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createPublishRequestHandler(
  dependencies: PublishRequestHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getRepository =
    dependencies.getRepository ?? createContentRepository;

  return async function handlePublishRequest(request: Request): Promise<Response> {
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
      const result = await requestN8nPublish(payload, {
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
      if (error instanceof PublishTargetConflictError) {
        return jsonError("TARGET_NOT_APPROVED", 409);
      }
      if (error instanceof N8nPublishConfigurationError) {
        return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      }
      if (error instanceof N8nPublishDeliveryError) {
        return jsonError("N8N_DELIVERY_FAILED", 502);
      }
      return jsonError("PUBLISH_REQUEST_FAILED", 500);
    }
  };
}

export const POST = createPublishRequestHandler();
