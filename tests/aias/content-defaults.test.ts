import { describe, expect, it } from "vitest";

import { buildAiasContentDefaults } from "@/lib/aias/content-defaults";
import type { AiasOrganizationProfile } from "@/lib/aias/contracts";

const profile: AiasOrganizationProfile = {
  businessName: "Clínica Aurora",
  industry: "Salud privada",
  subIndustry: "Clínicas dentales",
  locations: ["Puebla"],
  offerings: ["Agenda y atención por WhatsApp", "Recordatorios de cita"],
  idealCustomer: "Personas que buscan atención dental cerca de casa",
  painPoints: ["Las solicitudes se pierden cuando nadie responde a tiempo"],
  proofPoints: ["El equipo recibe solicitudes por WhatsApp", "Se pueden confirmar citas"],
  tone: "Claro y profesional",
  forbiddenClaims: ["Resultados médicos garantizados"],
  defaultCta: "Escribe para agendar",
  timezone: "America/Mexico_City",
  workflowPreferences: {
    enabledWorkflows: ["copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  },
};

describe("buildAiasContentDefaults", () => {
  it("turns a tenant profile into editable content suggestions without SnapGad defaults", () => {
    expect(buildAiasContentDefaults(profile)).toEqual({
      businessLine: "Salud privada",
      service: "Agenda y atención por WhatsApp",
      niche: "Clínicas dentales",
      cta: "Escribe para agendar",
      humanDescription: "Dirigido a Personas que buscan atención dental cerca de casa. Enfocado en: Las solicitudes se pierden cuando nadie responde a tiempo",
      allowedFacts: ["El equipo recibe solicitudes por WhatsApp", "Se pueden confirmar citas"],
      forbiddenClaims: ["Resultados médicos garantizados"],
    });
  });
});
