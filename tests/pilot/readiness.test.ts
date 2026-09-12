import { describe, expect, it } from "vitest";

import { getPilotReadiness } from "@/lib/pilot/readiness";

describe("pilot readiness", () => {
  it("reports demo plainly without leaking or inventing a live integration", () => {
    const readiness = getPilotReadiness({});

    expect(readiness.mode).toBe("demo");
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "persistence", status: "ACTION_REQUIRED" }),
      expect.objectContaining({ id: "manualDelivery", status: "READY" }),
      expect.objectContaining({ id: "copyWorker", status: "BLOCKED" }),
    ]));
    expect(readiness.nextAction).toMatch(/\.env\.local/i);
  });

  it("fails closed on partial Supabase configuration", () => {
    const readiness = getPilotReadiness({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    });

    expect(readiness.mode).toBe("misconfigured");
    expect(readiness.checks.find((check) => check.id === "persistence")?.status).toBe("BLOCKED");
  });

  it("distinguishes configured worker inputs from a confirmed running process", () => {
    const readiness = getPilotReadiness({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "server-only-key",
      SNAPGAD_COPY_WORKER_MODULE: "./worker/providers/copy-processor.ts",
      OPENROUTER_API_KEY: "server-only-key",
      SNAPGAD_COPY_OPENROUTER_MODEL: "model",
      SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD: "1",
      SNAPGAD_COPY_MODEL_OUTPUT_PRICE_PER_1M_USD: "1",
      SNAPGAD_COPY_MAX_REQUEST_COST_USD: "0.05",
    });

    expect(readiness.mode).toBe("supabase");
    expect(readiness.checks.find((check) => check.id === "copyWorker")).toMatchObject({
      status: "ACTION_REQUIRED",
      detail: expect.stringMatching(/no confirma que esté corriendo/i),
    });
  });
});
