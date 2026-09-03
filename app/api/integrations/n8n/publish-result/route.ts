import { z } from "zod";

import {
  PUBLICATION_PLATFORMS,
  PublishTargetConflictError,
  type PublishResultCallback,
  type PublishResultRepository,
} from "@/lib/content/repository";
import { createN8nCallbackRepository } from "@/lib/content/repository-factory";
import { verifyN8nSignature } from "@/lib/integrations/n8n-signature";

const callbackIdentitySchema = z
  .object({
    contentItemId: z.string().uuid(),
    publicationTargetId: z.string().uuid(),
    platform: z.enum(PUBLICATION_PLATFORMS),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

const successCallbackSchema = callbackIdentitySchema.extend({
  remotePostId: z.string().trim().min(1).max(500),
  remoteUrl: z
    .url()
    .max(2_000)
    .refine((value) => new URL(value).protocol === "https:"),
  publishedAt: z.iso.datetime({ offset: true }),
});

const errorCallbackSchema = callbackIdentitySchema.extend({
  error: z
    .object({
      code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
      message: z.string().trim().min(1).max(500),
    })
    .strict(),
});

export const publishResultSchema = z.union([
  successCallbackSchema,
  errorCallbackSchema,
]);

type PublishResultHandlerDependencies = {
  getRepository?: () => Promise<
    Pick<PublishResultRepository, "ingestPublishResult">
  >;
  getSecret?: () => string | undefined;
  nowMs?: () => number;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function sanitizePublishErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(access_token=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(
      /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
      "[REDACTED_JWT]",
    )
    .slice(0, 500);
}

export function createPublishResultHandler(
  dependencies: PublishResultHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getRepository =
    dependencies.getRepository ?? createN8nCallbackRepository;
  const getSecret =
    dependencies.getSecret ??
    (() => process.env.SNAPGAD_N8N_SHARED_SECRET);
  const nowMs = dependencies.nowMs ?? Date.now;

  return async function handlePublishResult(request: Request): Promise<Response> {
    const timestamp = request.headers.get("x-snapgad-timestamp");
    const signature = request.headers.get("x-snapgad-signature");
    if (!timestamp || !signature) return jsonError("INVALID_SIGNATURE", 401);

    const secret = getSecret();
    if (!secret) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);

    let rawPayload: string;
    try {
      rawPayload = await request.text();
    } catch {
      return jsonError("INVALID_CALLBACK", 400);
    }

    if (
      !verifyN8nSignature(rawPayload, timestamp, signature, secret, {
        nowMs: nowMs(),
      })
    ) {
      return jsonError("INVALID_SIGNATURE", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return jsonError("INVALID_CALLBACK", 400);
    }

    const parsed = publishResultSchema.safeParse(payload);
    if (!parsed.success) return jsonError("INVALID_CALLBACK", 400);

    const callback: PublishResultCallback =
      "error" in parsed.data
        ? {
            ...parsed.data,
            error: {
              ...parsed.data.error,
              message: sanitizePublishErrorMessage(parsed.data.error.message),
            },
          }
        : parsed.data;

    try {
      const repository = await getRepository();
      const result = await repository.ingestPublishResult(callback);
      return Response.json(result, { status: result.created ? 202 : 200 });
    } catch (error) {
      if (error instanceof PublishTargetConflictError) {
        return jsonError("TARGET_NOT_APPROVED", 409);
      }
      return jsonError("CALLBACK_PERSISTENCE_FAILED", 500);
    }
  };
}

export const POST = createPublishResultHandler();
