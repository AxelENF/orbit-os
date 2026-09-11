import { describe, expect, it, vi } from "vitest";

import { createFinalCopySubmissionHandler } from "@/app/api/content/[id]/final-copy/route";
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

describe("POST /api/content/[id]/final-copy", () => {
  it("stores one selected final copy then moves the content into review", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });

    const response = await handler(
      new Request("http://localhost/api/content/final-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline: "Tu WhatsApp también puede agendar",
          body: "El bot puede atender, calificar y agendar citas.",
          cta: "Escribe AGENDA por WhatsApp",
        }),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      finalCopy: { contentItemId: item.id, version: 1 },
    });
    expect((await repository.getContentRecord(item.id))?.content.state).toBe("REVIEW");
  });

  it("passes final hashtags from the request to the injected repository", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const submitFinalCopyForReview = vi.spyOn(repository, "submitFinalCopyForReview");
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });

    const response = await handler(
      new Request("http://localhost/api/content/final-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline: "Tu WhatsApp también puede agendar",
          body: "El bot puede atender, calificar y agendar citas.",
          cta: "Escribe AGENDA por WhatsApp",
          hashtags: ["#AutomatizacionWhatsApp", "#NegociosMexico"],
        }),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    expect(response.status).toBe(201);
    expect(submitFinalCopyForReview).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        hashtags: ["#AutomatizacionWhatsApp", "#NegociosMexico"],
      }),
    );
  });

  it("fails closed when the final copy is not grounded in the brief", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });

    const response = await handler(
      new Request("http://localhost/api/content/final-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline: "Duplica ventas hoy",
          body: "Sin explicación.",
          cta: "Escribe AGENDA",
        }),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "FINAL_COPY_NOT_REVIEWABLE" });
  });

  it("reconciles a retry to the immutable final copy after the first response was lost", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });
    const requestPayload = {
      headline: "Tu WhatsApp también puede agendar",
      body: "El bot puede atender, calificar y agendar citas.",
      cta: "Escribe AGENDA por WhatsApp",
    };

    await handler(
      new Request("http://localhost/api/content/final-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestPayload),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    const retryResponse = await handler(
      new Request("http://localhost/api/content/final-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestPayload),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toMatchObject({
      finalCopy: { contentItemId: item.id, version: 1 },
      reconciled: true,
    });
    expect((await repository.getContentRecord(item.id))?.content.state).toBe("REVIEW");
  });
});
