import { describe, expect, it, vi } from "vitest";

import { createContentCreateHandler } from "@/app/api/content/route";
import { createDemoRepository } from "@/lib/demo/repository";

const brief = {
  businessLine: "AUTOMATIZAR",
  service: "bot_whatsapp",
  niche: "clinicas",
  contentType: "venta_directa",
  objective: "agenda_demo",
  format: "feed_4_5",
  cta: "Escribe AGENDA por WhatsApp",
  humanDescription: "Mostrar un bot que agenda citas.",
  allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
  campaignName: "Agenda clínica septiembre",
  offer: "Automatización de agenda por WhatsApp",
  funnelStage: "captacion",
  destination: "whatsapp",
  destinationValue: "https://wa.me/5215555555555?text=AGENDA",
};

function validPng(width = 1080, height = 1350): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function requestWithAssets(
  files: Array<{ name: string; bytes: Uint8Array; type?: string }>,
  briefPayload: unknown = brief,
): Request {
  const form = new FormData();
  form.set("brief", JSON.stringify(briefPayload));
  for (const file of files) {
    form.append("assets", new File([blobPart(file.bytes)], file.name, { type: file.type ?? "image/png" }));
  }
  return new Request("http://localhost/api/content", { method: "POST", body: form });
}

function requestWithAsset(briefPayload: unknown = brief): Request {
  return requestWithAssets([{ name: "creative.png", bytes: validPng() }], briefPayload);
}

describe("POST /api/content", () => {
  it("validates the final creative and creates an uploaded demo item, then queues its copy job", async () => {
    const repository = createDemoRepository();
    const response = await createContentCreateHandler({
      getRepository: async () => repository,
      createId: () => "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
    })(requestWithAsset());

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toMatchObject({
      content: {
        state: "GENERATING",
        assetId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
        campaign: {
          campaignName: "Agenda clínica septiembre",
          offer: "Automatización de agenda por WhatsApp",
          funnelStage: "captacion",
          destination: "whatsapp",
          destinationValue: "https://wa.me/5215555555555?text=AGENDA",
        },
      },
    });

    const record = await repository.getContentRecord(payload.content.id);
    expect(record?.content.state).toBe("GENERATING");
  });

  it("rejects an invalid brief or asset before repository writes", async () => {
    const repository = createDemoRepository();
    const response = await createContentCreateHandler({
      getRepository: async () => repository,
    })(requestWithAsset({ ...brief, allowedFacts: [] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_CONTENT_ASSET" });
    await expect(repository.listContentItems()).resolves.toHaveLength(0);
  });

  it("rejects a creative that does not include campaign context", async () => {
    const repository = createDemoRepository();
    const legacyBrief = Object.fromEntries(
      Object.entries(brief).filter(([key]) => key !== "campaignName"),
    );
    const response = await createContentCreateHandler({
      getRepository: async () => repository,
    })(requestWithAsset(legacyBrief));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_CONTENT_ASSET" });
  });

  it("keeps a saved asset recoverable when its first copy enqueue cannot be confirmed", async () => {
    const repository = createDemoRepository();
    const response = await createContentCreateHandler({
      getRepository: async () => ({
        createContentItemWithAssets: repository.createContentItemWithAssets.bind(repository),
        enqueueCopyJob: async () => {
          throw new Error("queue unavailable");
        },
      }),
      createId: () => "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
    })(requestWithAsset());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      warning: "COPY_QUEUE_PENDING",
      content: { state: "UPLOADED" },
    });
    await expect(repository.listContentItems()).resolves.toHaveLength(1);
  });

  it("accepts 3 files in assets and preserves their selection order", async () => {
    const createContentItemWithAssets = vi.fn().mockResolvedValue({
      id: "b411ce10-50a9-4d8b-8ff3-a7fb522b53d2",
      state: "UPLOADED",
    });
    const enqueueCopyJob = vi.fn().mockResolvedValue(undefined);
    const response = await createContentCreateHandler({
      getRepository: async () => ({ createContentItemWithAssets, enqueueCopyJob }),
      createId: (() => {
        const ids = [
          "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
          "0b93d53f-1d18-4d83-b7c8-cb8cf9fc4e1d",
          "e3a14d68-6f52-4ad4-9d3e-77ee64c0fcb2",
          "4a150496-852d-46d4-8f25-951f6512db73",
        ];
        return () => ids.shift()!;
      })(),
    })(requestWithAssets([
      { name: "first.png", bytes: validPng() },
      { name: "second.png", bytes: validPng() },
      { name: "third.png", bytes: validPng() },
    ]));

    expect(response.status).toBe(201);
    expect(createContentItemWithAssets).toHaveBeenCalledWith(expect.objectContaining({
      assets: [
        expect.objectContaining({ id: "8ab76cc5-f59a-48ed-8bc8-186cc7007533", filename: "first.png" }),
        expect.objectContaining({ id: "0b93d53f-1d18-4d83-b7c8-cb8cf9fc4e1d", filename: "second.png" }),
        expect.objectContaining({ id: "e3a14d68-6f52-4ad4-9d3e-77ee64c0fcb2", filename: "third.png" }),
      ],
    }));
  });

  it("validates every file before any repository write", async () => {
    const createContentItemWithAssets = vi.fn();
    const response = await createContentCreateHandler({
      getRepository: async () => ({
        createContentItemWithAssets,
        enqueueCopyJob: vi.fn(),
      }),
    })(requestWithAssets([
      { name: "first.png", bytes: validPng() },
      { name: "invalid.png", bytes: validPng(1080, 1080) },
      { name: "third.png", bytes: validPng() },
    ]));

    expect(response.status).toBe(400);
    expect(createContentItemWithAssets).not.toHaveBeenCalled();
  });

  it("rejects more than 10 files", async () => {
    const createContentItemWithAssets = vi.fn();
    const response = await createContentCreateHandler({
      getRepository: async () => ({
        createContentItemWithAssets,
        enqueueCopyJob: vi.fn(),
      }),
    })(requestWithAssets(
      Array.from({ length: 11 }, (_, index) => ({
        name: `creative-${index}.png`,
        bytes: validPng(),
      })),
    ));

    expect(response.status).toBe(400);
    expect(createContentItemWithAssets).not.toHaveBeenCalled();
  });

  it("rejects an intake with zero files", async () => {
    const createContentItemWithAssets = vi.fn();
    const response = await createContentCreateHandler({
      getRepository: async () => ({
        createContentItemWithAssets,
        enqueueCopyJob: vi.fn(),
      }),
    })(requestWithAssets([]));

    expect(response.status).toBe(400);
    expect(createContentItemWithAssets).not.toHaveBeenCalled();
  });
});
