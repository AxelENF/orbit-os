import type { SupabaseClient } from "@supabase/supabase-js";

import { getMonthToDateSpendUsd, getMonthlyBudgetUsd } from "@/worker/providers/ai-usage";
import type { IntakeSuggestionUsage } from "@/lib/content/intake-suggestions";

type BudgetReaders = {
  getMonthToDateSpendUsd: typeof getMonthToDateSpendUsd;
  getMonthlyBudgetUsd: typeof getMonthlyBudgetUsd;
};

/**
 * Soft, read-only gate — NOT an atomic reservation. See the spec's "Por qué
 * no se reusa el sistema de reservas" for why: reserveAiRequestBudget needs
 * a real automation_jobs row, and this call must feel instant.
 *
 * Corrección tras revisión de Codex CLI ronda 2: falla CERRADO (false) ante
 * un error de lectura de Supabase, no abierto. El spec dice explícitamente
 * (sección "Contrato de la API", "Fallo de Supabase al leer el gasto/
 * presupuesto mensual") que ese caso se trata igual que "sin margen de
 * presupuesto" — la versión anterior de esta función regresaba `true` en
 * el catch, permitiendo una llamada real a OpenRouter justo cuando no se
 * puede confirmar que hay presupuesto. El formulario sigue siendo 100%
 * usable sin la sugerencia; no hay razón para arriesgar gasto no verificado.
 */
export async function hasIntakeSuggestionBudget(
  client: SupabaseClient,
  organizationId: string,
  maxRequestCostUsd: number,
  readers: BudgetReaders = { getMonthToDateSpendUsd, getMonthlyBudgetUsd },
): Promise<boolean> {
  try {
    const monthlyBudget = await readers.getMonthlyBudgetUsd(client, organizationId);
    if (monthlyBudget === null) return true;
    const spent = await readers.getMonthToDateSpendUsd(client, organizationId, new Date());
    return spent + maxRequestCostUsd <= monthlyBudget;
  } catch {
    return false;
  }
}

/**
 * Best-effort ledger write for a real OpenRouter response. A failure here
 * never fails the user-facing request — the suggestions were already paid
 * for and already returned. It's logged so an operator can notice
 * untracked spend, not silently lost.
 */
export async function recordIntakeSuggestionUsage(
  client: SupabaseClient,
  organizationId: string,
  usage: IntakeSuggestionUsage,
): Promise<void> {
  // Corrección tras revisión de Codex CLI: client.rpc() puede LANZAR (error
  // de red/transporte), no solo regresar { error }. Sin este try/catch, una
  // sugerencia ya pagada y ya calculada se habría convertido en un 503 para
  // el usuario solo porque el registro del gasto en el ledger falló a nivel
  // de transporte — exactamente lo que la Tarea 5 debe evitar.
  try {
    const { error } = await client.rpc("record_interactive_ai_usage", {
      p_organization_id: organizationId,
      p_provider: usage.provider,
      p_model: usage.model,
      p_input_tokens: usage.inputTokens,
      p_output_tokens: usage.outputTokens,
      p_estimated_cost_usd: usage.estimatedCostUsd,
    });
    if (error) {
      console.error(JSON.stringify({ message: "failed to record interactive AI usage", organizationId, error: String(error) }));
    }
  } catch (error) {
    console.error(JSON.stringify({ message: "threw while recording interactive AI usage", organizationId, error: String(error) }));
  }
}
