import { describe, expect, it } from "vitest";

import { campaignNextAction, campaignTitle } from "@/lib/content/campaign-view";
import type { ContentSummary } from "@/lib/content/repository";

const item = (state: ContentSummary["state"]): ContentSummary => ({
  id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
  state,
  createdAt: "2026-09-08T00:00:00.000Z",
  service: "bot_whatsapp",
  niche: "clinicas",
  contentType: "venta_directa",
  objective: "agenda_demo",
});

describe("campaign view model", () => {
  it("gives each state one plain-language next action", () => {
    expect(campaignNextAction(item("DRAFT"))).toBe("Elegir copy");
    expect(campaignNextAction(item("REVIEW"))).toBe("Revisar publicación");
    expect(campaignNextAction(item("PUBLISHED"))).toBe("Ver resultados");
  });

  it("prefers the human campaign name over technical service labels", () => {
    expect(campaignTitle({ ...item("DRAFT"), campaign: {
      campaignName: "Agenda automática para clínicas",
      offer: "Bot de agenda",
      funnelStage: "consideracion",
      destination: "whatsapp",
      destinationValue: "https://wa.me/1",
      campaignCode: "SG-ABCD1234",
    }})).toBe("Agenda automática para clínicas");
  });
});
