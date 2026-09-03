import { describe, expect, it, vi } from "vitest";

import type { PublishRequestRepository } from "@/lib/content/repository";
import { createDemoRepository } from "@/lib/demo/repository";
import { requestN8nPublish } from "@/lib/integrations/n8n-client";
import { verifyN8nSignature } from "@/lib/integrations/n8n-signature";

const SECRET = "a-test-secret-that-never-leaves-this-process";
const NOW_MS = Date.parse("2026-09-02T18:00:00.000Z");
const requestInput = {
  contentItemId: "1e62a32f-64c2-4da4-bad0-2837baad7812",
  publicationTargetId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
  assetUrl: "https://cdn.example.com/final-asset.png",
  copy: {
    headline: "Control al cierre",
    body: "Consulta las ventas registradas.",
    cta: "Escribe POS",
  },
};

describe("n8n publish client", () => {
  it("returns DRY_RUN_QUEUED in demo mode without calling fetch", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem({
      businessLine: "CONTROLAR",
      service: "pos",
      niche: "clinicas",
      contentType: "educativo",
      objective: "conversaciones_whatsapp",
      format: "feed_4_5",
      cta: "Escribe POS",
      humanDescription: "Mostrar el corte de caja.",
      allowedFacts: ["El POS registra ventas."],
    });
    const [facebook] = await repository.listPublicationTargets(item.id);
    await repository.approvePublicationTarget(item.id, facebook!.id);
    const fetchFn = vi.fn();

    const result = await requestN8nPublish(
      {
        ...requestInput,
        contentItemId: item.id,
        publicationTargetId: facebook!.id,
      },
      {
        repository,
        fetchFn,
        createId: () => "cced3e68-7206-4c2f-9848-6bf474882150",
      },
    );

    expect(result).toMatchObject({
      created: true,
      status: "DRY_RUN_QUEUED",
      idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("signs the exact approved target payload before sending it to n8n", async () => {
    const repository: PublishRequestRepository = {
      preparePublishRequest: vi.fn().mockResolvedValue({
        created: true,
        status: "READY",
        ownerId: "98b6b24f-5c93-40cb-b668-67bb1883e108",
        approvedAt: "2026-09-02T17:59:00.000Z",
        target: {
          id: requestInput.publicationTargetId,
          contentItemId: requestInput.contentItemId,
          platform: "FACEBOOK",
          status: "APPROVED",
        },
      }),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));

    const result = await requestN8nPublish(requestInput, {
      repository,
      fetchFn,
      environment: {
        SNAPGAD_N8N_PUBLISH_URL:
          "https://n8n.example.com/webhook/snapgad/content/publish",
        SNAPGAD_N8N_SHARED_SECRET: SECRET,
      },
      nowMs: () => NOW_MS,
      createId: () => "cced3e68-7206-4c2f-9848-6bf474882150",
    });

    expect(result.status).toBe("QUEUED");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    expect(url).toBe("https://n8n.example.com/webhook/snapgad/content/publish");
    expect(payload).toMatchObject({
      publicationTargetId: requestInput.publicationTargetId,
      platform: "FACEBOOK",
      approvalState: "APPROVED",
      idempotencyKey: "cced3e68-7206-4c2f-9848-6bf474882150",
    });
    expect(
      verifyN8nSignature(
        String(init.body),
        headers.get("x-snapgad-timestamp"),
        headers.get("x-snapgad-signature"),
        SECRET,
        { nowMs: NOW_MS },
      ),
    ).toBe(true);
  });
});
