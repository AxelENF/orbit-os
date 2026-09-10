import { z } from "zod";

import {
  BUSINESS_LINES,
  CONTENT_FORMATS,
  CONTENT_OBJECTIVES,
  CONTENT_TYPES,
  NICHES,
  SERVICES,
} from "@/lib/content/constants";

export const businessLineSchema = z.enum(BUSINESS_LINES);
export const serviceSchema = z.enum(SERVICES);
export const nicheSchema = z.enum(NICHES);
export const contentTypeSchema = z.enum(CONTENT_TYPES);
export const contentObjectiveSchema = z.enum(CONTENT_OBJECTIVES);
export const contentFormatSchema = z.enum(CONTENT_FORMATS);

const requiredText = z.string().trim().min(1);

export const contentBriefSchema = z.object({
  businessLine: businessLineSchema,
  service: serviceSchema,
  niche: nicheSchema,
  contentType: contentTypeSchema,
  objective: contentObjectiveSchema,
  format: contentFormatSchema,
  cta: requiredText,
  humanDescription: requiredText,
  allowedFacts: z.array(requiredText).min(1),
  forbiddenClaims: z.array(requiredText).optional(),
});

export type ContentBrief = z.infer<typeof contentBriefSchema>;
