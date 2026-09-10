import { z } from "zod";

import type { CopyJobWorkerRepository } from "@/lib/automation/jobs";
import { createN8nCallbackRepository } from "@/lib/content/repository-factory";
import { verifyN8nSignature } from "@/lib/integrations/n8n-signature";

const schema = z.object({ jobId: z.string().uuid(), idempotencyKey: z.string().uuid() }).strict();
type Dependencies = { getRepository?: () => Promise<Pick<CopyJobWorkerRepository, "claimCopyJob">>; getSecret?: () => string | undefined; nowMs?: () => number };

export function createCopyClaimHandler(dependencies: Dependencies = {}) {
  const getRepository = dependencies.getRepository ?? (createN8nCallbackRepository as never);
  const getSecret = dependencies.getSecret ?? (() => process.env.SNAPGAD_N8N_SHARED_SECRET);
  const nowMs = dependencies.nowMs ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const secret = getSecret();
    const timestamp = request.headers.get("x-snapgad-timestamp");
    const signature = request.headers.get("x-snapgad-signature");
    const raw = await request.text();
    if (!secret || !verifyN8nSignature(raw, timestamp, signature, secret, { nowMs: nowMs() })) return Response.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) return Response.json({ error: "INVALID_CLAIM" }, { status: 400 });
    const claim = await (await getRepository()).claimCopyJob(parsed.data);
    return claim.state === "CLAIMED" ? Response.json(claim) : Response.json({ error: "JOB_NOT_CLAIMABLE" }, { status: 409 });
  };
}
export const POST = createCopyClaimHandler();
