import { contentBriefSchema, type ContentBrief } from "@/lib/content/contracts";

export function parseContentBrief(input: unknown): ContentBrief {
  return contentBriefSchema.parse(input);
}
