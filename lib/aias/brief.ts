import { z } from "zod";

import {
  aiasOrganizationProfileSchema,
  type AiasOrganizationProfile,
  parseAiasOrganizationProfile,
} from "@/lib/aias/contracts";
import {
  campaignBriefSchema,
  type CampaignBrief,
} from "@/lib/content/campaign";

const requiredText = z.string().trim().min(1);

const campaignBriefPitchOverridesSchema = z.object({
  cta: requiredText.max(180).optional(),
  humanDescription: requiredText.optional(),
  allowedFacts: z.array(requiredText).min(1).optional(),
  forbiddenClaims: z.array(requiredText).optional(),
});

const campaignBriefDraftSchema = campaignBriefSchema
  .omit({ cta: true, humanDescription: true, allowedFacts: true, forbiddenClaims: true })
  .extend(campaignBriefPitchOverridesSchema.shape);

export type CampaignBriefDraft = z.infer<typeof campaignBriefDraftSchema>;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildHumanDescription(profile: AiasOrganizationProfile): string {
  const offeringText = profile.offerings.join(", ");
  const painText = profile.painPoints.length
    ? ` Dolor prioritario: ${profile.painPoints.join("; ")}.`
    : "";
  return `${profile.businessName} ofrece ${offeringText} para ${profile.idealCustomer}.${painText}`;
}

/**
 * Converts the approved organization profile into bounded context for a model
 * prompt. It is deliberately deterministic so the same profile is auditable.
 */
export function buildAiasPromptContext(input: unknown): string {
  const profile = parseAiasOrganizationProfile(input);
  const lines = [
    `Negocio: ${profile.businessName}`,
    `Rubro: ${profile.industry}${profile.subIndustry ? ` / ${profile.subIndustry}` : ""}`,
    `Ubicaciones: ${profile.locations.length ? profile.locations.join(", ") : "No especificadas"}`,
    `Oferta: ${profile.offerings.join("; ")}`,
    `Cliente ideal: ${profile.idealCustomer}`,
    `Dolores: ${profile.painPoints.length ? profile.painPoints.join("; ") : "No especificados"}`,
    `Pruebas permitidas: ${profile.proofPoints.length ? profile.proofPoints.join("; ") : "Ninguna declarada"}`,
    `Tono: ${profile.tone}`,
    `CTA predeterminado: ${profile.defaultCta}`,
    `Afirmaciones prohibidas: ${profile.forbiddenClaims.length ? profile.forbiddenClaims.join("; ") : "Ninguna declarada"}`,
    `Zona horaria: ${profile.timezone}`,
  ];
  return lines.join("\n");
}

/**
 * Completes only the pitch fields owned by the organization profile. Explicit
 * campaign values remain authoritative, while profile restrictions are always
 * inherited so a caller cannot accidentally remove them.
 */
export function resolveCampaignBrief(
  input: unknown,
  profileInput: unknown,
): CampaignBrief {
  const profile = parseAiasOrganizationProfile(profileInput);
  const draft = campaignBriefDraftSchema.parse(input);
  const profileFacts = unique(
    profile.proofPoints.length ? profile.proofPoints : profile.offerings,
  );
  const explicitClaims = draft.forbiddenClaims ?? [];

  return campaignBriefSchema.parse({
    ...draft,
    cta: draft.cta ?? profile.defaultCta,
    humanDescription: draft.humanDescription ?? buildHumanDescription(profile),
    allowedFacts: draft.allowedFacts ?? profileFacts,
    forbiddenClaims: unique([...profile.forbiddenClaims, ...explicitClaims]),
  });
}

export function parseAiasCampaignBrief(input: unknown): CampaignBrief {
  return campaignBriefSchema.parse(input);
}

export { aiasOrganizationProfileSchema };
