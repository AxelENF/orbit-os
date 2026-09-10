import { z } from "zod";

import {
  aiasOrganizationProfileSchema,
  aiasPlatformSchema,
  type AiasOrganizationProfile,
  type AiasPlatform,
} from "@/lib/aias/contracts";

const requiredText = z.string().trim().min(1);

/** A platform-neutral description of the material being diagnosed. */
export const publicationSignalSchema = z
  .object({
    description: requiredText.max(6_000),
    visibleText: requiredText.max(6_000).optional(),
    altText: requiredText.max(1_000).optional(),
    caption: requiredText.max(6_000).optional(),
  })
  .passthrough();

export type PublicationSignal = z.infer<typeof publicationSignalSchema>;

const signalInputSchema = z.union([requiredText.max(6_000), publicationSignalSchema]);

/**
 * Input contract for a deterministic diagnosis. `publication`, `asset`, and
 * top-level `description` are accepted as migration-friendly aliases for
 * `signal`; only one signal source is needed.
 */
export const publicationDiagnosisInputSchema = z
  .object({
    profile: aiasOrganizationProfileSchema,
    signal: signalInputSchema.optional(),
    publication: signalInputSchema.optional(),
    asset: signalInputSchema.optional(),
    assetMetadata: signalInputSchema.optional(),
    description: requiredText.max(6_000).optional(),
    humanDescription: requiredText.max(6_000).optional(),
    channel: aiasPlatformSchema.optional(),
    targetPlatform: aiasPlatformSchema.optional(),
    objective: requiredText.max(180).optional(),
    offer: requiredText.max(240).optional(),
    cta: requiredText.max(180).optional(),
    funnelStage: requiredText.max(120).optional(),
    allowedFacts: z.array(requiredText.max(240)).optional(),
    forbiddenClaims: z.array(requiredText.max(240)).optional(),
    campaignBrief: z
      .object({
        objective: requiredText.max(180).optional(),
        offer: requiredText.max(240).optional(),
        cta: requiredText.max(180).optional(),
        allowedFacts: z.array(requiredText.max(240)).optional(),
        forbiddenClaims: z.array(requiredText.max(240)).optional(),
      })
      .passthrough()
      .optional(),
    campaign: z
      .object({
        objective: requiredText.max(180).optional(),
        offer: requiredText.max(240).optional(),
        cta: requiredText.max(180).optional(),
        allowedFacts: z.array(requiredText.max(240)).optional(),
        forbiddenClaims: z.array(requiredText.max(240)).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (value) => {
      const sources = [
        value.signal,
        value.publication,
        value.asset,
        value.assetMetadata,
        value.description,
        value.humanDescription,
      ].filter((source) => source !== undefined && source !== null);
      return sources.length === 1 && Boolean(sources[0]);
    },
    "Se necesita exactamente una fuente de señal o descripción de publicación.",
  );

export type PublicationDiagnosisInput = z.infer<typeof publicationDiagnosisInputSchema>;

export const publicationDiagnosisSeveritySchema = z.enum(["error", "warning", "info"]);
export type PublicationDiagnosisSeverity = z.infer<typeof publicationDiagnosisSeveritySchema>;

export const publicationDiagnosisQualityLevelSchema = z.enum([
  "blocked",
  "needs_review",
  "promising",
]);
export type PublicationDiagnosisQualityLevel = z.infer<
  typeof publicationDiagnosisQualityLevelSchema
>;

export const publicationFindingSchema = z.object({
  code: requiredText,
  severity: publicationDiagnosisSeveritySchema,
  message: requiredText,
  evidence: z.array(requiredText).default([]),
  inferred: z.boolean().default(false),
});

export type PublicationFinding = z.infer<typeof publicationFindingSchema>;

const scoreAdjustmentSchema = z.object({
  code: requiredText,
  points: z.number().int(),
  explanation: requiredText,
});

const evidenceSummarySchema = z.object({
  value: z.string().nullable(),
  inferred: z.boolean(),
  evidence: z.array(requiredText),
});

export const publicationDiagnosisSchema = z.object({
  quality: z.object({
    score: z.number().int().min(0).max(100),
    level: publicationDiagnosisQualityLevelSchema,
    explanation: z.array(requiredText),
    breakdown: z.array(scoreAdjustmentSchema),
  }),
  score: z.number().int().min(0).max(100),
  qualityLevel: publicationDiagnosisQualityLevelSchema,
  findings: z.array(publicationFindingSchema),
  painOpportunity: z.object({
    pain: z.string().nullable(),
    opportunity: z.string().nullable(),
    inferred: z.boolean(),
    painInferred: z.boolean(),
    opportunityInferred: z.boolean(),
    evidence: z.array(requiredText),
  }),
  audience: evidenceSummarySchema.extend({ niche: z.string().nullable() }),
  audienceNiche: evidenceSummarySchema,
  angle: z.object({
    proposal: z.string().nullable(),
    rationale: requiredText,
    inferred: z.boolean(),
    evidence: z.array(requiredText),
  }),
  ctaSuggestion: z.string().nullable(),
  claims: z.object({
    allowed: z.array(requiredText),
    blocked: z.array(requiredText),
  }),
  allowedClaims: z.array(requiredText),
  blockedClaims: z.array(requiredText),
  recommendations: z.array(requiredText),
  readyForCopy: z.boolean(),
  context: z.object({
    channel: aiasPlatformSchema.nullable(),
    objective: z.string().nullable(),
  }),
});

export type PublicationDiagnosis = z.infer<typeof publicationDiagnosisSchema>;

type UnknownRecord = Record<string, unknown>;

type NormalizedSignal = {
  description: string;
  visibleText: string;
  altText: string;
  caption: string;
  combinedText: string;
};

type ParsedProfile = {
  profile: AiasOrganizationProfile | null;
  valid: boolean;
};

const unsafeClaimPattern =
  /(?:\b(?:duplica|triplica|garantiza|garantizado|asegurado|l[ií]der(?:es)?|n[úu]mero\s*1)\b|#1\b|\b(?:hoy|ahora(?: mismo)?)\b|\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s*(?:horas?|d[ií]as?|semanas?)\b)/i;

const callToActionPattern =
  /(?:^|[.!?\n]|\b(?:cta|llamada\s+a\s+la\s+acci[oó]n)\s*[:\-])\s*(?:agenda|agendar|escribe|cotiza|solicita|reserva|cont[aá]ctanos|contacta|env[ií]a|m[aá]ndanos|compra|prueba|reg[ií]strate)\b/i;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeForComparison(value: string): string {
  return value.toLocaleLowerCase("es-MX").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasConfiguredCallToAction(value: string, cta: string): boolean {
  const escapedCta = escapeRegExp(cta.trim());
  if (!escapedCta) return false;
  return new RegExp(
    `(?:^|[.!?\\n]|\\b(?:cta|llamada\\s+a\\s+la\\s+acci[oó]n)\\s*[:\\-])\\s*${escapedCta}(?=$|[\\s.!?\\n])`,
    "i",
  ).test(value);
}

function normalizeSignal(value: unknown): NormalizedSignal | null {
  if (typeof value === "string") {
    const description = text(value);
    return description
      ? { description, visibleText: "", altText: "", caption: "", combinedText: description }
      : null;
  }

  if (!isRecord(value)) return null;

  // `description` is intentionally required for object signals. Do not let
  // an undocumented alias such as `summary` bypass the input schema.
  const description = text(value.description);
  const visibleText = text(value.visibleText ?? value.textOnImage ?? value.overlayText);
  const altText = text(value.altText ?? value.imageAltText);
  const caption = text(value.caption ?? value.postText ?? value.copy);
  const combinedText = [description, visibleText, altText, caption].filter(Boolean).join(" ").trim();

  return description || combinedText
    ? { description: description || combinedText, visibleText, altText, caption, combinedText }
    : null;
}

function getSignal(input: UnknownRecord): NormalizedSignal | null {
  const sources = [
    input.signal,
    input.publication,
    input.asset,
    input.assetMetadata,
    input.description,
    input.humanDescription,
  ].filter((source) => source !== undefined && source !== null);
  if (sources.length !== 1) return null;
  return normalizeSignal(sources[0]);
}

function parseProfile(input: unknown): ParsedProfile {
  const parsed = aiasOrganizationProfileSchema.safeParse(input);
  return { profile: parsed.success ? parsed.data : null, valid: parsed.success };
}

function inputRecord(input: unknown): UnknownRecord {
  return isRecord(input) ? input : {};
}

function addFinding(
  findings: PublicationFinding[],
  code: string,
  severity: PublicationDiagnosisSeverity,
  message: string,
  evidence: string[] = [],
  inferred = false,
): void {
  findings.push({ code, severity, message, evidence: unique(evidence), inferred });
}

function findInvalidProfileMessages(input: unknown): string[] {
  const parsed = aiasOrganizationProfileSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function getChannel(input: UnknownRecord): AiasPlatform | null {
  if (hasChannelConflict(input)) return null;
  const candidate = input.channel ?? input.targetPlatform;
  return aiasPlatformSchema.safeParse(candidate).success
    ? (candidate as AiasPlatform)
    : null;
}

function hasChannelConflict(input: UnknownRecord): boolean {
  const channel = aiasPlatformSchema.safeParse(input.channel);
  const targetPlatform = aiasPlatformSchema.safeParse(input.targetPlatform);
  return channel.success && targetPlatform.success && channel.data !== targetPlatform.data;
}

type CampaignContext = {
  objective: string | null;
  cta: string | null;
  allowed: string[];
  blocked: string[];
  conflictingFields: string[];
};

function campaignSources(input: UnknownRecord): UnknownRecord[] {
  return [input.campaignBrief, input.campaign].filter(isRecord);
}

function mergedCampaignScalar(
  input: UnknownRecord,
  field: "objective" | "offer" | "cta",
): { value: string | null; conflict: boolean } {
  const values = [
    ...campaignSources(input).map((source) => text(source[field])),
    text(input[field]),
  ].filter(Boolean);
  const distinct = unique(values);
  return { value: distinct.length === 1 ? distinct[0]! : null, conflict: distinct.length > 1 };
}

function getCampaignContext(input: UnknownRecord): CampaignContext {
  const objective = mergedCampaignScalar(input, "objective");
  const offer = mergedCampaignScalar(input, "offer");
  const cta = mergedCampaignScalar(input, "cta");
  const allowed = [
    input.allowedFacts,
    ...campaignSources(input).map((source) => source.allowedFacts),
  ].flatMap((values) => (Array.isArray(values) ? values.map(text) : []));
  const blocked = [
    input.forbiddenClaims,
    ...campaignSources(input).map((source) => source.forbiddenClaims),
  ].flatMap((values) => (Array.isArray(values) ? values.map(text) : []));

  return {
    objective: objective.value,
    cta: cta.value,
    allowed: unique(allowed),
    blocked: unique(blocked),
    conflictingFields: [
      objective.conflict ? "objective" : null,
      offer.conflict ? "offer" : null,
      cta.conflict ? "cta" : null,
    ].filter((field): field is string => Boolean(field)),
  };
}

function buildEmptyDiagnosis(
  findings: PublicationFinding[],
  recommendations: string[],
  objective: string | null,
  channel: AiasPlatform | null,
): PublicationDiagnosis {
  const explanation = ["No hay suficiente información validada para recomendar copy."];
  const claims = { allowed: [], blocked: [] };
  return {
    quality: { score: 0, level: "blocked", explanation, breakdown: [] },
    score: 0,
    qualityLevel: "blocked",
    findings,
    painOpportunity: {
      pain: null,
      opportunity: null,
      inferred: false,
      painInferred: false,
      opportunityInferred: false,
      evidence: [],
    },
    audience: { value: null, niche: null, inferred: false, evidence: [] },
    audienceNiche: { value: null, inferred: false, evidence: [] },
    angle: {
      proposal: null,
      rationale: "El ángulo queda pendiente hasta validar el perfil y la señal.",
      inferred: false,
      evidence: [],
    },
    ctaSuggestion: null,
    claims,
    allowedClaims: claims.allowed,
    blockedClaims: claims.blocked,
    recommendations: unique(recommendations),
    readyForCopy: false,
    context: { channel, objective },
  };
}

function qualityLevel(score: number, hasError: boolean): PublicationDiagnosisQualityLevel {
  if (hasError || score < 55) return "blocked";
  if (score < 80) return "needs_review";
  return "promising";
}

/**
 * Diagnoses a publication signal without network calls, model calls, copy
 * generation, or side effects. It returns a blocked diagnosis instead of
 * throwing when profile or signal data is incomplete.
 */
export function diagnosePublication(input: unknown): PublicationDiagnosis {
  const record = inputRecord(input);
  const inputValidation = publicationDiagnosisInputSchema.safeParse(input);
  const parsedProfile = parseProfile(record.profile);
  const signal = getSignal(record);
  const channel = getChannel(record);
  const campaignContext = getCampaignContext(record);
  const objective = campaignContext.objective;
  const channelConflict = hasChannelConflict(record);
  const findings: PublicationFinding[] = [];
  const recommendations: string[] = [];

  if (!parsedProfile.valid) {
    const profileMessages = findInvalidProfileMessages(record.profile);
    addFinding(
      findings,
      "profile_invalid",
      "error",
      "El perfil AIAS no contiene todos los datos críticos requeridos.",
      profileMessages,
    );
    recommendations.push("Completar y validar el perfil AIAS antes de diagnosticar la publicación.");
  }

  if (!signal) {
    addFinding(
      findings,
      "signal_missing",
      "error",
      "Falta una descripción verificable de la imagen o publicación.",
    );
    recommendations.push("Agregar una descripción humana de la imagen o publicación.");
  }

  if (!inputValidation.success) {
    addFinding(
      findings,
      "input_invalid",
      "error",
      "La entrada del diagnóstico no cumple el contrato AIAS.",
      inputValidation.error.issues.map((issue) => issue.message),
    );
    recommendations.push("Corregir la entrada y volver a validar antes de continuar.");
  }

  if (!parsedProfile.profile || !signal || !inputValidation.success) {
    return buildEmptyDiagnosis(findings, recommendations, objective, channel);
  }

  const profile = parsedProfile.profile;
  if (campaignContext.conflictingFields.length) {
    addFinding(
      findings,
      "campaign_conflict",
      "error",
      "Las fuentes de campaña contienen valores escalares incompatibles.",
      campaignContext.conflictingFields,
    );
    recommendations.push("Resolver los valores de campaña incompatibles antes de generar copy.");
  }

  if (channelConflict) {
    addFinding(
      findings,
      "channel_conflict",
      "error",
      "El canal y la plataforma objetivo contienen valores incompatibles.",
      [String(record.channel), String(record.targetPlatform)],
    );
    recommendations.push("Conservar un único canal objetivo antes de generar copy.");
  }

  // Offerings provide context for the angle; only explicit proof points are
  // treated as claims that may be asserted in a future copy draft.
  const candidateAllowedClaims = unique([...profile.proofPoints, ...campaignContext.allowed]);
  const blockedClaims = unique([...profile.forbiddenClaims, ...campaignContext.blocked]);
  const normalizeClaim = (claim: string) => claim.toLocaleLowerCase("es-MX").replace(/\s+/g, " ").trim();
  const blockedClaimKeys = new Set(blockedClaims.map(normalizeClaim));
  const conflictingClaims = candidateAllowedClaims.filter((claim) => blockedClaimKeys.has(normalizeClaim(claim)));
  const allowedClaims = candidateAllowedClaims.filter((claim) => !blockedClaimKeys.has(normalizeClaim(claim)));
  const breakdown: Array<z.infer<typeof scoreAdjustmentSchema>> = [
    { code: "base", points: 100, explanation: "Perfil y señal validados." },
  ];
  let score = 100;
  const combinedText = normalizeForComparison(signal.combinedText);

  if (campaignContext.conflictingFields.length) {
    score -= 30;
    breakdown.push({
      code: "campaign_conflict",
      points: -30,
      explanation: "Las fuentes incompatibles no pueden sostener un diagnóstico seguro.",
    });
  }
  if (channelConflict) {
    score -= 30;
    breakdown.push({
      code: "channel_conflict",
      points: -30,
      explanation: "Las plataformas incompatibles no pueden sostener un diagnóstico seguro.",
    });
  }

  if (conflictingClaims.length) {
    addFinding(
      findings,
      "claim_conflict",
      "error",
      "Un claim aparece simultáneamente como permitido y bloqueado.",
      conflictingClaims,
    );
    score -= 35;
    breakdown.push({
      code: "claim_conflict",
      points: -35,
      explanation: "Eliminar el conflicto del perfil antes de generar copy.",
    });
    recommendations.push("Resolver los claims que aparecen a la vez en listas permitidas y bloqueadas.");
  }

  const matchingForbiddenClaims = blockedClaims.filter((claim) =>
    combinedText.includes(normalizeForComparison(claim)),
  );
  if (matchingForbiddenClaims.length) {
    addFinding(
      findings,
      "forbidden_claim",
      "error",
      "La señal contiene una afirmación bloqueada por el perfil AIAS.",
      matchingForbiddenClaims,
    );
    score -= 35;
    breakdown.push({
      code: "forbidden_claim",
      points: -35,
      explanation: "Retirar las afirmaciones bloqueadas antes de generar copy.",
    });
    recommendations.push("Retirar o respaldar con evidencia aprobada la afirmación bloqueada.");
  }

  if (unsafeClaimPattern.test(signal.combinedText)) {
    addFinding(
      findings,
      "unsupported_claim",
      "error",
      "La señal contiene una promesa cuantificada o absoluta que requiere evidencia explícita.",
    );
    score -= 30;
    breakdown.push({
      code: "unsupported_claim",
      points: -30,
      explanation: "No usar promesas cuantificadas o absolutas sin un hecho permitido.",
    });
    recommendations.push("Sustituir la promesa no verificable por un hecho permitido por el perfil.");
  }

  const ctaSuggestion = (campaignContext.cta ?? profile.defaultCta) || null;
  const hasConfiguredCta = Boolean(
    ctaSuggestion && hasConfiguredCallToAction(signal.combinedText, ctaSuggestion),
  );
  const hasCta = campaignContext.cta !== null
    ? hasConfiguredCta
    : hasConfiguredCta || callToActionPattern.test(signal.combinedText);
  if (!hasCta) {
    addFinding(
      findings,
      "cta_missing",
      "warning",
      "La señal no muestra una llamada a la acción verificable.",
      ctaSuggestion ? [ctaSuggestion] : [],
    );
    score -= 10;
    breakdown.push({
      code: "cta_missing",
      points: -10,
      explanation: "Añadir el CTA derivado del perfil antes de la revisión humana.",
    });
    recommendations.push(`Añadir el CTA del perfil: ${ctaSuggestion ?? profile.defaultCta}.`);
  }

  const pain = profile.painPoints[0] ?? null;
  const painEvidence = pain ? ["profile.painPoints"] : [];
  if (!pain) {
    addFinding(
      findings,
      "pain_missing",
      "warning",
      "El perfil no declara un dolor principal verificable.",
    );
    score -= 10;
    breakdown.push({
      code: "pain_missing",
      points: -10,
      explanation: "Documentar un dolor del cliente antes de convertirlo en ángulo.",
    });
    recommendations.push("Documentar un dolor concreto del cliente con lenguaje verificable.");
  }

  if (!profile.proofPoints.length) {
    addFinding(
      findings,
      "proof_missing",
      "warning",
      "El perfil no declara una prueba permitida para respaldar el mensaje.",
    );
    score -= 10;
    breakdown.push({
      code: "proof_missing",
      points: -10,
      explanation: "Añadir una prueba verificable sin inventar resultados.",
    });
    recommendations.push("Añadir una prueba verificable del negocio o mantener el mensaje descriptivo.");
  }

  if (!channel && !channelConflict) {
    addFinding(
      findings,
      "channel_unspecified",
      "info",
      "No se especificó canal; la adaptación de formato queda pendiente.",
    );
  }
  if (!objective) {
    addFinding(
      findings,
      "objective_unspecified",
      "info",
      "No se especificó objetivo; validar la intención comercial antes del copy.",
    );
  }

  const audienceValue = profile.idealCustomer || null;
  const nicheValue = profile.subIndustry || profile.industry || null;
  const audienceEvidence = ["profile.idealCustomer"];
  const nicheEvidence = [profile.subIndustry ? "profile.subIndustry" : "profile.industry"];
  const opportunity = profile.offerings[0]
    ? `Presentar ${profile.offerings[0]} para ${profile.idealCustomer}.`
    : null;
  const opportunityEvidence = profile.offerings.length ? ["profile.offerings", "profile.idealCustomer"] : [];
  const angleProposal = profile.offerings[0]
    ? pain
      ? `Enfocar ${profile.offerings[0]} como respuesta al dolor declarado: ${pain}`
      : `Presentar ${profile.offerings[0]} para ${profile.idealCustomer} y validar el dolor antes de prometer resultados.`
    : null;
  const angleEvidence = ["profile.offerings", "profile.idealCustomer", ...(pain ? ["profile.painPoints"] : [])];
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  const hasError = findings.some((finding) => finding.severity === "error");
  const level = qualityLevel(finalScore, hasError);

  const explanations = [
    `Puntuación base: 100 por perfil y señal válidos.`,
    ...breakdown
      .filter((entry) => entry.code !== "base")
      .map((entry) => `${entry.points} puntos: ${entry.explanation}`),
  ];
  recommendations.push("Mantener la revisión humana antes de generar copy o publicar.");

  const claims = { allowed: allowedClaims, blocked: blockedClaims };
  return publicationDiagnosisSchema.parse({
    quality: { score: finalScore, level, explanation: explanations, breakdown },
    score: finalScore,
    qualityLevel: level,
    findings,
    painOpportunity: {
      pain,
      opportunity,
      inferred: Boolean(opportunity),
      painInferred: false,
      opportunityInferred: Boolean(opportunity),
      evidence: unique([...painEvidence, ...opportunityEvidence]),
    },
    audience: {
      value: audienceValue,
      niche: nicheValue,
      inferred: false,
      evidence: unique([...audienceEvidence, ...nicheEvidence]),
    },
    audienceNiche: { value: nicheValue, inferred: false, evidence: nicheEvidence },
    angle: {
      proposal: angleProposal,
      rationale: "El ángulo es una propuesta derivada únicamente de campos explícitos del perfil.",
      inferred: true,
      evidence: angleEvidence,
    },
    ctaSuggestion,
    claims,
    allowedClaims: claims.allowed,
    blockedClaims: claims.blocked,
    recommendations: unique(recommendations),
    readyForCopy:
      !hasError &&
      finalScore >= 70 &&
      Boolean(pain) &&
      profile.proofPoints.length > 0 &&
      hasCta,
    context: { channel, objective },
  });
}
