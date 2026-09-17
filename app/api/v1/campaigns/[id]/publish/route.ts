import { z } from "zod";

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";

const bodySchema = z.object({
  publicationTargetId: z.string().uuid(),
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

    // Existencia + pertenencia + estado, clasificados por separado —
    // ver checkPublicationTargetOwnership en lib/content/repository.ts.
    const ownershipCheck = await repository.checkPublicationTargetOwnership(
      contentItemId,
      body.publicationTargetId,
    );
    if (ownershipCheck.failed) return jsonError("TARGET_LOOKUP_FAILED", 503);
    if (!ownershipCheck.target) return jsonError("TARGET_NOT_FOUND", 404);
    if (ownershipCheck.target.status !== "APPROVED") return jsonError("TARGET_NOT_APPROVED", 409);

    // Un publication_target solo llega a status APPROVED a través de la RPC
    // approve_publication_target (migración 0018_meta_publisher.sql), que
    // en la MISMA transacción siempre llama a enqueue_publish_automation_job
    // — tanto en la primera aprobación como en cualquier re-entrada
    // idempotente sobre un target ya aprobado. El chequeo de arriba, al
    // confirmar status === "APPROVED", ya es por construcción la prueba de
    // que el job de publish real existe y el worker durable
    // (worker/providers/meta-publish-processor.ts) lo va a procesar — no
    // hay una acción adicional que disparar acá. Este endpoint nunca llama
    // al camino legacy de n8n (lib/integrations/n8n-client.ts): ese código
    // sigue existiendo sin tocar, pero ya no lo usa ningún camino nuevo.
    return Response.json(
      {
        queued: true,
        publicationTargetId: ownershipCheck.target.id,
        platform: ownershipCheck.target.platform,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    if (error instanceof z.ZodError) return jsonError("INVALID_REQUEST", 400);
    return jsonError("PUBLISH_REQUEST_FAILED", 500);
  }
}
