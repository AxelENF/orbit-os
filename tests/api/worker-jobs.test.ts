import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createCopyClaimHandler } from "@/app/api/integrations/n8n/copy/claim/route";
import { createCopyCompleteHandler } from "@/app/api/integrations/n8n/copy/complete/route";
import { createDemoRepository } from "@/lib/demo/repository";
import { signN8nPayload } from "@/lib/integrations/n8n-signature";

const secret = "worker-test-secret";
const timestamp = "1780000000";
const jobId = "1e62a32f-64c2-4da4-bad0-2837baad7812";
const idempotencyKey = "8ab76cc5-f59a-48ed-8bc8-186cc7007533";

function signedRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-snapgad-timestamp": timestamp,
      "x-snapgad-signature": signN8nPayload(body, timestamp, secret),
    },
    body: JSON.stringify(body),
  });
}

describe("copy worker portal boundary", () => {
  it("claims a job once and never accepts worker-supplied organization or asset data", async () => {
    const claimCopyJob = vi
      .fn()
      .mockResolvedValueOnce({
        state: "CLAIMED",
        job: {
          id: jobId,
          idempotencyKey,
          leaseToken: "4a150496-852d-46d4-8f25-951f6512db73",
          leaseExpiresAt: "2026-05-28T00:01:00.000Z",
          contentItemId: "item-derived-by-portal",
          assetUrl: "https://signed.example.com/derived.png",
          brief: { cta: "Escribe AGENDA" },
        },
      })
      .mockResolvedValueOnce({ state: "NOT_CLAIMABLE" });
    const handler = createCopyClaimHandler({
      getRepository: async () => ({ claimCopyJob }),
      getSecret: () => secret,
      nowMs: () => Number(timestamp) * 1000,
    });
    const body = { jobId, idempotencyKey };

    const first = await handler(signedRequest("http://localhost/claim", body));
    const second = await handler(signedRequest("http://localhost/claim", body));

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ job: { id: jobId, assetUrl: "https://signed.example.com/derived.png" } });
    expect(second.status).toBe(409);
    expect(claimCopyJob).toHaveBeenCalledWith({ jobId, idempotencyKey });
  });

  it("rejects worker-supplied organization, asset, brief, and owner fields", async () => {
    const claimCopyJob = vi.fn();
    const handler = createCopyClaimHandler({
      getRepository: async () => ({ claimCopyJob }),
      getSecret: () => secret,
      nowMs: () => Number(timestamp) * 1000,
    });
    const response = await handler(signedRequest("http://localhost/claim", {
      jobId, idempotencyKey, organizationId: "attacker", ownerId: "attacker", assetUrl: "https://evil.example", brief: {},
    }));
    expect(response.status).toBe(400);
    expect(claimCopyJob).not.toHaveBeenCalled();
  });

  it("rejects expired signatures before claiming", async () => {
    const claimCopyJob = vi.fn();
    const handler = createCopyClaimHandler({
      getRepository: async () => ({ claimCopyJob }),
      getSecret: () => secret,
      nowMs: () => (Number(timestamp) + 301) * 1000,
    });
    const response = await handler(signedRequest("http://localhost/claim", { jobId, idempotencyKey }));
    expect(response.status).toBe(401);
    expect(claimCopyJob).not.toHaveBeenCalled();
  });

  it("completes a claimed job idempotently without accepting content identity from n8n", async () => {
    const completeCopyJob = vi
      .fn()
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false });
    const handler = createCopyCompleteHandler({
      getRepository: async () => ({ completeCopyJob }),
      getSecret: () => secret,
      nowMs: () => Number(timestamp) * 1000,
    });
    const body = {
      jobId,
      idempotencyKey,
      leaseToken: "4a150496-852d-46d4-8f25-951f6512db73",
      result: {
        visualAnalysis: { scene: "Agenda", visibleText: [], proof: [], risks: [] },
        drafts: [
          { headline: "A", body: "Atiende y agenda.", cta: "Escribe AGENDA" },
          { headline: "B", body: "Responde clientes.", cta: "Escribe AGENDA" },
        ],
        warnings: [],
      },
    };
    const first = await handler(signedRequest("http://localhost/complete", body));
    const second = await handler(signedRequest("http://localhost/complete", body));
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(completeCopyJob).toHaveBeenCalledWith({
      jobId,
      idempotencyKey,
      leaseToken: "4a150496-852d-46d4-8f25-951f6512db73",
      result: body.result,
    });
  });

  it("rejects a completion that supplies a content or organization identity", async () => {
    const completeCopyJob = vi.fn();
    const handler = createCopyCompleteHandler({
      getRepository: async () => ({ completeCopyJob }), getSecret: () => secret, nowMs: () => Number(timestamp) * 1000,
    });
    const response = await handler(signedRequest("http://localhost/complete", {
      jobId, idempotencyKey, leaseToken: "4a150496-852d-46d4-8f25-951f6512db73", contentItemId: "attacker", organizationId: "attacker",
      result: { visualAnalysis: { scene: "Agenda", visibleText: [], proof: [], risks: [] }, drafts: [], warnings: [] },
    }));
    expect(response.status).toBe(400);
    expect(completeCopyJob).not.toHaveBeenCalled();
  });
});

describe("durable copy jobs in the demo repository", () => {
  const brief = {
    businessLine: "AUTOMATIZAR" as const,
    service: "bot_whatsapp" as const,
    niche: "clinicas" as const,
    contentType: "venta_directa" as const,
    objective: "agenda_demo" as const,
    format: "feed_4_5" as const,
    cta: "Escribe AGENDA por WhatsApp",
    humanDescription: "Mostrar el bot de agenda.",
    allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
  };

  it("enqueues once, leases one derived persisted job, and completes it idempotently", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItemWithAsset({
      brief,
      asset: {
        id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
        filename: "agenda.png",
        mimeType: "image/png",
        width: 1080,
        height: 1350,
        checksum: "checksum",
        bytes: new Uint8Array([1, 2, 3]),
      },
    });

    const first = await repository.enqueueCopyJob({
      contentItemId: item.id,
      idempotencyKey,
    });
    const retry = await repository.enqueueCopyJob({
      contentItemId: item.id,
      idempotencyKey,
    });
    expect(first).toMatchObject({ created: true, jobId: expect.any(String) });
    expect(retry).toEqual({ created: false, jobId: first.jobId, idempotencyKey });

    const claim = await repository.claimCopyJob({
      jobId: first.jobId,
      idempotencyKey,
    });
    expect(claim).toMatchObject({
      state: "CLAIMED",
      job: {
        id: first.jobId,
        idempotencyKey,
        assetUrl: expect.stringContaining("agenda.png"),
        brief: expect.objectContaining({ cta: brief.cta }),
      },
    });
    await expect(repository.claimCopyJob({ jobId: first.jobId, idempotencyKey })).resolves.toEqual({
      state: "NOT_CLAIMABLE",
    });

    if (claim.state !== "CLAIMED") throw new Error("expected claimed job");
    const completion = {
      jobId: first.jobId,
      idempotencyKey,
      leaseToken: claim.job.leaseToken,
      result: {
        visualAnalysis: { scene: "Agenda", visibleText: [], proof: [], risks: [] },
        drafts: [
          { headline: "A", body: "Atiende y agenda.", cta: "Escribe AGENDA" },
          { headline: "B", body: "Responde clientes.", cta: "Escribe AGENDA" },
        ],
        warnings: [],
      },
    };
    await expect(repository.completeCopyJob(completion)).resolves.toEqual({ created: true });
    await expect(repository.completeCopyJob(completion)).resolves.toEqual({ created: false });
    expect((await repository.getContentItem(item.id))?.state).toBe("DRAFT");
  });
});

describe("durable copy-job migration", () => {
  it("enqueues under the trusted organization before a worker can claim persisted data", async () => {
    const sql = await readFile(
      fileURLToPath(new URL("../../supabase/migrations/0010_automation_jobs.sql", import.meta.url)),
      "utf8",
    );
    expect(sql).toMatch(/create function public\.enqueue_copy_automation_job/i);
    expect(sql).toMatch(/p_organization_id uuid[\s\S]*p_actor_id uuid[\s\S]*p_content_item_id uuid[\s\S]*p_idempotency_key uuid/i);
    expect(sql).toMatch(/public\.assert_organization_actor/i);
    expect(sql).toMatch(/unique\s*\(organization_id, kind, idempotency_key\)/i);
    expect(sql).toMatch(/security definer\s+set search_path = pg_catalog/i);
  });

  it("creates the legacy callback request marker in the same enqueue transaction", async () => {
    const sql = await readFile(
      fileURLToPath(new URL("../../supabase/migrations/0010_automation_jobs.sql", import.meta.url)),
      "utf8",
    );
    expect(sql).toMatch(
      /insert\s+into\s+public\.automation_runs[\s\S]*'COPY_REQUEST'[\s\S]*p_idempotency_key/i,
    );
  });
});
