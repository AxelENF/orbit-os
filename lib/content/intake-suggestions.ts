import { z } from "zod";

import { CONTENT_TYPES, CONTENT_OBJECTIVES } from "@/lib/content/constants";
import { estimateCostUsd } from "@/worker/providers/ai-usage";

const suggestionSchema = z.object({
  niche: z.string().trim().min(1).nullable().optional(),
  contentType: z.enum(CONTENT_TYPES).nullable().optional(),
  objective: z.enum(CONTENT_OBJECTIVES).nullable().optional(),
  humanDescription: z.string().trim().min(1).nullable().optional(),
  offer: z.string().trim().min(1).nullable().optional(),
  cta: z.string().trim().min(1).nullable().optional(),
});

export type IntakeSuggestions = {
  niche: string | null;
  contentType: (typeof CONTENT_TYPES)[number] | null;
  objective: (typeof CONTENT_OBJECTIVES)[number] | null;
  humanDescription: string | null;
  offer: string | null;
  cta: string | null;
};

export type IntakeSuggestionUsage = {
  provider: "openrouter";
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export type IntakeSuggestionResult = {
  suggestions: IntakeSuggestions | null;
  /** Present only when OpenRouter actually responded — the cost was real
   * even if the shape ended up invalid. null means no network call
   * completed (timeout, config error before the call) and nothing to bill. */
  usage: IntakeSuggestionUsage | null;
};

export type IntakeSuggestionDependencies = {
  imageDataUrl: string;
  environment: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
};

function requiredEnv(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for intake suggestions.`);
  return value;
}

function requiredPriceEnv(environment: Record<string, string | undefined>, name: string): number {
  const value = Number(requiredEnv(environment, name));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function positiveNumberEnv(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = Number(environment[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeSuggestions(parsed: z.infer<typeof suggestionSchema>): IntakeSuggestions {
  return {
    niche: parsed.niche ?? null,
    contentType: parsed.contentType ?? null,
    objective: parsed.objective ?? null,
    humanDescription: parsed.humanDescription ?? null,
    offer: parsed.offer ?? null,
    cta: parsed.cta ?? null,
  };
}

const SYSTEM_PROMPT =
  "Analizas una imagen de un creativo publicitario terminado (export de Canva) " +
  "para sugerir campos de un formulario de campaña. Respondes EXCLUSIVAMENTE con " +
  "un objeto JSON de la forma " +
  '{"niche":string|null,"contentType":string|null,"objective":string|null,' +
  '"humanDescription":string|null,"offer":string|null,"cta":string|null}. ' +
  "Un campo es null si la imagen no ofrece evidencia real para ese campo — " +
  "nunca inventes un valor. offer y cta solo si hay texto visible en la imagen " +
  "que los respalde. humanDescription es una frase corta describiendo qué se ve, " +
  "no una campaña completa. " +
  `contentType debe ser uno de: ${CONTENT_TYPES.join(", ")}. ` +
  `objective debe ser uno de: ${CONTENT_OBJECTIVES.join(", ")}.`;

export async function fetchIntakeSuggestions(
  dependencies: IntakeSuggestionDependencies,
): Promise<IntakeSuggestionResult> {
  const { environment, imageDataUrl } = dependencies;
  const fetchImpl = dependencies.fetchFn ?? fetch;
  const model = requiredEnv(environment, "SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL");
  const apiKey = requiredEnv(environment, "OPENROUTER_API_KEY");
  const inputPrice = requiredPriceEnv(environment, "SNAPGAD_INTAKE_SUGGEST_MODEL_INPUT_PRICE_PER_1M_USD");
  const outputPrice = requiredPriceEnv(environment, "SNAPGAD_INTAKE_SUGGEST_MODEL_OUTPUT_PRICE_PER_1M_USD");
  const maxOutputTokens = positiveNumberEnv(environment, "SNAPGAD_INTAKE_SUGGEST_MAX_OUTPUT_TOKENS", 300);
  const timeoutMs = positiveNumberEnv(environment, "SNAPGAD_INTAKE_SUGGEST_TIMEOUT_MS", 15000);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Sugiere los campos del formulario para este creativo." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { suggestions: null, usage: null };
    payload = await response.json();
  } catch {
    // Network error, abort/timeout, or malformed body: no response, nothing to bill, fail open.
    return { suggestions: null, usage: null };
  } finally {
    clearTimeout(timeout);
  }
  if (!payload.usage) {
    console.warn("OpenRouter response omitted usage; intake suggestion cost is unknown and is recorded as zero.");
  }
  const inputTokens = payload.usage?.prompt_tokens ?? 0;
  const outputTokens = payload.usage?.completion_tokens ?? 0;
  const estimatedCostUsd = estimateCostUsd(inputTokens, outputTokens, inputPrice, outputPrice);
  const usage: IntakeSuggestionUsage = { provider: "openrouter", model, inputTokens, outputTokens, estimatedCostUsd };

  const rawContent = payload.choices?.[0]?.message?.content ?? "";
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch {
    return { suggestions: null, usage };
  }
  const parsed = suggestionSchema.safeParse(parsedJson);
  if (!parsed.success) return { suggestions: null, usage };

  // Corrección tras revisión de Codex CLI ronda 2: el chequeo de
  // hasIntakeSuggestionBudget (Tarea 4) solo protege ANTES de llamar —
  // esto protege DESPUÉS, contra una respuesta cuyo costo real terminó
  // por encima del techo esperado (mismo espíritu que el guardrail de
  // costo de worker/providers/copy-processor.ts). El uso ya se regresa de
  // cualquier forma para que el ledger registre el gasto real.
  const maxRequestCostUsd = positiveNumberEnv(environment, "SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD", 0.01);
  if (usage.estimatedCostUsd > maxRequestCostUsd) return { suggestions: null, usage };

  return { suggestions: normalizeSuggestions(parsed.data), usage };
}
