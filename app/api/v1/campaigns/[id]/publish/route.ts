import { z } from "zod";

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";
import {
  N8nPublishConfigurationError,
  N8nPublishDeliveryError,
  requestN8nPublish,
} from "@/lib/integrations/n8n-client";
import { PublishTargetConflictError } from "@/lib/content/repository";

const bodySchema = z.object({
  publicationTargetId: z.string().uuid(),
  idempotencyKey: z.string().uuid().optional(),
});
const contentIdSchema = z.string().uuid();

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const params = await context.params;
    const contentItemId = contentIdSchema.parse(params.id);

    const { repository } = await resolveV1RequestContext(request);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    const body = bodySchema.parse(rawBody);

    // Paso propio: existencia + pertenencia + estado, antes de tocar
    // requestN8nPublish — clasificación 404/503/409 explícita, no delegada
    // a PublishTargetConflictError (que colapsa "no existe" con "error real").
    const ownershipCheck = await repository.checkPublicationTargetOwnership(
      contentItemId,
      body.publicationTargetId,
    );
    if (ownershipCheck.failed) return jsonError("TARGET_LOOKUP_FAILED", 503);
    if (!ownershipCheck.target) return jsonError("TARGET_NOT_FOUND", 404);
    if (ownershipCheck.target.status !== "APPROVED") return jsonError("TARGET_NOT_APPROVED", 409);

    const record = await repository.getContentRecord(contentItemId);
    // Corrección ronda 1 de revisión del plan (hallazgo real):
    // record.asset.signedUrl es opcional — un target APPROVED sin una URL
    // firmada servible es una inconsistencia interna, no un error del
    // caller. Se distingue explícitamente en vez de dejar que
    // assetUrl: undefined llegue a la validación zod de requestN8nPublish,
    // que lo clasificaría como 400 (culpa del caller) en vez de 503.
    if (!record?.asset?.signedUrl || !record.finalCopy) {
      return jsonError("TARGET_LOOKUP_FAILED", 503);
    }

    try {
      const result = await requestN8nPublish(
        {
          contentItemId,
          publicationTargetId: body.publicationTargetId,
          assetUrl: record.asset.signedUrl,
          idempotencyKey: body.idempotencyKey,
          copy: {
            headline: record.finalCopy.headline,
            body: record.finalCopy.body,
            cta: record.finalCopy.cta,
          },
        },
        { repository },
      );
      return Response.json(result, { status: result.created ? 202 : 200 });
    } catch (error) {
      // Segunda llamada redundante dentro de requestN8nPublish a
      // preparePublishRequest — si conflict aquí, el pre-chequeo de arriba
      // ya probó que el target existe/pertenece/está APPROVED segundos
      // antes, así que es una carrera transitoria, no un 409 real.
      if (error instanceof PublishTargetConflictError) return jsonError("TARGET_LOOKUP_FAILED", 503);
      if (error instanceof N8nPublishConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      if (error instanceof N8nPublishDeliveryError) return jsonError("N8N_DELIVERY_FAILED", 502);
      throw error;
    }
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    if (error instanceof z.ZodError) return jsonError("INVALID_REQUEST", 400);
    return jsonError("PUBLISH_REQUEST_FAILED", 500);
  }
}
