import { describe, expect, it, vi } from "vitest";

import { hasIntakeSuggestionBudget, recordIntakeSuggestionUsage } from "@/lib/content/intake-suggestion-budget";

describe("hasIntakeSuggestionBudget", () => {
  it("true cuando no hay presupuesto mensual configurado (sin límite)", async () => {
    const client = {} as never;
    const result = await hasIntakeSuggestionBudget(client, "org-1", 0.01, {
      getMonthToDateSpendUsd: vi.fn().mockResolvedValue(5),
      getMonthlyBudgetUsd: vi.fn().mockResolvedValue(null),
    });
    expect(result).toBe(true);
  });

  it("true cuando el gasto + el costo máximo de esta solicitud sigue bajo el límite", async () => {
    const result = await hasIntakeSuggestionBudget({} as never, "org-1", 0.01, {
      getMonthToDateSpendUsd: vi.fn().mockResolvedValue(4.5),
      getMonthlyBudgetUsd: vi.fn().mockResolvedValue(5),
    });
    expect(result).toBe(true);
  });

  it("false cuando el gasto + el costo máximo excede el límite", async () => {
    const result = await hasIntakeSuggestionBudget({} as never, "org-1", 0.01, {
      getMonthToDateSpendUsd: vi.fn().mockResolvedValue(4.995),
      getMonthlyBudgetUsd: vi.fn().mockResolvedValue(5),
    });
    expect(result).toBe(false);
  });

  it("false (fail closed) si la lectura de Supabase lanza", async () => {
    // Corrección tras revisión de Codex CLI ronda 2: la versión anterior
    // de este test (y de la implementación) hacía fail-OPEN aquí —
    // contradice al spec, que dice explícitamente que un fallo de lectura
    // se trata "igual que sin margen de presupuesto" (200 con
    // suggestions: null, sin llamar a OpenRouter). Fail-open habría
    // permitido llamadas reales a OpenRouter precisamente cuando no se
    // puede confirmar que hay presupuesto — lo opuesto de un guardrail.
    const result = await hasIntakeSuggestionBudget({} as never, "org-1", 0.01, {
      getMonthToDateSpendUsd: vi.fn().mockRejectedValue(new Error("db down")),
      getMonthlyBudgetUsd: vi.fn().mockResolvedValue(5),
    });
    expect(result).toBe(false);
  });
});

describe("recordIntakeSuggestionUsage", () => {
  it("llama la RPC con job_id implícito null y no lanza si la RPC falla (solo loguea)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error("boom") });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordIntakeSuggestionUsage(
      { rpc } as never, "org-1",
      { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
    )).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("record_interactive_ai_usage", {
      p_organization_id: "org-1",
      p_provider: "openrouter",
      p_model: "m",
      p_input_tokens: 1,
      p_output_tokens: 1,
      p_estimated_cost_usd: 0.001,
    });
    consoleError.mockRestore();
  });

  it("no lanza si client.rpc lanza por un error de transporte", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("transport down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordIntakeSuggestionUsage(
      { rpc } as never, "org-1",
      { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
    )).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
