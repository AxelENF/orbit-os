import { z } from "zod";

import { contentBriefSchema } from "@/lib/content/contracts";

const requiredText = z.string().trim().min(1);

export const funnelStageSchema = z.enum([
  "descubrimiento",
  "consideracion",
  "captacion",
  "reactivacion",
]);

export const destinationSchema = z.enum(["whatsapp", "landing_page", "lead_form"]);

export const campaignBriefSchema = contentBriefSchema.extend({
  campaignName: requiredText.max(96),
  offer: requiredText.max(180),
  funnelStage: funnelStageSchema,
  destination: destinationSchema,
  destinationValue: z.url().max(2048),
  forbiddenClaims: z.array(requiredText).default([]),
});

export type CampaignBrief = z.infer<typeof campaignBriefSchema>;
export type CampaignFunnelStage = z.infer<typeof funnelStageSchema>;
export type CampaignDestination = z.infer<typeof destinationSchema>;

export function validateCampaignBrief(input: unknown): CampaignBrief {
  return campaignBriefSchema.parse(input);
}

function compactCodePart(value: string, maxLength: number): string {
  const compact = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .split(/[^A-Z0-9]+/)[0]
    ?.replace(/[^A-Z0-9]+/g, "")
    .slice(0, maxLength);

  return compact || "CAMPAIGN";
}

function compactIdentifier(value: string, maxLength: number): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, maxLength) || "ITEM"
  );
}

/**
 * Stable identifiers make WhatsApp and Meta outcomes attributable without
 * exposing user identifiers in a public campaign URL.
 */
export function buildCampaignCode(
  campaignName: string,
  contentItemId: string,
  createdAt = new Date(),
): string {
  const date = createdAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `SG-${compactCodePart(campaignName, 12)}-${date}-${compactIdentifier(contentItemId, 8)}`;
}
