import { z } from "zod";

const requiredText = z.string().trim().min(1);

const timeZone = z.string().trim().min(1).refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  },
  "Debe ser una zona horaria IANA soportada.",
);

export const aiasWorkflowSchema = z.enum([
  "asset_diagnosis",
  "copy_generation",
  "publication",
  "retrospective",
]);

export const aiasPlatformSchema = z.enum(["facebook", "instagram"]);

export const publishingWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export const aiasWorkflowPreferencesSchema = z.object({
  enabledWorkflows: z.array(aiasWorkflowSchema).min(1).default(["copy_generation"]),
  approvalRequired: z.boolean().default(true),
  defaultPlatforms: z.array(aiasPlatformSchema).min(1).default(["facebook"]),
  publishingWindows: z.array(publishingWindowSchema).default([]),
});

export const aiasOrganizationProfileSchema = z.object({
  businessName: requiredText.max(160),
  industry: requiredText.max(120),
  subIndustry: requiredText.max(120).optional(),
  locations: z.array(requiredText.max(120)).default([]),
  offerings: z.array(requiredText.max(240)).min(1),
  idealCustomer: requiredText.max(240),
  painPoints: z.array(requiredText.max(240)).default([]),
  proofPoints: z.array(requiredText.max(240)).default([]),
  tone: requiredText.max(160),
  forbiddenClaims: z.array(requiredText.max(160)).default([]),
  defaultCta: requiredText.max(180),
  timezone: timeZone,
  workflowPreferences: aiasWorkflowPreferencesSchema.default({
    enabledWorkflows: ["copy_generation"],
    approvalRequired: true,
    defaultPlatforms: ["facebook"],
    publishingWindows: [],
  }),
});

export type AiasWorkflow = z.infer<typeof aiasWorkflowSchema>;
export type AiasPlatform = z.infer<typeof aiasPlatformSchema>;
export type PublishingWindow = z.infer<typeof publishingWindowSchema>;
export type AiasWorkflowPreferences = z.infer<typeof aiasWorkflowPreferencesSchema>;
export type AiasOrganizationProfile = z.infer<typeof aiasOrganizationProfileSchema>;

export function parseAiasOrganizationProfile(input: unknown): AiasOrganizationProfile {
  return aiasOrganizationProfileSchema.parse(input);
}

export function parseAiasWorkflowPreferences(input: unknown): AiasWorkflowPreferences {
  return aiasWorkflowPreferencesSchema.parse(input);
}
