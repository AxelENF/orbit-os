import { describe, expect, it } from "vitest";

import { createCampaignPreflightHandler } from "@/app/api/content/[id]/preflight/route";
import { createDemoRepository } from "@/lib/demo/repository";

const campaign = {
  businessLine: "CAPTAR" as const,
  service: "bot_whatsapp" as const,
  niche: "clinicas" as const,
  contentType: "venta_directa" as const,
  objective: "conversaciones_whatsapp" as const,
  format: "feed_4_5" as const,
  cta: "Escribe AGENDA por WhatsApp",
  humanDescription: "Una clínica deja de responder mensajes al cerrar y pierde citas.",
  allowedFacts: ["El bot puede atender, calificar y agendar citas."],
  campaignName: "Agenda clínica septiembre",
  offer: "Automatización de agenda por WhatsApp",
  funnelStage: "captacion" as const,
  destination: "whatsapp" as const,
  destinationValue: "https://wa.me/5215555555555?text=AGENDA",
};

describe("GET /api/content/[id]/preflight", () => {
  it("reports that a campaign cannot be approved before a selected final copy", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const handler = createCampaignPreflightHandler({ getRepository: async () => repository });

    const response = await handler(new Request("http://localhost/api/content/preflight"), {
      params: Promise.resolve({ id: item.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "finalCopy", ok: false }),
      ]),
    });
  });
});
