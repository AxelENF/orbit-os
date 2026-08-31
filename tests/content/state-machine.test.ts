import { describe, expect, it } from "vitest";

import { transitionContentState } from "@/lib/content/state-machine";

describe("transitionContentState", () => {
  it.each([
    ["UPLOADED", "GENERATING"],
    ["GENERATING", "DRAFT"],
    ["DRAFT", "REVIEW"],
    ["REVIEW", "APPROVED"],
    ["APPROVED", "SCHEDULED"],
    ["SCHEDULED", "PUBLISHED"],
    ["REVIEW", "REJECTED"],
    ["REJECTED", "DRAFT"],
    ["GENERATING", "ERROR"],
    ["ERROR", "GENERATING"],
  ])("allows %s to %s", (current, next) => {
    expect(transitionContentState(current, next)).toBe(next);
  });

  it.each([
    ["DRAFT", "PUBLISHED"],
    ["UPLOADED", "APPROVED"],
    ["PUBLISHED", "DRAFT"],
    ["REJECTED", "SCHEDULED"],
  ])("rejects %s to %s when the workflow does not allow it", (current, next) => {
    expect(() => transitionContentState(current, next)).toThrow(
      "Invalid content state transition",
    );
  });
});
