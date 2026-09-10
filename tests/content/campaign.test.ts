import { describe, expect, it } from "vitest";

import {
  buildCampaignCode,
  validateCampaignBrief,
} from "@/lib/content/campaign";
import { validateFinalCopy } from "@/lib/content/final-copy";

const validCampaign = {
  businessLine: "CAPTAR",
  service: "bot_whatsapp",
  niche: "clinicas",
  contentType: "venta_directa",
  objective: "conversaciones_whatsapp",
  format: "feed_4_5",
  cta: "Escribe AGENDA por WhatsApp",
  humanDescription: "Una clínica deja de responder mensajes al cerrar y pierde citas.",
  allowedFacts: ["El bot puede atender, calificar y agendar citas."],
  campaignName: "Agenda clínica septiembre",
  offer: "Automatización de agenda por WhatsApp",
  funnelStage: "captacion",
  destination: "whatsapp",
  destinationValue: "https://wa.me/5215555555555?text=AGENDA",
};

describe("campaign contract", () => {
  it("requires an explicit offer, funnel stage and verified destination", () => {
    expect(validateCampaignBrief(validCampaign)).toMatchObject({
      campaignName: "Agenda clínica septiembre",
      destination: "whatsapp",
    });
    expect(() => validateCampaignBrief({ ...validCampaign, offer: "" })).toThrow();
    expect(() =>
      validateCampaignBrief({ ...validCampaign, destinationValue: "not-a-url" }),
    ).toThrow();
  });

  it("creates a traceable campaign code from stable inputs", () => {
    expect(buildCampaignCode("agenda clínica septiembre", "item-123", new Date("2026-09-05"))).toBe(
      "SG-AGENDA-20260905-ITEM123",
    );
  });
});

describe("final copy guardrails", () => {
  it("accepts direct copy grounded in allowed facts and an explicit CTA", () => {
    expect(
      validateFinalCopy({
        headline: "Tu WhatsApp también puede agendar",
        body: "El bot puede atender, calificar y agendar citas cuando tu equipo no está disponible.",
        cta: "Escribe AGENDA por WhatsApp",
      }, validCampaign),
    ).toEqual({ ok: true, reasons: [] });
  });

  it("blocks unsupported results, invented urgency and a missing CTA", () => {
    const result = validateFinalCopy({
      headline: "Duplica tus ventas hoy",
      body: "",
      cta: "",
    }, validCampaign);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("El copy final necesita un mensaje principal, cuerpo y CTA.");
    expect(result.reasons).toContain("El copy contiene una promesa o urgencia que no está respaldada por los hechos permitidos.");
  });
});
