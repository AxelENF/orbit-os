import { describe, expect, it } from "vitest";

import { createCampaignPreflight } from "@/lib/content/preflight";

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

describe("campaign preflight", () => {
  it("reports every pre-publication boundary without mutating a record", () => {
    const result = createCampaignPreflight({
      campaign,
      asset: { mimeType: "image/png", width: 1080, height: 1350 },
      finalCopy: {
        headline: "Tu WhatsApp también puede agendar",
        body: "El bot puede atender, calificar y agendar citas.",
        cta: "Escribe AGENDA por WhatsApp",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "asset",
      "destination",
      "finalCopy",
    ]);
  });

  it("blocks a campaign whose destination and copy do not pass validation", () => {
    const result = createCampaignPreflight({
      campaign: { ...campaign, destinationValue: "not-a-url" },
      asset: { mimeType: "image/png", width: 1080, height: 1350 },
      finalCopy: { headline: "Duplica ventas hoy", body: "", cta: "" },
    });

    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.ok)).toHaveLength(2);
  });
});
