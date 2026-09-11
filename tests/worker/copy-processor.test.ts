import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DurableJob } from "@/lib/automation/durable-job-contract";
import type { SupabaseCopyJobPayload } from "@/lib/automation/supabase-copy-worker-store";
import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import { createCopyProcessor, type CopyProcessorResult } from "@/worker/providers/copy-processor";

const organizationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function baseJob(overrides: Partial<SupabaseCopyJobPayload> = {}): DurableJob<SupabaseCopyJobPayload, CopyProcessorResult> {
  return {
    id: jobId,
    organizationId,
    kind: "COPY",
    provider: "local",
    payload: {
      contentItemId: "content-1",
      storagePath: "org/content-1/asset.png",
      assetUrl: "https://signed.example.com/asset.png",
      brief: {
        cta: "Escribe AGENDA por WhatsApp",
        humanDescription: "Bot que agenda citas por WhatsApp.",
        allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
      },
      ...overrides,
    },
    idempotencyKey: "idempotency-key",
    status: "PROCESSING",
    attempts: 1,
    maxAttempts: 3,
    runAt: "2026-09-10T12:00:00.000Z",
    nextAttemptAt: "2026-09-10T12:00:00.000Z",
    leaseToken: "lease-token",
    leaseExpiresAt: "2026-09-10T12:10:00.000Z",
    lastError: null,
    createdAt: "2026-09-10T11:59:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    startedAt: "2026-09-10T12:00:00.000Z",
    completedAt: null,
  };
}

function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.gte = vi.fn().mockReturnValue(builder);
  builder.single = vi.fn().mockResolvedValue(result);
  builder.maybeSingle = vi.fn().mockResolvedValue(result);
  builder.insert = vi.fn().mockResolvedValue({ error: null });
  builder.then = (resolve: (value: typeof result) => void) => resolve(result);
  return builder;
}

function fakeClient(overrides: {
  budget?: number | null;
  spend?: number;
  forbiddenClaims?: string[];
}): SupabaseClient & { aiUsageInsert: ReturnType<typeof vi.fn> } {
  const aiUsageInsert = vi.fn().mockResolvedValue({ error: null });
  const tables: Record<string, unknown> = {
    organizations: chainable({ data: { ai_monthly_budget_usd: overrides.budget ?? null }, error: null }),
    ai_usage_events:
      overrides.spend === undefined
        ? { insert: aiUsageInsert }
        : chainable({ data: [{ estimated_cost_usd: overrides.spend }], error: null }),
    organization_brand_profiles: chainable({
      data: { aias_profile: { forbiddenClaims: overrides.forbiddenClaims ?? [] } },
      error: null,
    }),
  };
  return {
    from: vi.fn().mockImplementation((table: string) => tables[table]),
    aiUsageInsert,
  } as unknown as SupabaseClient & { aiUsageInsert: ReturnType<typeof vi.fn> };
}

const environment = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  OPENROUTER_API_KEY: "openrouter-key",
  SNAPGAD_COPY_OPENROUTER_MODEL: "some/vision-model",
  SNAPGAD_COPY_TIMEOUT_MS: "45000",
  SNAPGAD_COPY_MAX_OUTPUT_TOKENS: "700",
  SNAPGAD_COPY_MAX_REQUEST_COST_USD: "0.05",
  SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD: "3",
  SNAPGAD_COPY_MODEL_OUTPUT_PRICE_PER_1M_USD: "15",
};

function openRouterResponse(drafts: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ drafts }) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const validDrafts = [
  {
    headline: "Más control para la operación diaria",
    body: "El bot atiende preguntas y ayuda a agendar citas. Escribe AGENDA por WhatsApp.",
    cta: "Escribe AGENDA por WhatsApp",
    hashtags: ["#AutomatizacionWhatsApp", "#NegociosMexico", "#Agenda", "#Clinicas", "#SnapGad"],
  },
  {
    headline: "Una atención que sí avanza",
    body: "El bot atiende preguntas y ayuda a agendar citas. Da el siguiente paso.",
    cta: "Escribe AGENDA por WhatsApp",
    hashtags: ["#AutomatizacionWhatsApp", "#NegociosMexico", "#Agenda", "#Clinicas", "#SnapGad"],
  },
];

describe("copy-processor", () => {
  it("rejects the job before calling OpenRouter when the monthly budget is exceeded", async () => {
    const fetchFn = vi.fn();
    const client = fakeClient({ budget: 10, spend: 10 });
    const processor = createCopyProcessor({ environment, fetchFn, getSupabaseClient: () => client });
    const rejection = processor(baseJob());

    await expect(rejection).rejects.toBeInstanceOf(CopyGuardrailError);
    await expect(rejection).rejects.toMatchObject({
      name: "CopyGuardrailError",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("calls OpenRouter with the asset URL and brief, and records cost even before validating shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue(openRouterResponse(validDrafts));
    const client = fakeClient({ budget: null });
    const processor = createCopyProcessor({ environment, fetchFn, getSupabaseClient: () => client });

    const result = await processor(baseJob());

    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("some/vision-model");
    expect(body.max_tokens).toBe(700);
    const userMessage = body.messages.find((message: { role: string }) => message.role === "user");
    const serializedUserContent = JSON.stringify(userMessage.content);
    expect(serializedUserContent).toContain("https://signed.example.com/asset.png");
    expect(serializedUserContent).toContain("Escribe AGENDA por WhatsApp");
    expect(serializedUserContent).toContain("El bot atiende preguntas y ayuda a agendar citas.");
    expect(result.drafts).toHaveLength(2);
    expect(result.provider).toBe("openrouter");
    expect(client.from).toHaveBeenCalledWith("ai_usage_events");
    expect(client.aiUsageInsert).toHaveBeenCalledWith({
      organization_id: organizationId,
      job_id: jobId,
      provider: "openrouter",
      model: "some/vision-model",
      input_tokens: 1000,
      output_tokens: 500,
      estimated_cost_usd: 0.0105,
    });
  });

  it("rejects malformed hashtags before a draft can reach human review", async () => {
    const malformedDrafts = validDrafts.map((draft, index) =>
      index === 0 ? { ...draft, hashtags: ["sin-hash", ...draft.hashtags.slice(1)] } : draft,
    );
    const fetchFn = vi.fn().mockResolvedValue(openRouterResponse(malformedDrafts));
    const client = fakeClient({ budget: null });
    const processor = createCopyProcessor({ environment, fetchFn, getSupabaseClient: () => client });

    await expect(processor(baseJob())).rejects.toMatchObject({
      name: "CopyGuardrailError",
      retryable: true,
    });
  });

  it("fails as retryable when the model response does not match the expected draft shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue(openRouterResponse([{ headline: "sólo un draft" }]));
    const client = fakeClient({ budget: null });
    const processor = createCopyProcessor({ environment, fetchFn, getSupabaseClient: () => client });

    await expect(processor(baseJob())).rejects.toMatchObject({
      name: "CopyGuardrailError",
      retryable: true,
    });
  });

  it("fails as non-retryable when a draft contains a forbidden claim from the org's AIAS profile", async () => {
    const badDrafts = [
      { ...validDrafts[0], body: "Resultados garantizados en una semana." },
      validDrafts[1],
    ];
    const fetchFn = vi.fn().mockResolvedValue(openRouterResponse(badDrafts));
    const client = fakeClient({ budget: null, forbiddenClaims: ["Resultados garantizados"] });
    const processor = createCopyProcessor({ environment, fetchFn, getSupabaseClient: () => client });

    await expect(processor(baseJob())).rejects.toMatchObject({
      name: "CopyGuardrailError",
      retryable: false,
    });
  });
});
