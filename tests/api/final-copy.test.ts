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

  it("calls repository.applyPublicationDiagnosisForContentItem once after successful submission", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const submitFinalCopyForReview = vi.spyOn(repository, "submitFinalCopyForReview");
    const applyPublicationDiagnosisForContentItem = vi.spyOn(
      repository,
      "applyPublicationDiagnosisForContentItem",
    );
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
          hashtags: ["#AutomatizacionWhatsApp"],
        }),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    expect(response.status).toBe(201);
    expect(applyPublicationDiagnosisForContentItem).toHaveBeenCalledTimes(1);
    expect(applyPublicationDiagnosisForContentItem.mock.invocationCallOrder[0]).toBeGreaterThan(
      submitFinalCopyForReview.mock.invocationCallOrder[0],
    );
  });

  it("passes the final copy signal fields to the injected diagnosis repository method", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const applyPublicationDiagnosisForContentItem = vi.spyOn(
      repository,
      "applyPublicationDiagnosisForContentItem",
    );
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });

    const response = await handler(
      new Request("http://localhost/api/content/final-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline: "Titular final verificable",
          body: "Cuerpo final verificable.",
          cta: "Escribe AGENDA por WhatsApp",
          hashtags: ["#FinalUno", "#FinalDos"],
        }),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );

    expect(response.status).toBe(201);
    expect(applyPublicationDiagnosisForContentItem).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        headline: "Titular final verificable",
        body: "Cuerpo final verificable.",
        cta: "Escribe AGENDA por WhatsApp",
        hashtags: ["#FinalUno", "#FinalDos"],
      }),
    );
    expect(applyPublicationDiagnosisForContentItem.mock.calls[0]?.[1]).not.toHaveProperty(
      "humanDescription",
    );
  });

  it("returns conflict without diagnosis when repository final copy validation fails", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    const submitFinalCopyForReview = vi.spyOn(repository, "submitFinalCopyForReview");
    const applyPublicationDiagnosisForContentItem = vi.spyOn(
      repository,
      "applyPublicationDiagnosisForContentItem",
    );
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
    expect(submitFinalCopyForReview).toHaveBeenCalledTimes(1);
    expect(applyPublicationDiagnosisForContentItem).not.toHaveBeenCalled();
  });

  it("logs a diagnosis failure and still returns 201 after the final copy was saved", async () => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    vi.spyOn(repository, "applyPublicationDiagnosisForContentItem").mockRejectedValue(
      new Error("diagnosis unavailable"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });

    try {
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
      expect(consoleError).toHaveBeenCalledWith(
        JSON.stringify({
          message: "publication diagnosis failed",
          contentItemId: item.id,
          error: "Error: diagnosis unavailable",
        }),
      );
      expect((await repository.getContentRecord(item.id))?.content.state).toBe("REVIEW");
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    [
      "publication_targets",
      new Error("Unable to read publication targets for diagnosis."),
    ],
    [
      "RPC apply_publication_diagnosis",
      new Error("Unable to apply publication diagnosis for target target-id."),
    ],
  ])("logs a propagated Supabase %s diagnosis error without changing the 201 boundary", async (_source, error) => {
    const repository = createDemoRepository();
    const item = await repository.createContentItem(campaign);
    vi.spyOn(repository, "applyPublicationDiagnosisForContentItem").mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createFinalCopySubmissionHandler({
      getRepository: async () => repository,
    });

    try {
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
      expect(consoleError).toHaveBeenCalledWith(
        JSON.stringify({
          message: "publication diagnosis failed",
          contentItemId: item.id,
          error: String(error),
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
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
