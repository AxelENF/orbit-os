import { describe, expect, it } from "vitest";

import { contentBriefSchema } from "@/lib/content/contracts";
import { parseContentBrief } from "@/lib/content/validation";

const validBrief = {
  businessLine: "CONTROLAR",
  service: "pos",
  niche: "clinicas",
  contentType: "educativo",
  objective: "conversaciones_whatsapp",
  format: "feed_4_5",
  cta: "Escribe POS por WhatsApp",
  humanDescription: "Mostrar el corte de caja de una clínica.",
  allowedFacts: ["El POS registra ventas y cortes de caja."],
};

describe("contentBriefSchema", () => {
  it("accepts a brief with approved facts", () => {
    expect(parseContentBrief(validBrief)).toEqual(validBrief);
  });

  it("accepts tenant-specific commercial taxonomy instead of a SnapGad-only catalog", () => {
    const tenantBrief = {
      ...validBrief,
      businessLine: "Reservaciones y retención",
      service: "Menú digital con pedidos por WhatsApp",
      niche: "Restaurantes de especialidad",
    };

    expect(parseContentBrief(tenantBrief)).toEqual(tenantBrief);
  });

  it.each([
    ["blank business line", { ...validBrief, businessLine: " " }],
    ["oversized service", { ...validBrief, service: "x".repeat(121) }],
    ["oversized niche", { ...validBrief, niche: "x".repeat(121) }],
    ["content type", { ...validBrief, contentType: "meme" }],
    ["objective", { ...validBrief, objective: "viralidad" }],
    ["format", { ...validBrief, format: "story_9_16" }],
  ])("rejects an invalid %s", (_field, invalidBrief) => {
    expect(contentBriefSchema.safeParse(invalidBrief).success).toBe(false);
  });

  it.each([
    ["CTA", { ...validBrief, cta: "   " }],
    ["human description", { ...validBrief, humanDescription: "" }],
    ["missing allowed facts", { ...validBrief, allowedFacts: [] }],
    ["blank allowed fact", { ...validBrief, allowedFacts: ["  "] }],
  ])("rejects a brief with %s", (_caseName, invalidBrief) => {
    expect(contentBriefSchema.safeParse(invalidBrief).success).toBe(false);
  });
});
