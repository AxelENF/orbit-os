import { describe, expect, it } from "vitest";

import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import { isCopyJobRetryable } from "@/worker/entrypoint";

describe("isCopyJobRetryable", () => {
  it("treats a non-guardrail error as retryable by default", () => {
    expect(isCopyJobRetryable(new Error("network blip"))).toBe(true);
  });

  it("respects the guardrail's own retryable flag", () => {
    expect(isCopyJobRetryable(new CopyGuardrailError("budget exceeded", false))).toBe(false);
    expect(isCopyJobRetryable(new CopyGuardrailError("bad shape", true))).toBe(true);
  });
});
