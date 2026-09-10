import { describe, expect, it } from "vitest";

import type { AiasOrganizationProfile } from "@/lib/aias/contracts";
import { diagnosePublication } from "@/lib/aias/publication-diagnosis";

const profile: AiasOrganizationProfile = {
  businessName: "Clínica Aurora",
  industry: "Salud",
  subIndustry: "Clínica dermatológica",
  locations: ["Puebla"],
  offerings: ["Consultas dermatológicas", "Tratamientos faciales"],
  idealCustomer: "Personas que buscan atención dermatológica confiable.",
  painPoints: ["Pierden solicitudes cuando no responden rápido."],
  proofPoints: ["Atención por WhatsApp y agenda digital."],
  tone: "profesional, tranquilo",
  forbiddenClaims: ["Resultados médicos garantizados"],
  defaultCta: "Agenda una valoración",
  timezone: "America/Mexico_City",
  workflowPreferences: {
    enabledWorkflows: ["asset_diagnosis", "copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  },
};

describe("AIAS publication diagnosis", () => {
  it("returns an explainable, profile-grounded diagnosis for a usable signal", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Imagen de una consulta dermatológica en un consultorio luminoso.",
        visibleText: "Atención dermatológica por WhatsApp en Puebla. Agenda una valoración.",
        altText: "Consulta dermatológica en Clínica Aurora.",
      },
      channel: "facebook",
      objective: "captar consultas",
    });

    expect(diagnosis.quality.score).toBeGreaterThanOrEqual(70);
    expect(diagnosis.quality.explanation.length).toBeGreaterThan(0);
    expect(diagnosis.findings.every((finding) => ["error", "warning", "info"].includes(finding.severity))).toBe(true);
    expect(diagnosis.painOpportunity.pain).toBe(profile.painPoints[0]);
    expect(diagnosis.audience.value).toBe(profile.idealCustomer);
    expect(diagnosis.audience.inferred).toBe(false);
    expect(diagnosis.angle.inferred).toBe(true);
    expect(diagnosis.ctaSuggestion).toBe(profile.defaultCta);
    expect(diagnosis.claims.allowed).toContain(profile.proofPoints[0]);
    expect(diagnosis.claims.blocked).toContain(profile.forbiddenClaims[0]);
    expect(diagnosis.readyForCopy).toBe(true);
    expect(diagnosis.recommendations.length).toBeGreaterThan(0);
    expect(diagnosis.recommendations.join(" ")).toContain("revisión humana");
  });

  it("fails safe with errors and no copy readiness when critical data is missing", () => {
    const diagnosis = diagnosePublication({
      profile: {
        businessName: "",
        industry: "",
        offerings: [],
        idealCustomer: "",
        tone: "",
        defaultCta: "",
        timezone: "Not/AZone",
      },
      signal: { description: "" },
    });

    expect(diagnosis.readyForCopy).toBe(false);
    expect(diagnosis.quality.score).toBe(0);
    expect(diagnosis.findings.some((finding) => finding.severity === "error")).toBe(true);
    expect(diagnosis.ctaSuggestion).toBeNull();
    expect(diagnosis.claims.allowed).toEqual([]);
    expect(diagnosis.claims.blocked).toEqual([]);
  });

  it("blocks a signal that repeats a forbidden claim", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Una publicación que dice: resultados médicos garantizados.",
        visibleText: "Resultados médicos garantizados para cada persona.",
      },
    });

    expect(diagnosis.readyForCopy).toBe(false);
    expect(diagnosis.claims.blocked).toContain(profile.forbiddenClaims[0]);
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "forbidden_claim", severity: "error" }),
      ]),
    );
  });

  it("fails closed when a claim is both allowed and forbidden", () => {
    const diagnosis = diagnosePublication({
      profile: {
        ...profile,
        proofPoints: ["Atención por WhatsApp"],
        forbiddenClaims: ["atención por whatsapp"],
      },
      signal: {
        description: "Publicación informativa sobre atención dermatológica.",
        visibleText: "Agenda una valoración.",
      },
    });

    expect(diagnosis.claims.allowed).not.toContain("Atención por WhatsApp");
    expect(diagnosis.claims.blocked).toContain("atención por whatsapp");
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "claim_conflict", severity: "error" }),
      ]),
    );
    expect(diagnosis.readyForCopy).toBe(false);
  });

  it("flags a missing publication CTA while preserving the profile CTA suggestion", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Una pieza sobre consultas dermatológicas en Puebla.",
        visibleText: "Consultas dermatológicas en Puebla.",
      },
    });

    expect(diagnosis.ctaSuggestion).toBe(profile.defaultCta);
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cta_missing", severity: "warning" }),
      ]),
    );
    expect(diagnosis.recommendations.some((recommendation) => recommendation.includes(profile.defaultCta))).toBe(true);
  });

  it("does not mark a score of 70 as ready when pain, proof, and CTA are missing", () => {
    const diagnosis = diagnosePublication({
      profile: {
        ...profile,
        painPoints: [],
        proofPoints: [],
      },
      signal: {
        description: "Una pieza sobre consultas dermatológicas en Puebla.",
        visibleText: "Consultas dermatológicas en Puebla.",
      },
    });

    expect(diagnosis.quality.score).toBe(70);
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "pain_missing", severity: "warning" }),
        expect.objectContaining({ code: "proof_missing", severity: "warning" }),
        expect.objectContaining({ code: "cta_missing", severity: "warning" }),
      ]),
    );
    expect(diagnosis.readyForCopy).toBe(false);
  });

  it("rejects a signal object without description instead of bypassing the input contract", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: { summary: "Una foto del consultorio." },
    });

    expect(diagnosis.readyForCopy).toBe(false);
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "signal_missing", severity: "error" }),
        expect.objectContaining({ code: "input_invalid", severity: "error" }),
      ]),
    );
  });

  it("rejects multiple signal aliases instead of taking the first one", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Agenda una valoración.",
      },
      publication: {
        description: "Agenda una valoración distinta.",
      },
    });

    expect(diagnosis.quality.score).toBe(0);
    expect(diagnosis.readyForCopy).toBe(false);
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "input_invalid", severity: "error" }),
      ]),
    );
  });

  it("merges campaign sources conservatively and prefers the specific campaign CTA", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Una publicación sobre consultas dermatológicas.",
        visibleText: "Escribe PIEL para agendar.",
      },
      campaignBrief: {
        allowedFacts: ["Agenda digital"],
        cta: "Escribe PIEL",
      },
      campaign: {
        allowedFacts: ["Atención por WhatsApp"],
        forbiddenClaims: ["Resultados inmediatos"],
        objective: "captar consultas",
      },
    });

    expect(diagnosis.ctaSuggestion).toBe("Escribe PIEL");
    expect(diagnosis.claims.allowed).toEqual(expect.arrayContaining(["Agenda digital", "Atención por WhatsApp"]));
    expect(diagnosis.claims.blocked).toContain("Resultados inmediatos");
    expect(diagnosis.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "input_invalid" })]),
    );
  });

  it("does not let a generic CTA bypass an authoritative campaign CTA", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Una publicación sobre consultas dermatológicas.",
        visibleText: "Agenda una valoración.",
      },
      campaign: {
        cta: "Escribe PIEL",
      },
    });

    expect(diagnosis.ctaSuggestion).toBe("Escribe PIEL");
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cta_missing", severity: "warning" }),
      ]),
    );
    expect(diagnosis.readyForCopy).toBe(false);
    expect(diagnosis.recommendations).toContain("Añadir el CTA del perfil: Escribe PIEL.");
  });

  it("blocks conflicting channel aliases instead of taking the first one", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Una publicación sobre consultas dermatológicas.",
        visibleText: "Agenda una valoración.",
      },
      channel: "facebook",
      targetPlatform: "instagram",
    });

    expect(diagnosis.readyForCopy).toBe(false);
    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "channel_conflict", severity: "error" }),
      ]),
    );
  });

  it("does not treat a narrative visit verb as a CTA", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Visita nuestro consultorio para conocer el espacio.",
      },
    });

    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cta_missing", severity: "warning" }),
      ]),
    );
    expect(diagnosis.readyForCopy).toBe(false);
  });

  it("blocks urgency, rankings, percentages, and absolute promises conservatively", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Hoy mismo duplica tus ventas: somos el #1 líder con 40% más resultados.",
        visibleText: "Agenda una valoración.",
      },
    });

    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_claim", severity: "error" }),
      ]),
    );
    expect(diagnosis.readyForCopy).toBe(false);
  });

  it("blocks a percentage claim even without another unsafe keyword", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Obtén 40% más resultados.",
        visibleText: "Agenda una valoración.",
      },
    });

    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_claim", severity: "error" }),
      ]),
    );
  });

  it("detects forbidden claims despite line breaks and repeated whitespace", () => {
    const diagnosis = diagnosePublication({
      profile,
      signal: {
        description: "Resultados\n   médicos    garantizados.",
        visibleText: "Agenda una valoración.",
      },
    });

    expect(diagnosis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "forbidden_claim", severity: "error" }),
      ]),
    );
    expect(diagnosis.readyForCopy).toBe(false);
  });

  it("does not invent a niche, proof, metrics, ROI, testimonials, or urgency", () => {
    const diagnosis = diagnosePublication({
      profile: {
        ...profile,
        idealCustomer: "Personas interesadas en cuidar su piel.",
        painPoints: [],
        proofPoints: [],
      },
      signal: { description: "Foto de un consultorio moderno." },
    });
    const serialized = JSON.stringify(diagnosis).toLocaleLowerCase("es-MX");

    expect(diagnosis.audience.value).toBe("Personas interesadas en cuidar su piel.");
    expect(diagnosis.audience.inferred).toBe(false);
    expect(diagnosis.painOpportunity.pain).toBeNull();
    expect(diagnosis.claims.allowed).toEqual([]);
    expect(serialized).not.toMatch(/\b(?:roi|retorno|testimonio|100%|duplica|triplica|garantiza|hoy mismo)\b/i);
    expect(diagnosis.angle.inferred).toBe(true);
  });
});
