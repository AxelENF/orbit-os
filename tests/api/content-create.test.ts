import { describe, expect, it } from "vitest";

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

function validPng(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, 1080, false);
  new DataView(bytes.buffer).setUint32(20, 1350, false);
  return bytes;
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function requestWithAsset(briefPayload: unknown = brief): Request {
  const form = new FormData();
  form.set("brief", JSON.stringify(briefPayload));
  form.set("asset", new File([blobPart(validPng())], "creative.png", { type: "image/png" }));
  return new Request("http://localhost/api/content", { method: "POST", body: form });
}

describe("POST /api/content", () => {
  it("validates the final creative and creates an uploaded demo item", async () => {
    const repository = createDemoRepository();
    const response = await createContentCreateHandler({
      getRepository: async () => repository,
      createId: () => "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
    })(requestWithAsset());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      content: {
        state: "UPLOADED",
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
});
