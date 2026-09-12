import type { SupabaseClient } from "@supabase/supabase-js";

export type AiUsageRecord = {
  reservationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export type AiBudgetReservationInput = {
  organizationId: string;
  jobId: string;
  attempt: number;
  maximumCostUsd: number;
};

export type AiBudgetReservation = {
  id: string;
  reservedCostUsd: number;
};

type ReservationRpcResponse = {
  status?: unknown;
  reservationId?: unknown;
  reservedCostUsd?: unknown;
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

/**
 * Atomically holds the maximum permitted spend for one durable job attempt.
 * A null result is a business rejection (budget exhausted), not a transport
 * failure. The database serializes reservations per organization.
 */
export async function reserveAiRequestBudget(
  client: SupabaseClient,
  input: AiBudgetReservationInput,
): Promise<AiBudgetReservation | null> {
  const { data, error } = await client.rpc("reserve_ai_request_budget", {
    p_organization_id: input.organizationId,
    p_job_id: input.jobId,
    p_attempt: input.attempt,
    p_maximum_cost_usd: input.maximumCostUsd,
  });
  if (error) throw new Error("Unable to reserve the AI request budget.");
  const result = data as ReservationRpcResponse | null;
  if (result?.status === "BUDGET_EXCEEDED") return null;
  if (
    result?.status !== "RESERVED" ||
    typeof result.reservationId !== "string" ||
    !Number.isFinite(Number(result.reservedCostUsd))
  ) {
    throw new Error("Supabase returned an invalid AI budget reservation.");
  }
  return { id: result.reservationId, reservedCostUsd: Number(result.reservedCostUsd) };
}

/**
 * Converts a reservation into one append-only ledger entry. It is idempotent
 * for a completed reservation and never lets browser code write usage rows.
 */
export async function settleAiUsageReservation(
  client: SupabaseClient,
  record: AiUsageRecord,
): Promise<"SETTLED" | "RESERVATION_EXCEEDED"> {
  const { data, error } = await client.rpc("settle_ai_usage_reservation", {
    p_reservation_id: record.reservationId,
    p_provider: record.provider,
    p_model: record.model,
    p_input_tokens: record.inputTokens,
    p_output_tokens: record.outputTokens,
    p_estimated_cost_usd: record.estimatedCostUsd,
  });
  if (error) throw new Error("Unable to settle the AI usage reservation.");
  const result = data as { status?: unknown } | null;
  if (result?.status === "SETTLED" || result?.status === "RESERVATION_EXCEEDED") {
    return result.status;
  }
  throw new Error("Supabase returned an invalid AI usage settlement.");
}
