import { z } from "zod";

import {
  resolveV1RequestContext,
  V1AuthenticationError,
  V1NotConfiguredError,
} from "@/lib/api/v1-context";

const contentIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const params = await context.params;
    const parsed = contentIdSchema.safeParse(params.id);
    if (!parsed.success) return jsonError("INVALID_CAMPAIGN_ID", 400);

    const { repository } = await resolveV1RequestContext(request);
    const record = await repository.getContentRecord(parsed.data);
    if (!record) return jsonError("CAMPAIGN_NOT_FOUND", 404);
    return Response.json(record);
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    return jsonError("CAMPAIGN_LOOKUP_FAILED", 500);
  }
}
