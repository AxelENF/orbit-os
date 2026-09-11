import { describe, expect, it } from "vitest";

import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";

describe("CopyGuardrailError", () => {
  it("carries a retryable flag on top of a normal Error", () => {
    const error = new CopyGuardrailError("Monthly AI budget exceeded.", false);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CopyGuardrailError");
    expect(error.message).toBe("Monthly AI budget exceeded.");
    expect(error.retryable).toBe(false);
  });

  it("defaults nothing — retryable is always explicit", () => {
    const error = new CopyGuardrailError("Invalid draft shape.", true);
    expect(error.retryable).toBe(true);
  });
});
