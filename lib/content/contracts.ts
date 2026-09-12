import { z } from "zod";

import {
  CONTENT_FORMATS,
  CONTENT_OBJECTIVES,
  CONTENT_TYPES,
} from "@/lib/content/constants";

// These labels used to be enums tied to SnapGad's own offer catalog. Content
// rows are already text in Postgres, so a tenant-owned vocabulary is both
// safer and more useful than forcing every customer into our internal names.
const commercialTaxonomySchema = z.string().trim().min(1).max(120);

export const businessLineSchema = commercialTaxonomySchema;
export const serviceSchema = commercialTaxonomySchema;
export const nicheSchema = commercialTaxonomySchema;
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
