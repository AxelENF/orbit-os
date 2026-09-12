import type { AiasOrganizationProfile } from "@/lib/aias/contracts";

export type AiasContentDefaults = {
  businessLine: string;
  service: string;
  niche: string;
  cta: string;
  humanDescription: string;
  allowedFacts: string[];
  forbiddenClaims: string[];
};

/**
 * Produces editable suggestions only. It deliberately does not manufacture a
 * commercial result, a metric, or a claim from the organization's profile.
 */
export function buildAiasContentDefaults(
  profile: AiasOrganizationProfile,
): AiasContentDefaults {
  const painPoint = profile.painPoints[0]?.trim();
  const humanDescription = painPoint
    ? `Dirigido a ${profile.idealCustomer}. Enfocado en: ${painPoint}`
    : `Dirigido a ${profile.idealCustomer}.`;

  return {
    businessLine: profile.industry,
    service: profile.offerings[0] ?? "",
    niche: profile.subIndustry ?? profile.industry,
    cta: profile.defaultCta,
    humanDescription,
    allowedFacts: [...profile.proofPoints],
    forbiddenClaims: [...profile.forbiddenClaims],
  };
}
