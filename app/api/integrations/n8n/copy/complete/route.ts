import { z } from "zod";

import type { CopyJobWorkerRepository } from "@/lib/automation/jobs";
import { createN8nCallbackRepository } from "@/lib/content/repository-factory";
import { verifyN8nSignature } from "@/lib/integrations/n8n-signature";

const text = z.string().trim().min(1).max(10_000);
const schema = z.object({
  jobId: z.string().uuid(), idempotencyKey: z.string().uuid(), leaseToken: z.string().uuid(),
  result: z.object({
    visualAnalysis: z.object({ scene: text, visibleText: z.array(text).max(100), proof: z.array(text).max(100), risks: z.array(text).max(100) }).strict(),
    drafts: z.array(z.object({ headline: text, body: text, cta: text }).strict()).length(2),
    warnings: z.array(text).max(100), provider: text.optional(), model: text.optional(),
  }).strict(),
}).strict();
type Dependencies = { getRepository?: () => Promise<Pick<CopyJobWorkerRepository, "completeCopyJob">>; getSecret?: () => string | undefined; nowMs?: () => number };

export function createCopyCompleteHandler(dependencies: Dependencies = {}) {
  const getRepository = dependencies.getRepository ?? (createN8nCallbackRepository as never);
  const getSecret = dependencies.getSecret ?? (() => process.env.SNAPGAD_N8N_SHARED_SECRET);
  const nowMs = dependencies.nowMs ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const secret = getSecret(); const raw = await request.text();
    if (!secret || !verifyN8nSignature(raw, request.headers.get("x-snapgad-timestamp"), request.headers.get("x-snapgad-signature"), secret, { nowMs: nowMs() })) return Response.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    let value: unknown; try { value = JSON.parse(raw); } catch { return Response.json({ error: "INVALID_COMPLETE" }, { status: 400 }); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return Response.json({ error: "INVALID_COMPLETE" }, { status: 400 });
    const result = await (await getRepository()).completeCopyJob(parsed.data);
    return Response.json(result, { status: result.created ? 202 : 200 });
  };
}
export const POST = createCopyCompleteHandler();
