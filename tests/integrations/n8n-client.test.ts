import { describe, expect, it, vi } from "vitest";

import type { PublishRequestRepository } from "@/lib/content/repository";
import { createDemoRepository } from "@/lib/demo/repository";
import { requestN8nCopy, requestN8nPublish } from "@/lib/integrations/n8n-client";
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
const copyInput = {
  contentItemId: requestInput.contentItemId,
};
const copyBrief = {
  businessLine: "AUTOMATIZAR" as const,
  service: "bot_whatsapp" as const,
  niche: "clinicas" as const,
  contentType: "venta_directa" as const,
  objective: "agenda_demo" as const,
  format: "feed_4_5" as const,
  cta: "Escribe AGENDA por WhatsApp",
  humanDescription: "Mostrar un bot que agenda citas.",
  allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
};
const copyAsset = {
  id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
  filename: "agenda.png",
  mimeType: "image/png",
  width: 1080,
  height: 1350,
  checksum: "checksum",
  bytes: new Uint8Array([1, 2, 3]),
};

describe("n8n publish client", () => {
  it("returns DRY_RUN_QUEUED in demo mode without calling fetch", async () => {
    const repository = createDemoRepository({ initialContentState: "REVIEW" });
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

  it("refuses configured publish delivery until the tenant Meta worker is explicitly enabled", async () => {
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

    await expect(requestN8nPublish(requestInput, {
      repository,
      fetchFn,
      environment: {
        SNAPGAD_N8N_PUBLISH_URL: "https://n8n.example.com/webhook/snapgad/content/publish",
        SNAPGAD_N8N_SHARED_SECRET: SECRET,
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      },
      nowMs: () => NOW_MS,
      createId: () => "cced3e68-7206-4c2f-9848-6bf474882150",
    })).rejects.toThrow("not configured");
    expect(repository.preparePublishRequest).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("n8n copy client", () => {
  it("queues copy in demo mode and moves a draft into GENERATING", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItemWithAsset({ brief: copyBrief, asset: copyAsset });
    const fetchFn = vi.fn();

    const result = await requestN8nCopy(
      { ...copyInput, contentItemId: item.id },
      {
        repository,
        fetchFn,
        createId: () => "4a150496-852d-46d4-8f25-951f6512db73",
      },
    );

    expect(result).toMatchObject({
      created: true,
      status: "DRY_RUN_QUEUED",
      contentItemId: item.id,
    });
    expect((await repository.getContentItem(item.id))?.state).toBe("GENERATING");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("signs only the durable job reference before sending it to n8n", async () => {
    const repository = {
      enqueueCopyJob: vi.fn().mockResolvedValue({
        created: true,
        jobId: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
        idempotencyKey: "4a150496-852d-46d4-8f25-951f6512db73",
      }),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));

    const result = await requestN8nCopy(copyInput, {
      repository,
      fetchFn,
      environment: {
        SNAPGAD_N8N_COPY_URL:
          "https://n8n.example.com/webhook/snapgad/content/copy",
        SNAPGAD_N8N_SHARED_SECRET: SECRET,
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      },
      nowMs: () => NOW_MS,
      createId: () => "4a150496-852d-46d4-8f25-951f6512db73",
    });

    expect(result.status).toBe("QUEUED");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    expect(url).toBe("https://n8n.example.com/webhook/snapgad/content/copy");
    expect(payload).toMatchObject({
      jobId: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
      idempotencyKey: "4a150496-852d-46d4-8f25-951f6512db73",
    });
    expect(payload).not.toHaveProperty("contentItemId");
    expect(payload).not.toHaveProperty("assetUrl");
    expect(payload).not.toHaveProperty("brief");
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

  it("rejects caller-supplied asset and brief fields instead of signing them", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItemWithAsset({ brief: copyBrief, asset: copyAsset });

    await expect(
      requestN8nCopy(
        {
          ...copyInput,
          contentItemId: item.id,
          assetUrl: "https://evil.example/asset.png",
          brief: { ...copyBrief, niche: "spas" },
        },
        { repository, createId: () => "4a150496-852d-46d4-8f25-951f6512db73" },
      ),
    ).rejects.toThrow();
  });

  it("keeps a failed delivery retryable with the same key until its callback arrives", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItemWithAsset({ brief: copyBrief, asset: copyAsset });
    const idempotencyKey = "4a150496-852d-46d4-8f25-951f6512db73";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const dependencies = {
      repository,
      fetchFn,
      environment: {
        SNAPGAD_N8N_COPY_URL: "https://n8n.example.com/webhook/snapgad/content/copy",
        SNAPGAD_N8N_SHARED_SECRET: SECRET,
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      },
      createId: () => idempotencyKey,
    };

    await expect(
      requestN8nCopy({ ...copyInput, contentItemId: item.id }, dependencies),
    ).resolves.toMatchObject({ status: "DELIVERY_UNCONFIRMED", idempotencyKey, created: true });
    expect((await repository.getContentItem(item.id))?.state).toBe("GENERATING");

    await expect(
      requestN8nCopy({ ...copyInput, contentItemId: item.id, idempotencyKey }, dependencies),
    ).resolves.toMatchObject({ status: "QUEUED", idempotencyKey, created: false });

    await repository.ingestCopyResult({
      contentItemId: item.id,
      idempotencyKey,
      visualAnalysis: {},
      drafts: [{ headline: "Prueba", body: "El bot atiende y agenda.", cta: "Escribe AGENDA" }],
      warnings: [],
    });
    expect((await repository.getContentItem(item.id))?.state).toBe("DRAFT");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("reuses the persisted key after a network timeout and accepts its signed callback", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItemWithAsset({ brief: copyBrief, asset: copyAsset });
    const idempotencyKey = "4a150496-852d-46d4-8f25-951f6512db73";
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const dependencies = {
      repository,
      fetchFn,
      environment: {
        SNAPGAD_N8N_COPY_URL: "https://n8n.example.com/webhook/snapgad/content/copy",
        SNAPGAD_N8N_SHARED_SECRET: SECRET,
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      },
      createId: () => idempotencyKey,
    };

    await expect(
      requestN8nCopy({ ...copyInput, contentItemId: item.id }, dependencies),
    ).resolves.toMatchObject({ status: "DELIVERY_UNCONFIRMED", idempotencyKey, created: true });

    await expect(
      requestN8nCopy({ ...copyInput, contentItemId: item.id, idempotencyKey }, dependencies),
    ).resolves.toMatchObject({ status: "QUEUED", idempotencyKey, created: false });

    const firstPayload = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    const retryPayload = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body));
    expect(firstPayload.idempotencyKey).toBe(idempotencyKey);
    expect(retryPayload.idempotencyKey).toBe(idempotencyKey);

    await repository.ingestCopyResult({
      contentItemId: item.id,
      idempotencyKey,
      visualAnalysis: {},
      drafts: [{ headline: "Prueba", body: "El bot atiende y agenda.", cta: "Escribe AGENDA" }],
      warnings: [],
    });
    expect((await repository.getContentItem(item.id))?.state).toBe("DRAFT");
  });
});
