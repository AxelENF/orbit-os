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
  it("accepts a brief with controlled taxonomy and approved facts", () => {
    expect(parseContentBrief(validBrief)).toEqual(validBrief);
  });

  it.each([
    ["business line", { ...validBrief, businessLine: "VENDER" }],
    ["service", { ...validBrief, service: "seo" }],
    ["niche", { ...validBrief, niche: "restaurantes" }],
    ["content type", { ...validBrief, contentType: "meme" }],
    ["objective", { ...validBrief, objective: "viralidad" }],
    ["format", { ...validBrief, format: "story_9_16" }],
  ])("rejects an unsupported %s", (_field, invalidBrief) => {
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
