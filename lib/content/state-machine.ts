import { z } from "zod";

import { CONTENT_STATES } from "@/lib/content/constants";

export const contentStateSchema = z.enum(CONTENT_STATES);

export type ContentState = z.infer<typeof contentStateSchema>;

const allowedTransitions: Readonly<Record<ContentState, readonly ContentState[]>> = {
  UPLOADED: ["GENERATING", "REJECTED"],
  GENERATING: ["DRAFT", "ERROR"],
  DRAFT: ["REVIEW"],
  REVIEW: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["SCHEDULED", "DRAFT"],
  SCHEDULED: ["PUBLISHED", "DRAFT"],
  PUBLISHED: [],
  REJECTED: ["DRAFT"],
  ERROR: ["GENERATING"],
};

export function transitionContentState(current: string, next: string): ContentState {
  const parsedCurrent = contentStateSchema.safeParse(current);
  const parsedNext = contentStateSchema.safeParse(next);

  if (
    !parsedCurrent.success ||
    !parsedNext.success ||
    !allowedTransitions[parsedCurrent.data].includes(parsedNext.data)
  ) {
    throw new Error(`Invalid content state transition: ${current} -> ${next}`);
  }

  return parsedNext.data;
}
