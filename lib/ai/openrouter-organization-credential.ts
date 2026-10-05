import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Decrypted credential used only inside a trusted route handler or worker.
 * Do not add this type to API response contracts, job payloads, logs, or
 * persisted records. The RPC is service-role-only and the API key is sourced
 * from Supabase Vault at the last possible point before an AI request.
 *
 * This core intentionally has no `server-only` marker because the standalone
 * Node worker imports it directly. Browser-facing modules must never import
 * this file; they receive only the sanitized credential-status RPC response.
 */
export type OrganizationOpenRouterCredential = {
  credentialId: string;
  apiKey: string;
  model: string;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
  monthlyBudgetUsd: number | null;
};

export type OrganizationOpenRouterCredentialResolver = (
  organizationId: string,
) => Promise<OrganizationOpenRouterCredential | null>;

export class OrganizationOpenRouterCredentialResolutionError extends Error {
  constructor() {
    super("The organization OpenRouter credential could not be resolved.");
    this.name = "OrganizationOpenRouterCredentialResolutionError";
  }
}

type ResolverRow = {
  credential_id?: unknown;
  api_key?: unknown;
  model?: unknown;
  input_cost_per_million_usd?: unknown;
  output_cost_per_million_usd?: unknown;
  monthly_budget_usd?: unknown;
};

function toFiniteNonNegativeNumber(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function toNullableFiniteNonNegativeNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return toFiniteNonNegativeNumber(value) ?? undefined;
}

function normalizeCredential(rows: unknown): OrganizationOpenRouterCredential | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length !== 1) throw new OrganizationOpenRouterCredentialResolutionError();

  const row = rows[0] as ResolverRow | null;
  const credentialId = typeof row?.credential_id === "string" ? row.credential_id.trim() : "";
  const apiKey = typeof row?.api_key === "string" ? row.api_key.trim() : "";
  const model = typeof row?.model === "string" ? row.model.trim() : "";
  const inputCostPerMillionUsd = toFiniteNonNegativeNumber(row?.input_cost_per_million_usd);
  const outputCostPerMillionUsd = toFiniteNonNegativeNumber(row?.output_cost_per_million_usd);
  const monthlyBudgetUsd = toNullableFiniteNonNegativeNumber(row?.monthly_budget_usd);

  // A key without a model or known costs cannot be billed or guarded safely.
  // Treat it as a closed configuration failure, never as a fallback to a
  // global account key.
  if (
    !credentialId ||
    !apiKey ||
    !model ||
    inputCostPerMillionUsd === null ||
    outputCostPerMillionUsd === null ||
    monthlyBudgetUsd === undefined
  ) {
    throw new OrganizationOpenRouterCredentialResolutionError();
  }

  return {
    credentialId,
    apiKey,
    model,
    inputCostPerMillionUsd,
    outputCostPerMillionUsd,
    monthlyBudgetUsd,
  };
}

/**
 * Resolves an ACTIVE BYOK credential through the service-role-only RPC.
 * A missing, revoked, or errored credential is deliberately indistinguishable
 * to callers and returns null. Transport/RPC corruption throws so callers can
 * fail closed without leaking provider or Vault diagnostics.
 */
export async function resolveOrganizationOpenRouterCredential(
  client: SupabaseClient,
  organizationId: string,
): Promise<OrganizationOpenRouterCredential | null> {
  if (!organizationId.trim()) return null;

  let result: { data: unknown; error: unknown };
  try {
    result = await client.rpc("resolve_organization_openrouter_credential_for_worker", {
      p_organization_id: organizationId,
    }) as { data: unknown; error: unknown };
  } catch {
    throw new OrganizationOpenRouterCredentialResolutionError();
  }

  if (result.error) throw new OrganizationOpenRouterCredentialResolutionError();
  return normalizeCredential(result.data);
}
