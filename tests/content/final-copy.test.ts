import { describe, expect, it } from "vitest";

import { validateFinalCopy } from "@/lib/content/final-copy";

const baseBrief = {
  allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
  forbiddenClaims: ["Resultados garantizados"],
};

describe("validateFinalCopy — hashtags", () => {
  it("requires headline, body, and cta as before, independent of hashtags", () => {
    const result = validateFinalCopy(
      { headline: "", body: "Texto", cta: "Escribe AGENDA", hashtags: ["#Agenda"] },
      baseBrief,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a hashtag that repeats a forbidden claim, even camelCase and with no spaces", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "El bot atiende preguntas y ayuda a agendar citas.",
        cta: "Escribe AGENDA",
        hashtags: ["#ResultadosGarantizados"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/prohibida/i);
  });

  it("rejects a hashtag with an unsupported absolute promise not grounded in allowedFacts", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "Conoce el servicio disponible para tu negocio.",
        cta: "Escribe AGENDA",
        hashtags: ["#DuplicaTusVentas"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts hashtags grounded in allowedFacts or free of risky claims", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "El bot atiende preguntas y ayuda a agendar citas.",
        cta: "Escribe AGENDA",
        hashtags: ["#AutomatizacionWhatsApp", "#NegociosMexico"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(true);
  });

  it("treats a missing hashtags field as an empty list without throwing", () => {
    const result = validateFinalCopy(
      { headline: "Más control", body: "El bot atiende preguntas y ayuda a agendar citas.", cta: "Escribe AGENDA" },
      baseBrief,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a final hashtag without its # prefix", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "El bot atiende preguntas y ayuda a agendar citas.",
        cta: "Escribe AGENDA",
        hashtags: ["AutomatizacionWhatsApp"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Cada hashtag debe iniciar con # y no contener espacios.");
  });
});
