import { describe, expect, it, vi } from "vitest";
import { fetchIntakeSuggestions, type IntakeSuggestionDependencies } from "@/lib/content/intake-suggestions";

const baseEnv = {
  SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL: "test-model",
  OPENROUTER_API_KEY: "test-key",
  SNAPGAD_INTAKE_SUGGEST_MODEL_INPUT_PRICE_PER_1M_USD: "1",
  SNAPGAD_INTAKE_SUGGEST_MODEL_OUTPUT_PRICE_PER_1M_USD: "2",
};

function okOpenRouterResponse(suggestions: Record<string, unknown>) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(suggestions) } }],
    usage: { prompt_tokens: 500, completion_tokens: 80 },
  }), { status: 200 });
}

describe("fetchIntakeSuggestions", () => {
  it("regresa sugerencias parseadas cuando OpenRouter responde bien", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okOpenRouterResponse({
      niche: "clinicas", contentType: "venta_directa", objective: "agenda_demo",
      humanDescription: "Consultorio dental, promoción de limpieza.",
      offer: "Limpieza dental $299", cta: "Agenda tu cita",
    }));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions?.niche).toBe("clinicas");
    expect(result.suggestions?.offer).toBe("Limpieza dental $299");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("campos ausentes en la respuesta del modelo se regresan como null, no se inventan", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okOpenRouterResponse({ niche: "clinicas" }));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions?.niche).toBe("clinicas");
    expect(result.suggestions?.offer).toBeNull();
  });

  it("respuesta de OpenRouter que no es JSON válido -> suggestions null, sin lanzar", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "no es json" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200 }));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions).toBeNull();
  });

  it("timeout de OpenRouter -> suggestions null, sin lanzar", async () => {
    const fetchFn = vi.fn().mockImplementation(() => new Promise((_, reject) => {
      // Simula abort: fetchIntakeSuggestions debe usar AbortController con
      // SNAPGAD_INTAKE_SUGGEST_TIMEOUT_MS; aquí solo se verifica que un
      // fetch que rechaza con AbortError no se propaga como excepción.
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    }));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions).toBeNull();
  });

  it("regresa el costo estimado cuando hubo respuesta, incluso si la forma es inválida (para registrar el gasto real)", async () => {
    // Corrección tras revisión de Codex CLI ronda 2: "{}" NO es una forma
    // inválida contra suggestionSchema — todos los campos son opcionales,
    // así que "{}" parsea con éxito a un objeto con todo en null. Para
    // probar de verdad una forma inválida hace falta un campo con un tipo
    // que el schema rechace (p. ej. contentType numérico, no string/null).
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ contentType: 12345 }) } }],
      usage: { prompt_tokens: 500, completion_tokens: 80 },
    }), { status: 200 }));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions).toBeNull();
    expect(result.usage).toEqual({ provider: "openrouter", model: "test-model", inputTokens: 500, outputTokens: 80, estimatedCostUsd: expect.any(Number) });
  });

  it("una respuesta 200 con {} (todos los campos ausentes) regresa un objeto de sugerencias todo en null, no null completo", async () => {
    // Caso legítimo, no un error: el modelo respondió pero no tuvo nada
    // que sugerir para ningún campo. Distinto del caso de arriba (forma
    // inválida de verdad).
    const fetchFn = vi.fn().mockResolvedValue(okOpenRouterResponse({}));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions).toEqual({ niche: null, contentType: null, objective: null, humanDescription: null, offer: null, cta: null });
  });

  it("falta configuración requerida (modelo/precios) -> lanza (la ruta lo convierte en 503)", async () => {
    await expect(fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: {}, fetchFn: vi.fn() } as IntakeSuggestionDependencies,
    )).rejects.toThrow();
  });

  it("costo real por encima del techo por solicitud -> suggestions null, pero el uso real se sigue regresando para el ledger", async () => {
    // Hallazgo de revisión Codex CLI ronda 2: la versión anterior solo
    // comprobaba presupuesto ANTES de llamar (hasIntakeSuggestionBudget,
    // Tarea 4) pero nunca validaba el costo REAL de la respuesta contra
    // SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD después — una respuesta
    // inesperadamente grande (más tokens de los esperados) se habría
    // regresado igual, sin ningún guardrail, a diferencia del patrón ya
    // establecido en copy-processor.ts.
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ niche: "clinicas" }) } }],
      usage: { prompt_tokens: 50_000, completion_tokens: 50_000 }, // mucho más de lo esperado
    }), { status: 200 }));
    const result = await fetchIntakeSuggestions({
      imageDataUrl: "data:image/png;base64,AAAA",
      environment: { ...baseEnv, SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD: "0.01" },
      fetchFn,
    } as IntakeSuggestionDependencies);
    expect(result.suggestions).toBeNull();
    expect(result.usage?.estimatedCostUsd).toBeGreaterThan(0.01);
  });
});
