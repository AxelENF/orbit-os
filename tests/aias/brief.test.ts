import { describe, expect, it } from "vitest";

import {
  aiasOrganizationProfileSchema,
  type AiasOrganizationProfile,
} from "@/lib/aias/contracts";
import { buildAiasPromptContext } from "@/lib/aias/brief";

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
  forbiddenClaims: ["No prometer resultados médicos garantizados."],
  defaultCta: "Agenda una valoración",
  timezone: "America/Mexico_City",
  workflowPreferences: {
    enabledWorkflows: ["copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  },
};

describe("AIAS organization profile", () => {
  it("accepts a complete customer profile", () => {
    expect(aiasOrganizationProfileSchema.parse(profile)).toMatchObject(profile);
  });

  it("rejects a profile without business identity or commercial context", () => {
    expect(() =>
      aiasOrganizationProfileSchema.parse({
        ...profile,
        businessName: "",
        offerings: [],
      }),
    ).toThrow();
  });

  it("builds prompt context from the organization instead of a SnapGad default pitch", () => {
    const context = buildAiasPromptContext(profile);

    expect(context).toContain("Clínica Aurora");
    expect(context).toContain("Pierden solicitudes cuando no responden rápido.");
    expect(context).toContain("No prometer resultados médicos garantizados.");
    expect(context).not.toContain("SnapGad Technology");
  });
});
