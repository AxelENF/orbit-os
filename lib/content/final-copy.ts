import type { CampaignBrief } from "@/lib/content/campaign";

export type FinalCopyInput = {
  headline: string;
  body: string;
  cta: string;
};

export type FinalCopyValidation = {
  ok: boolean;
  reasons: string[];
};

const unsupportedClaimPattern = /(?:\b(?:duplica|triplica|garantiza|garantizado|asegurado|lider(?:es)?|n[úu]mero\s*1|#1)\b|\b(?:hoy|ahora mismo|[0-9]+\s*(?:horas?|d[ií]as?|semanas?))\b|\b[0-9]+(?:[.,][0-9]+)?\s*%)/i;

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isGroundedInAllowedFacts(copy: string, allowedFacts: string[]): boolean {
  const normalizedCopy = normalize(copy).toLocaleLowerCase("es-MX");
  return allowedFacts.some((fact) => {
    const normalizedFact = normalize(fact).toLocaleLowerCase("es-MX");
    return normalizedFact.length > 0 && normalizedCopy.includes(normalizedFact);
  });
}

function containsForbiddenClaim(copy: string, forbiddenClaims: string[]): boolean {
  const normalizedCopy = normalize(copy).toLocaleLowerCase("es-MX");
  return forbiddenClaims.some((claim) => {
    const normalizedClaim = normalize(claim).toLocaleLowerCase("es-MX");
    return normalizedClaim.length > 0 && normalizedCopy.includes(normalizedClaim);
  });
}

/**
 * A deliberately conservative gate: the human can rework a draft, but a
 * campaign cannot move into review until it contains a complete CTA and any
 * result/urgency language has explicit supporting evidence in allowedFacts.
 */
export function validateFinalCopy(
  input: FinalCopyInput,
  brief: Pick<CampaignBrief, "allowedFacts"> &
    Partial<Pick<CampaignBrief, "forbiddenClaims">>,
): FinalCopyValidation {
  const headline = normalize(input.headline);
  const body = normalize(input.body);
  const cta = normalize(input.cta);
  const combined = `${headline} ${body} ${cta}`.trim();
  const reasons: string[] = [];

  if (!headline || !body || !cta) {
    reasons.push("El copy final necesita un mensaje principal, cuerpo y CTA.");
  }

  if (containsForbiddenClaim(combined, brief.forbiddenClaims ?? [])) {
    reasons.push("El copy contiene una afirmación prohibida por el perfil de la organización.");
  }

  if (unsupportedClaimPattern.test(combined) && !isGroundedInAllowedFacts(combined, brief.allowedFacts)) {
    reasons.push(
      "El copy contiene una promesa o urgencia que no está respaldada por los hechos permitidos.",
    );
  }

  return { ok: reasons.length === 0, reasons };
}
