import type { SupabaseClient } from "@supabase/supabase-js";

export type AiUsageRecord = {
  organizationId: string;
  jobId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

/** Rounds to 4 decimals — enough precision for a cost estimate, not an invoice. */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPricePerMillionUsd: number,
  outputPricePerMillionUsd: number,
): number {
  const cost =
    (inputTokens / 1_000_000) * inputPricePerMillionUsd +
    (outputTokens / 1_000_000) * outputPricePerMillionUsd;
  return Math.round(cost * 10_000) / 10_000;
}

export async function getMonthToDateSpendUsd(
  client: SupabaseClient,
  organizationId: string,
  now: Date,
): Promise<number> {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await client
    .from("ai_usage_events")
    .select("estimated_cost_usd")
    .eq("organization_id", organizationId)
    .gte("created_at", startOfMonth);
  if (error) throw new Error("Unable to read AI usage for the organization.");
  return ((data ?? []) as Array<{ estimated_cost_usd: string | number }>).reduce(
    (sum, row) => sum + Number(row.estimated_cost_usd),
    0,
  );
}

export async function getMonthlyBudgetUsd(
  client: SupabaseClient,
  organizationId: string,
): Promise<number | null> {
  const { data, error } = await client
    .from("organizations")
    .select("ai_monthly_budget_usd")
    .eq("id", organizationId)
    .single();
  if (error) throw new Error("Unable to read the organization's AI budget.");
  const value = (data as { ai_monthly_budget_usd: number | null } | null)?.ai_monthly_budget_usd;
  return value ?? null;
}

export async function recordAiUsage(client: SupabaseClient, record: AiUsageRecord): Promise<void> {
  const { error } = await client.from("ai_usage_events").insert({
    organization_id: record.organizationId,
    job_id: record.jobId,
    provider: record.provider,
    model: record.model,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    estimated_cost_usd: record.estimatedCostUsd,
  });
  if (error) throw new Error("Unable to record AI usage.");
}
