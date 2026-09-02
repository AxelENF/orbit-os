import { z } from "zod";

import {
  CopyResultConflictError,
  type CopyResultCallback,
  type CopyResultRepository,
} from "@/lib/content/repository";
import { createN8nCallbackRepository } from "@/lib/content/repository-factory";
import { verifyN8nSignature } from "@/lib/integrations/n8n-signature";

const requiredText = z.string().trim().min(1).max(10_000);
const shortText = z.string().trim().min(1).max(500);

export const copyResultSchema = z
  .object({
    contentItemId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    visualAnalysis: z
      .object({
        scene: requiredText,
        visibleText: z.array(shortText).max(100),
        proof: z.array(shortText).max(100),
        risks: z.array(shortText).max(100),
      })
      .strict(),
    drafts: z
      .array(
        z
          .object({
            headline: shortText,
            body: requiredText,
            cta: shortText,
          })
          .strict(),
      )
      .length(2),
    warnings: z.array(shortText).max(100),
    provider: shortText.optional(),
    model: shortText.optional(),
  })
  .strict();

type CopyResultHandlerDependencies = {
  getRepository?: () => Promise<Pick<CopyResultRepository, "ingestCopyResult">>;
  getSecret?: () => string | undefined;
  nowMs?: () => number;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createCopyResultHandler(
  dependencies: CopyResultHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const getRepository =
    dependencies.getRepository ?? createN8nCallbackRepository;
  const getSecret =
    dependencies.getSecret ??
    (() => process.env.SNAPGAD_N8N_SHARED_SECRET);
  const nowMs = dependencies.nowMs ?? Date.now;

  return async function handleCopyResult(request: Request): Promise<Response> {
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

    const parsed = copyResultSchema.safeParse(payload);
    if (!parsed.success) return jsonError("INVALID_CALLBACK", 400);

    try {
      const repository = await getRepository();
      const result = await repository.ingestCopyResult(
        parsed.data as CopyResultCallback,
      );
      return Response.json(result, { status: result.created ? 202 : 200 });
    } catch (error) {
      if (error instanceof CopyResultConflictError) {
        return jsonError("INVALID_CONTENT_STATE", 409);
      }
      return jsonError("CALLBACK_PERSISTENCE_FAILED", 500);
    }
  };
}

export const POST = createCopyResultHandler();
