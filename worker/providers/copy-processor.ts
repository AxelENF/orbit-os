import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { DurableJob } from "@/lib/automation/durable-job-contract";
import type { SupabaseCopyJobPayload } from "@/lib/automation/supabase-copy-worker-store";
import { validateFinalCopy } from "@/lib/content/final-copy";
import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import {
  estimateCostUsd,
  getMonthToDateSpendUsd,
  getMonthlyBudgetUsd,
  recordAiUsage,
} from "@/worker/providers/ai-usage";

const HASHTAG_MIN = 5;
const HASHTAG_MAX = 8;

const draftSchema = z.object({
  headline: z.string().trim().min(1),
  body: z.string().trim().min(1),
  cta: z.string().trim().min(1),
  hashtags: z.array(z.string().trim().min(1)).min(HASHTAG_MIN).max(HASHTAG_MAX),
});

const modelResponseSchema = z.object({
  drafts: z.array(draftSchema).length(2),
});

export type CopyProcessorResult = {
  visualAnalysis: Record<string, unknown>;
  drafts: Array<z.infer<typeof draftSchema>>;
  warnings: string[];
  provider: "openrouter";
  model: string;
};

export type CopyProcessorEnvironment = Record<string, string | undefined>;

export type CopyProcessorDependencies = {
  fetchFn?: typeof fetch;
  environment?: CopyProcessorEnvironment;
  nowMs?: () => number;
  getSupabaseClient?: () => SupabaseClient;
};

function requiredEnv(environment: CopyProcessorEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for the copy processor.`);
  return value;
}

function requiredPriceEnv(environment: CopyProcessorEnvironment, name: string): number {
  const value = Number(requiredEnv(environment, name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function buildPrompt(brief: Record<string, unknown>): { system: string; user: string } {
  const lines = Object.entries(brief)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join("; ") : String(value)}`);
  return {
    system:
      "Eres un redactor publicitario directo, conversion-first, para redes sociales. " +
      "Escribes en español, tono intenso pero honesto. Nunca inventas hechos, precios, " +
      "resultados, urgencia ni testimonios que no aparezcan en allowedFacts. " +
      "Respondes EXCLUSIVAMENTE con un objeto JSON de la forma " +
      '{"drafts":[{"headline":string,"body":string,"cta":string,"hashtags":string[]},' +
      '{"headline":string,"body":string,"cta":string,"hashtags":string[]}]}. ' +
      `Exactamente 2 elementos en drafts, y entre ${HASHTAG_MIN} y ${HASHTAG_MAX} hashtags por draft, ` +
      "cada hashtag empieza con # y no repite un claim prohibido.",
    user: `Brief de campaña:\n${lines.join("\n")}\n\nGenera 2 alternativas de copy basadas únicamente en este brief y en la imagen adjunta.`,
  };
}

async function getOrganizationForbiddenClaims(
  client: SupabaseClient,
  organizationId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("organization_brand_profiles")
    .select("aias_profile")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error("Unable to read the organization's AIAS profile.");
  const profile = (data as { aias_profile?: { forbiddenClaims?: unknown } } | null)?.aias_profile;
  return Array.isArray(profile?.forbiddenClaims)
    ? profile.forbiddenClaims.filter((claim): claim is string => typeof claim === "string")
    : [];
}

function briefAllowedFacts(brief: Record<string, unknown>): string[] {
  return Array.isArray(brief.allowedFacts)
    ? brief.allowedFacts.filter((fact): fact is string => typeof fact === "string")
    : [];
}

export function createCopyProcessor(dependencies: CopyProcessorDependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const fetchImpl = dependencies.fetchFn ?? fetch;
  const now = dependencies.nowMs ?? Date.now;
  let cachedClient: SupabaseClient | null = null;

  function getClient(): SupabaseClient {
    if (dependencies.getSupabaseClient) return dependencies.getSupabaseClient();
    if (!cachedClient) {
      cachedClient = createClient(
        requiredEnv(environment, "NEXT_PUBLIC_SUPABASE_URL"),
        requiredEnv(environment, "SUPABASE_SERVICE_ROLE_KEY"),
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
    }
    return cachedClient;
  }

  return async function processCopyJob(
    job: DurableJob<SupabaseCopyJobPayload, CopyProcessorResult>,
  ): Promise<CopyProcessorResult> {
    const client = getClient();
    const model = requiredEnv(environment, "SNAPGAD_COPY_OPENROUTER_MODEL");
    const apiKey = requiredEnv(environment, "OPENROUTER_API_KEY");
    const timeoutMs = Number(environment.SNAPGAD_COPY_TIMEOUT_MS ?? "45000");
    const inputPrice = requiredPriceEnv(environment, "SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD");
    const outputPrice = requiredPriceEnv(environment, "SNAPGAD_COPY_MODEL_OUTPUT_PRICE_PER_1M_USD");

    // Guardrail 1: presupuesto, antes de gastar nada.
    const budget = await getMonthlyBudgetUsd(client, job.organizationId);
    if (budget !== null) {
      const spend = await getMonthToDateSpendUsd(client, job.organizationId, new Date(now()));
      if (spend >= budget) {
        throw new CopyGuardrailError(
          `Monthly AI budget of $${budget} exceeded ($${spend.toFixed(2)} spent).`,
          false,
        );
      }
    }

    // Guardrail 2: timeout duro por llamada.
    const { system, user } = buildPrompt(job.payload.brief);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: [
                { type: "text", text: user },
                { type: "image_url", image_url: { url: job.payload.assetUrl } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`OpenRouter request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;
    const estimatedCostUsd = estimateCostUsd(inputTokens, outputTokens, inputPrice, outputPrice);

    // Guardrail 5: el costo se registra siempre que hubo respuesta del
    // modelo, incluso si las validaciones de forma o claims fallan después —
    // si no, un brief que dispara repetidamente el guardrail de claims
    // gastaría dinero real sin que el tope mensual se entere.
    await recordAiUsage(client, {
      organizationId: job.organizationId,
      jobId: job.id,
      provider: "openrouter",
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
    });

    // Guardrail 3: forma exacta de la respuesta.
    const rawContent = payload.choices?.[0]?.message?.content ?? "";
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch {
      throw new CopyGuardrailError("OpenRouter did not return valid JSON.", true);
    }
    const modelResult = modelResponseSchema.safeParse(parsedJson);
    if (!modelResult.success) {
      throw new CopyGuardrailError("OpenRouter response did not match the expected draft shape.", true);
    }

    // Guardrail 4: claims — reusa validateFinalCopy, la misma lógica que ya
    // corre sobre el copy que un humano escribe a mano.
    const allowedFacts = briefAllowedFacts(job.payload.brief);
    const forbiddenClaims = await getOrganizationForbiddenClaims(client, job.organizationId);
    for (const draft of modelResult.data.drafts) {
      const validation = validateFinalCopy(draft, { allowedFacts, forbiddenClaims });
      if (!validation.ok) {
        throw new CopyGuardrailError(
          `Draft rejected by claims guardrail: ${validation.reasons.join("; ")}`,
          false,
        );
      }
    }

    return {
      visualAnalysis: { source: "openrouter", model },
      drafts: modelResult.data.drafts,
      warnings: [],
      provider: "openrouter",
      model,
    };
  };
}

export default createCopyProcessor();
