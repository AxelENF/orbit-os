import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  estimateCostUsd,
  getMonthToDateSpendUsd,
  getMonthlyBudgetUsd,
  recordAiUsage,
} from "@/worker/providers/ai-usage";

const organizationId = "11111111-1111-4111-8111-111111111111";

function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.gte = vi.fn().mockReturnValue(builder);
  builder.single = vi.fn().mockResolvedValue(result);
  builder.maybeSingle = vi.fn().mockResolvedValue(result);
  builder.then = (resolve: (value: typeof result) => void) => resolve(result);
  return builder;
}

describe("estimateCostUsd", () => {
  it("prices input and output tokens per million and rounds to 4 decimals", () => {
    expect(estimateCostUsd(1_000, 500, 3, 15)).toBeCloseTo(0.0105, 4);
  });

  it("is zero for zero tokens regardless of price", () => {
    expect(estimateCostUsd(0, 0, 3, 15)).toBe(0);
  });
});

describe("getMonthToDateSpendUsd", () => {
  it("sums estimated_cost_usd for the organization since the start of the current month", async () => {
    const rows = chainable({
      data: [{ estimated_cost_usd: "1.5" }, { estimated_cost_usd: "2.25" }],
      error: null,
    });
    const from = vi.fn().mockReturnValue(rows);
    const client = { from } as unknown as SupabaseClient;

    const spend = await getMonthToDateSpendUsd(client, organizationId, new Date("2026-09-15T12:00:00.000Z"));

    expect(spend).toBeCloseTo(3.75, 4);
    expect(from).toHaveBeenCalledWith("ai_usage_events");
    expect(rows.eq).toHaveBeenCalledWith("organization_id", organizationId);
    expect(rows.gte).toHaveBeenCalledWith("created_at", "2026-09-01T00:00:00.000Z");
  });

  it("throws a clean error when Supabase returns an error", async () => {
    const rows = chainable({ data: null, error: { message: "boom" } });
    const client = { from: vi.fn().mockReturnValue(rows) } as unknown as SupabaseClient;

    await expect(getMonthToDateSpendUsd(client, organizationId, new Date())).rejects.toThrow(
      "Unable to read AI usage for the organization.",
    );
  });
});

describe("getMonthlyBudgetUsd", () => {
  it("returns null when the organization has no configured cap", async () => {
    const rows = chainable({ data: { ai_monthly_budget_usd: null }, error: null });
    const client = { from: vi.fn().mockReturnValue(rows) } as unknown as SupabaseClient;

    await expect(getMonthlyBudgetUsd(client, organizationId)).resolves.toBeNull();
  });

  it("returns the configured cap", async () => {
    const rows = chainable({ data: { ai_monthly_budget_usd: 20 }, error: null });
    const client = { from: vi.fn().mockReturnValue(rows) } as unknown as SupabaseClient;

    await expect(getMonthlyBudgetUsd(client, organizationId)).resolves.toBe(20);
  });
});

describe("recordAiUsage", () => {
  it("inserts a usage row with snake_case columns", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient;

    await recordAiUsage(client, {
      organizationId,
      jobId: "22222222-2222-4222-8222-222222222222",
      provider: "openrouter",
      model: "some/vision-model",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.0105,
    });

    expect(insert).toHaveBeenCalledWith({
      organization_id: organizationId,
      job_id: "22222222-2222-4222-8222-222222222222",
      provider: "openrouter",
      model: "some/vision-model",
      input_tokens: 1000,
      output_tokens: 500,
      estimated_cost_usd: 0.0105,
    });
  });

  it("throws a clean error when Supabase returns an error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient;

    await expect(
      recordAiUsage(client, {
        organizationId,
        jobId: "job",
        provider: "openrouter",
        model: "model",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      }),
    ).rejects.toThrow("Unable to record AI usage.");
  });
});
