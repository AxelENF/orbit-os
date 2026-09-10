import { describe, expect, it, vi } from "vitest";

import { createCopyRequestHandler } from "@/app/api/integrations/n8n/copy/route";
import { createPublishRequestHandler } from "@/app/api/integrations/n8n/publish/route";
import { createDemoRepository } from "@/lib/demo/repository";

const brief = {
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

const copyPayload = (contentItemId: string) => ({
  contentItemId,
  idempotencyKey: "4a150496-852d-46d4-8f25-951f6512db73",
});

const publishCopy = {
  body: "Atiende solicitudes y agenda citas.",
  cta: "Escribe AGENDA",
};

describe("portal to n8n request bridges", () => {
  it("starts copy once and makes retries idempotent in demo mode", async () => {
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
    const handler = createCopyRequestHandler({
      getRepository: async () => repository,
      environment: {},
      fetchFn: vi.fn(),
    });

    const first = await handler(
      new Request("http://localhost/api/integrations/n8n/copy", {
        method: "POST",
        body: JSON.stringify(copyPayload(item.id)),
      }),
    );
    const retry = await handler(
      new Request("http://localhost/api/integrations/n8n/copy", {
        method: "POST",
        body: JSON.stringify(copyPayload(item.id)),
      }),
    );

    expect(first.status).toBe(202);
    expect(retry.status).toBe(200);
    expect((await repository.getContentItem(item.id))?.state).toBe("GENERATING");
  });

  it("requires target approval before queueing a publish request", async () => {
    const repository = createDemoRepository({ initialContentState: "REVIEW" });
    const item = await repository.createContentItem(brief);
    const [facebook] = await repository.listPublicationTargets(item.id);
    const handler = createPublishRequestHandler({
      getRepository: async () => repository,
      environment: {},
      fetchFn: vi.fn(),
      createId: () => "cced3e68-7206-4c2f-9848-6bf474882150",
    });
    const payload = {
      contentItemId: item.id,
      publicationTargetId: facebook!.id,
      assetUrl: "https://cdn.example.com/final.png",
      copy: publishCopy,
    };

    const rejected = await handler(
      new Request("http://localhost/api/integrations/n8n/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    expect(rejected.status).toBe(409);

    await repository.approvePublicationTarget(item.id, facebook!.id);
    const first = await handler(
      new Request("http://localhost/api/integrations/n8n/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    const retry = await handler(
      new Request("http://localhost/api/integrations/n8n/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );

    expect(first.status).toBe(202);
    expect(retry.status).toBe(200);
  });

  it("rejects oversized request bodies before parsing", async () => {
    const handler = createCopyRequestHandler({
      getRepository: async () => createDemoRepository(),
    });
    const response = await handler(
      new Request("http://localhost/api/integrations/n8n/copy", {
        method: "POST",
        headers: { "content-length": "256001" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "REQUEST_TOO_LARGE" });
  });

  it("rejects caller-supplied brief and asset fields before a durable job is created", async () => {
    const enqueueCopyJob = vi.fn();
    const handler = createCopyRequestHandler({
      getRepository: async () => ({ enqueueCopyJob }),
      environment: {},
    });
    const response = await handler(
      new Request("http://localhost/api/integrations/n8n/copy", {
        method: "POST",
        body: JSON.stringify({
          contentItemId: "1e62a32f-64c2-4da4-bad0-2837baad7812",
          idempotencyKey: "4a150496-852d-46d4-8f25-951f6512db73",
          assetUrl: "https://evil.example/asset.png",
          brief,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(enqueueCopyJob).not.toHaveBeenCalled();
  });
});
