# Sugerencias por visión en el intake — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analizar la imagen del intake al subirla (no después de enviar el formulario) para pre-llenar los campos que una imagen puede sugerir de verdad, reduciendo la fricción del formulario de 14 campos.

**Architecture:** Un endpoint síncrono nuevo (`POST /api/content/suggestions`, no un job del worker durable) que manda la imagen como data URL base64 a OpenRouter, con un chequeo de presupuesto de solo-lectura (no una reserva atómica — ver el spec para el razonamiento). El frontend rastrea qué campos fueron editados por el usuario con un `Set` de un solo sentido, para que las sugerencias nunca pisen una decisión ya tomada.

**Tech Stack:** Next.js 16 route handlers, Supabase (RPC + Postgres), Zod, Vitest, OpenRouter (chat completions, imagen como data URL).

**Spec de referencia:** `docs/superpowers/specs/2026-09-14-intake-vision-suggestions-design.md` (revisión 4, ya revisada 3 veces con Codex CLI). Este plan no repite el razonamiento, solo el "cómo" exacto.

**Rama:** `feat/intake-vision-simplification` (creada sobre `feat/personal-pilot-hardening`).

**Migraciones aplicadas en esta rama:** `0001`–`0017`. **Nota importante:**
esta rama es independiente de `feat/meta-publisher-oauth-adapter` (que
también tiene sus propias migraciones `0018`+, sin mergear todavía) —
cuando ambas ramas se integren, alguien va a tener que renumerar una de
las dos series de migraciones nuevas. No es un problema a resolver en este
plan; es un conflicto de merge esperado y normal entre dos ramas
paralelas, se documenta aquí para que no sorprenda a nadie.

**Sesión autónoma:** Axel autorizó explícitamente ejecutar este plan sin
pausar para su aprobación en cada paso. La implementación se despacha
tarea por tarea a Codex CLI, igual que el plan del publisher de Meta.

---

## Convenciones para quien implemente

- **Nunca** modifiques `supabase/migrations/0001` a `0017`. El cambio de esquema de este plan va en `0018_intake_interactive_ai_usage.sql`, un archivo nuevo.
- Cada función `SECURITY DEFINER` nueva necesita su par `revoke all ... from public, anon, authenticated;` / `grant execute ... to service_role;`.
- **REGLA DE SEGURIDAD DE GIT:** nunca ejecutes `git reset --hard`, `git checkout --`, `git clean`, ni ningún comando que descarte trabajo ya commiteado. Si algo parece ir mal, para y reporta — no "limpies" el estado del repo por tu cuenta.
- **Nota sobre `.codebase-memory/`:** puede aparecer modificado en `git status` por una herramienta de indexado que corre en paralelo, ajena a este plan. Ignóralo por completo — no lo edites, no lo incluyas en tu `git add`.
- Sigue TDD: el test se escribe y se corre en rojo antes que la implementación, en cada tarea.
- Commits pequeños y frecuentes.

---

## Task 1: `record_interactive_ai_usage` — migración

**Files:**
- Create: `supabase/migrations/0018_intake_interactive_ai_usage.sql`
- Test: `tests/content/intake-suggestions-migration.test.ts`

Referencia de estilo de test: `tests/content/copy-hashtags-migration.test.ts`
— lee el `.sql` con `readFile` y hace aserciones por regex sobre el texto
(no hay Postgres local para correr contra una base real en este entorno).

- [ ] **Step 1: Escribir el test que debe fallar**

```typescript
// tests/content/intake-suggestions-migration.test.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(new URL("../../supabase/migrations/0018_intake_interactive_ai_usage.sql", import.meta.url));
  return readFile(path, "utf8");
}

describe("record_interactive_ai_usage", () => {
  it("inserta en ai_usage_events con job_id null", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create function public\.record_interactive_ai_usage/i);
    expect(sql).toMatch(/insert into public\.ai_usage_events/i);
    expect(sql).toMatch(/p_organization_id, null, p_provider/i);
  });

  it("está revocada de public/anon/authenticated y otorgada solo a service_role", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/revoke all on function public\.record_interactive_ai_usage\([^)]*\) from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.record_interactive_ai_usage\([^)]*\) to service_role/i);
  });
});
```

- [ ] **Step 2: Correr, confirmar que falla**

Run: `npm test -- --run tests/content/intake-suggestions-migration.test.ts`
Expected: FAIL — el archivo no existe.

- [ ] **Step 3: Escribir la migración**

```sql
-- supabase/migrations/0018_intake_interactive_ai_usage.sql
-- Interactive (non-job) AI usage ledger entry for intake vision
-- suggestions. job_id is nullable on ai_usage_events (0014) precisely
-- for calls like this one that aren't tied to a durable job.
-- Spec: docs/superpowers/specs/2026-09-14-intake-vision-suggestions-design.md

create function public.record_interactive_ai_usage(
  p_organization_id uuid,
  p_provider text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost_usd is null or p_estimated_cost_usd < 0
     or nullif(btrim(p_provider), '') is null
     or nullif(btrim(p_model), '') is null then
    raise exception using errcode = '22023', message = 'INTERACTIVE_AI_USAGE_INVALID_INPUT';
  end if;

  insert into public.ai_usage_events (
    organization_id, job_id, provider, model, input_tokens, output_tokens, estimated_cost_usd
  ) values (
    p_organization_id, null, p_provider, p_model, p_input_tokens, p_output_tokens, p_estimated_cost_usd
  );

  return jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.record_interactive_ai_usage(uuid, text, text, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.record_interactive_ai_usage(uuid, text, text, integer, integer, numeric)
  to service_role;
```

- [ ] **Step 4: Correr, confirmar que pasa**

Run: `npm test -- --run tests/content/intake-suggestions-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_intake_interactive_ai_usage.sql tests/content/intake-suggestions-migration.test.ts
git commit -m "feat: add record_interactive_ai_usage RPC for non-job AI calls"
```

---

## Task 2: Variables de entorno

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Agregar las variables nuevas**

Busca dónde viven las variables `SNAPGAD_COPY_*` en `.env.example` y agrega,
junto a ellas (mismo bloque/sección), sin tocar ninguna existente:

```
# Intake vision suggestions (POST /api/content/suggestions)
SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL=
SNAPGAD_INTAKE_SUGGEST_MAX_OUTPUT_TOKENS=300
SNAPGAD_INTAKE_SUGGEST_TIMEOUT_MS=15000
SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD=0.01
SNAPGAD_INTAKE_SUGGEST_MODEL_INPUT_PRICE_PER_1M_USD=
SNAPGAD_INTAKE_SUGGEST_MODEL_OUTPUT_PRICE_PER_1M_USD=
```

`OPENROUTER_API_KEY` ya existe en `.env.example` (la reusa este endpoint,
no necesita una copia propia).

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add env vars for intake vision suggestions"
```

---

## Task 3: `lib/content/intake-suggestions.ts` — lógica compartida

**Files:**
- Create: `lib/content/intake-suggestions.ts`
- Test: `tests/content/intake-suggestions.test.ts`

Este módulo NO es una ruta HTTP — es la lógica pura/inyectable que la
Tarea 5 (la ruta) va a usar. Sepáralo así a propósito: es más fácil de
testear sin mockear `Request`/`FormData`, mismo criterio que ya separa
`worker/providers/copy-processor.ts` de cualquier ruta HTTP.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// tests/content/intake-suggestions.test.ts
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
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 500, completion_tokens: 80 },
    }), { status: 200 }));
    const result = await fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: baseEnv, fetchFn } as IntakeSuggestionDependencies,
    );
    expect(result.suggestions).toBeNull();
    expect(result.usage).toEqual({ provider: "openrouter", model: "test-model", inputTokens: 500, outputTokens: 80, estimatedCostUsd: expect.any(Number) });
  });

  it("falta configuración requerida (modelo/precios) -> lanza (la ruta lo convierte en 503)", async () => {
    await expect(fetchIntakeSuggestions(
      { imageDataUrl: "data:image/png;base64,AAAA", environment: {}, fetchFn: vi.fn() } as IntakeSuggestionDependencies,
    )).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr, confirmar que fallan**

Run: `npm test -- --run tests/content/intake-suggestions.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

```typescript
// lib/content/intake-suggestions.ts
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
  const maxOutputTokens = Number(environment.SNAPGAD_INTAKE_SUGGEST_MAX_OUTPUT_TOKENS ?? "300");
  const timeoutMs = Number(environment.SNAPGAD_INTAKE_SUGGEST_TIMEOUT_MS ?? "15000");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
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
  } catch {
    // Network error or abort/timeout: no response, nothing to bill, fail open.
    return { suggestions: null, usage: null };
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return { suggestions: null, usage: null };

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
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

  return { suggestions: normalizeSuggestions(parsed.data), usage };
}
```

- [ ] **Step 4: Correr, confirmar que pasan**

Run: `npm test -- --run tests/content/intake-suggestions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/content/intake-suggestions.ts tests/content/intake-suggestions.test.ts
git commit -m "feat: add fetchIntakeSuggestions vision-analysis helper"
```

---

## Task 4: chequeo de presupuesto blando + registro de gasto

**Files:**
- Create: `lib/content/intake-suggestion-budget.ts`
- Test: `tests/content/intake-suggestion-budget.test.ts`

Módulo separado a propósito de la Tarea 3 — mezcla llamadas a Supabase
(`getMonthToDateSpendUsd`, `getMonthlyBudgetUsd`, `record_interactive_ai_usage`)
con la lógica de negocio de "hay margen o no", que es más fácil de testear
aislada del cliente HTTP de OpenRouter.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// tests/content/intake-suggestion-budget.test.ts
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

  it("true (fail open) si la lectura de Supabase lanza", async () => {
    const result = await hasIntakeSuggestionBudget({} as never, "org-1", 0.01, {
      getMonthToDateSpendUsd: vi.fn().mockRejectedValue(new Error("db down")),
      getMonthlyBudgetUsd: vi.fn().mockResolvedValue(5),
    });
    expect(result).toBe(true);
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
    consoleError.mockRestore();
  });
});
```

- [ ] **Step 2: Correr, confirmar que fallan**

- [ ] **Step 3: Implementar**

```typescript
// lib/content/intake-suggestion-budget.ts
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
 * a real automation_jobs row, and this call must feel instant. Fails open
 * (true) on a Supabase read error — an interactive suggestion is optional,
 * never worth blocking the user's form over a transient read failure.
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
    return true;
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
}
```

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add lib/content/intake-suggestion-budget.ts tests/content/intake-suggestion-budget.test.ts
git commit -m "feat: add soft budget gate and usage ledger write for intake suggestions"
```

---

## Task 5: `POST /api/content/suggestions` — la ruta

**Files:**
- Create: `app/api/content/suggestions/route.ts`
- Test: `tests/api/content-suggestions.test.ts`

**Auth sin camino de demo** (hallazgo del spec, sección "Contrato de la
API"): `createContentRepository()` (usado por `POST /api/content`) cae en
modo demo sin pedir ninguna sesión cuando no hay configuración de
Supabase — eso está bien para el intake normal, pero esta ruta llama a
OpenRouter con presupuesto real y **nunca** debe ser alcanzable sin una
organización real. No reuses `createContentRepository()` tal cual — mira
`lib/content/repository-factory.ts:140-193` (la rama `mode === "supabase"`)
como referencia de qué helpers usar (`getContentRepositoryMode`,
`createSupabaseServerClient`, `createSupabaseServiceRoleClient`,
`selectOrganizationMembership`, `requireOrganizationContext`), pero trata
`mode === "demo"` igual que `mode === "misconfigured"` — ambos son 503
aquí, ninguno es "sin auth, sigue adelante".

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// tests/api/content-suggestions.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSuggestionsHandler } from "@/app/api/content/suggestions/route";

function multipartRequest(file: File): Request {
  const formData = new FormData();
  formData.append("asset", file);
  return new Request("https://orbit.example/api/content/suggestions", { method: "POST", body: formData });
}

const validPngBytes = /* mismo fixture PNG mínimo que ya usan otros tests de validateAsset — revisa tests/content/*.test.ts existentes para el helper compartido, no inventes uno nuevo */ new Uint8Array();

describe("POST /api/content/suggestions", () => {
  it("401 sin organización resuelta (sin sesión)", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockRejectedValue(new (class extends Error {})()),
    } as never);
    const response = await handler(multipartRequest(new File([validPngBytes], "a.png", { type: "image/png" })));
    expect(response.status).toBe(401);
  });

  it("400 si el archivo no pasa validateAsset", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
    } as never);
    const response = await handler(multipartRequest(new File([new Uint8Array([1, 2, 3])], "bad.txt")));
    expect(response.status).toBe(400);
  });

  it("200 con sugerencias cuando todo sale bien", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(true),
      fetchSuggestions: vi.fn().mockResolvedValue({
        suggestions: { niche: "clinicas", contentType: null, objective: null, humanDescription: null, offer: null, cta: null },
        usage: { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
      }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as never);
    const response = await handler(multipartRequest(new File([validPngBytes], "a.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    const body = await response.json() as { suggestions: unknown };
    expect(body.suggestions).toMatchObject({ niche: "clinicas" });
  });

  it("200 con suggestions:null cuando no hay presupuesto (no llama OpenRouter)", async () => {
    const fetchSuggestions = vi.fn();
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(false),
      fetchSuggestions,
    } as never);
    const response = await handler(multipartRequest(new File([validPngBytes], "a.png", { type: "image/png" })));
    expect(response.status).toBe(200);
    expect((await response.json() as { suggestions: unknown }).suggestions).toBeNull();
    expect(fetchSuggestions).not.toHaveBeenCalled();
  });

  it("503 cuando falta configuración del proveedor", async () => {
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(true),
      fetchSuggestions: vi.fn().mockRejectedValue(new Error("SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL is required for intake suggestions.")),
    } as never);
    const response = await handler(multipartRequest(new File([validPngBytes], "a.png", { type: "image/png" })));
    expect(response.status).toBe(503);
  });

  it("registra el uso cuando hubo respuesta real de OpenRouter, incluso si suggestions terminó null", async () => {
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const handler = createSuggestionsHandler({
      resolveOrganization: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      hasBudget: vi.fn().mockResolvedValue(true),
      fetchSuggestions: vi.fn().mockResolvedValue({
        suggestions: null,
        usage: { provider: "openrouter", model: "m", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.001 },
      }),
      recordUsage,
    } as never);
    await handler(multipartRequest(new File([validPngBytes], "a.png", { type: "image/png" })));
    expect(recordUsage).toHaveBeenCalledWith("org-1", expect.objectContaining({ model: "m" }));
  });
});
```

Revisa `tests/content/`/`tests/api/` existentes para encontrar el fixture
de bytes PNG mínimos válidos que ya usan otros tests de `validateAsset` —
reutilízalo en vez de inventar uno nuevo (`validPngBytes` arriba es un
placeholder que debes reemplazar por el fixture real).

- [ ] **Step 2: Correr, confirmar que fallan**

- [ ] **Step 3: Implementar**

```typescript
// app/api/content/suggestions/route.ts
import { AssetValidationError, validateAsset } from "@/lib/content/asset-validation";
import { fetchIntakeSuggestions } from "@/lib/content/intake-suggestions";
import { hasIntakeSuggestionBudget, recordIntakeSuggestionUsage } from "@/lib/content/intake-suggestion-budget";

const MAX_REQUEST_COST_USD = Number(process.env.SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD ?? "0.01");

class SuggestionAuthenticationError extends Error {}
class SuggestionConfigurationError extends Error {}

type ResolvedOrganization = { organizationId: string };

type SuggestionsHandlerDependencies = {
  resolveOrganization?: () => Promise<ResolvedOrganization>;
  hasBudget?: (organizationId: string) => Promise<boolean>;
  fetchSuggestions?: typeof fetchIntakeSuggestions;
  recordUsage?: (organizationId: string, usage: NonNullable<Awaited<ReturnType<typeof fetchIntakeSuggestions>>["usage"]>) => Promise<void>;
};

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * No demo/anonymous path — deliberately does not reuse
 * createContentRepository(), which falls back to an unauthenticated demo
 * repository when Supabase isn't configured. This route spends real
 * OpenRouter budget and must always resolve a real organization or fail.
 */
async function defaultResolveOrganization(): Promise<ResolvedOrganization> {
  const { getContentRepositoryMode } = await import("@/lib/content/repository-factory");
  const mode = getContentRepositoryMode();
  if (mode !== "supabase") throw new SuggestionConfigurationError();

  const { createSupabaseServerClient } = await import("@/lib/supabase/server");
  const sessionClient = await createSupabaseServerClient();
  const { data: { user }, error } = await sessionClient.auth.getUser();
  if (error || !user) throw new SuggestionAuthenticationError();

  const { data: memberships, error: membershipError } = await sessionClient
    .from("organization_members")
    .select("organization_id, user_id, role")
    .eq("user_id", user.id);
  if (membershipError) throw new SuggestionConfigurationError();

  const { selectOrganizationMembership } = await import("@/lib/content/repository-factory");
  const { requireOrganizationContext } = await import("@/lib/organizations/context");
  const candidate = selectOrganizationMembership((memberships ?? []) as never);
  const organization = await requireOrganizationContext(candidate.organizationId, {
    getSession: async () => ({ userId: user.id }),
    getMembership: async ({ organizationId, userId }) =>
      candidate.organizationId === organizationId && candidate.userId === userId
        ? { organizationId: candidate.organizationId, userId: candidate.userId, role: candidate.role }
        : null,
  });
  return { organizationId: organization.organizationId };
}

async function defaultHasBudget(organizationId: string): Promise<boolean> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server");
  return hasIntakeSuggestionBudget(createSupabaseServiceRoleClient(), organizationId, MAX_REQUEST_COST_USD);
}

async function defaultRecordUsage(
  organizationId: string,
  usage: NonNullable<Awaited<ReturnType<typeof fetchIntakeSuggestions>>["usage"]>,
): Promise<void> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server");
  await recordIntakeSuggestionUsage(createSupabaseServiceRoleClient(), organizationId, usage);
}

function isFilePart(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value !== "string" && typeof value.arrayBuffer === "function");
}

async function toDataUrl(file: File, mimeType: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

export function createSuggestionsHandler(
  dependencies: SuggestionsHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  const resolveOrganization = dependencies.resolveOrganization ?? defaultResolveOrganization;
  const hasBudget = dependencies.hasBudget ?? defaultHasBudget;
  const fetchSuggestions = dependencies.fetchSuggestions ?? fetchIntakeSuggestions;
  const recordUsage = dependencies.recordUsage ?? defaultRecordUsage;

  return async function handleSuggestions(request: Request): Promise<Response> {
    let organizationId: string;
    try {
      ({ organizationId } = await resolveOrganization());
    } catch (error) {
      if (error instanceof SuggestionConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      return jsonError("AUTHENTICATION_REQUIRED", 401);
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_MULTIPART_REQUEST", 400);
    }
    const assetFile = formData.get("asset");
    if (!isFilePart(assetFile)) return jsonError("ASSET_REQUIRED", 400);

    let validatedAsset: Awaited<ReturnType<typeof validateAsset>>;
    try {
      validatedAsset = await validateAsset(assetFile);
    } catch (error) {
      if (error instanceof AssetValidationError) return jsonError("INVALID_ASSET", 400);
      return jsonError("ASSET_VALIDATION_FAILED", 400);
    }

    if (!(await hasBudget(organizationId))) {
      return Response.json({ suggestions: null });
    }

    try {
      const imageDataUrl = await toDataUrl(assetFile, validatedAsset.mimeType);
      const result = await fetchSuggestions({ imageDataUrl, environment: process.env });
      if (result.usage) {
        await recordUsage(organizationId, result.usage);
      }
      return Response.json({ suggestions: result.suggestions });
    } catch {
      // fetchIntakeSuggestions only throws for missing required
      // configuration (model/API key/prices) — a real deployment problem,
      // not something the client can retry past.
      return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    }
  };
}

export const POST = createSuggestionsHandler();
```

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add app/api/content/suggestions/route.ts tests/api/content-suggestions.test.ts
git commit -m "feat: add POST /api/content/suggestions endpoint"
```

---

## Task 6: `ContentForm` — `userEditedFields` y el merge de sugerencias

**Files:**
- Modify: `components/content/content-form.tsx`
- Test: `tests/components/content-form.test.tsx` (revisa el nombre exacto del test existente antes de asumirlo — extiéndelo, no lo reemplaces)

Esta es la tarea más delicada del plan — la lógica de procedencia pasó por
tres rondas de revisión externa. Sigue el diseño del spec exactamente:

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
it("las sugerencias de la imagen llenan contentType/objective aunque tengan un valor default no vacío", async () => {
  // render ContentForm con un fetch mockeado de /api/content/suggestions
  // que regresa contentType: "venta_directa" — verificar que el select
  // de contentType termina en "venta_directa", no en su default original.
});

it("una edición manual del usuario nunca se sobrescribe por una sugerencia posterior, incluso si el usuario la deja vacía", async () => {
  // el usuario escribe algo en niche, lo borra a mano (queda "")
  // llega una sugerencia de imagen con niche: "clinicas"
  // niche debe seguir vacío, no "clinicas"
});

it("una edición manual en un <select> también cuenta como editado", async () => {
  // el usuario cambia contentType a mano
  // llega una sugerencia posterior con un contentType distinto
  // el valor debe seguir siendo el que el usuario eligió
});

it("una segunda imagen reemplaza las sugerencias no tocadas de la primera", async () => {
  // primera imagen sugiere niche: "clinicas", el usuario no lo toca
  // segunda imagen (el usuario cambia el archivo) sugiere niche: "spas"
  // niche debe terminar en "spas"
});

it("applyProfile() (defaults de AIAS) no sobrescribe un campo ya editado por el usuario", async () => {
  // el usuario edita humanDescription a mano ANTES de que resuelva el fetch del perfil AIAS
  // cuando el perfil AIAS resuelve, humanDescription debe seguir siendo lo que el usuario escribió
});

it("un campo sugerido en null no toca el campo existente", async () => {
  // offer ya tiene un valor (de AIAS o de una sugerencia anterior)
  // llega una nueva sugerencia con offer: null
  // offer no cambia
});
```

- [ ] **Step 2: Correr, confirmar que fallan**

- [ ] **Step 3: Implementar**

Agrega el estado de procedencia y el efecto de sugerencias. Puntos clave
del diseño (ver spec para el razonamiento completo):

```typescript
// dentro de ContentForm, junto a los demás useState:
const [userEditedFields, setUserEditedFields] = useState<Set<keyof FormState>>(
  () => new Set(),
);

// updateField (ya existe) es el único punto de entrada de TODO cambio
// disparado por el usuario, sea <input>, <textarea>, <select> o <datalist>
// — todos los campos de este formulario ya pasan por acá. Marca el campo
// como editado de forma permanente:
function updateField<Key extends keyof FormState>(field: Key, value: FormState[Key]) {
  setState((current) => ({ ...current, [field]: value }));
  setUserEditedFields((current) => {
    if (current.has(field)) return current;
    const next = new Set(current);
    next.add(field);
    return next;
  });
  setSuccess(false);
  setSubmitError(null);
}
```

`applyProfile()` (el efecto existente de defaults de AIAS) debe filtrar
por `userEditedFields` de la misma forma — cambia su `setState` para no
tocar ningún campo ya en el set (usa la forma funcional de `setState` para
leer `userEditedFields` actual sin agregarlo como dependencia del efecto,
o pásalo por una ref si hace falta evitar reruns del efecto).

Nuevo efecto para las sugerencias de imagen (dispara cuando `files[0]`
cambia a un archivo distinto — usa una key derivada del archivo, p. ej.
`` `${file.name}:${file.size}:${file.lastModified}` ``, para detectar
"es un archivo distinto" sin comparar objetos `File` por referencia):

```typescript
const [suggestionsLoading, setSuggestionsLoading] = useState(false);
const [suggestionsApplied, setSuggestionsApplied] = useState(false);

useEffect(() => {
  const file = files[0];
  if (!file || !isProductionMode) return;
  let cancelled = false;
  setSuggestionsLoading(true);
  setSuggestionsApplied(false);

  void (async () => {
    try {
      const formData = new FormData();
      formData.append("asset", file);
      const response = await fetch("/api/content/suggestions", { method: "POST", body: formData, credentials: "same-origin" });
      if (!response.ok || cancelled) return;
      const payload = (await response.json()) as { suggestions: Record<string, unknown> | null };
      if (!payload.suggestions || cancelled) return;

      setState((current) => {
        const next = { ...current };
        for (const [key, value] of Object.entries(payload.suggestions!)) {
          const field = key as keyof FormState;
          if (value === null || value === undefined) continue;
          if (userEditedFields.has(field)) continue;
          (next as Record<string, unknown>)[field] = value;
        }
        return next;
      });
      setUserEditedFields((current) => current); // no-op: sugerencias no marcan el campo como editado
      if (!cancelled) setSuggestionsApplied(true);
    } catch {
      // Análisis opcional — el formulario sigue siendo 100% usable sin él.
    } finally {
      if (!cancelled) setSuggestionsLoading(false);
    }
  })();

  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- userEditedFields se lee, no se re-suscribe: no queremos re-disparar el fetch cuando el usuario edita un campo, solo cuando cambia el archivo.
}, [files, isProductionMode]);
```

Banner nuevo, junto al banner existente de AIAS (no lo reemplaces):
```tsx
{suggestionsLoading ? (
  <p className="rounded-xl border border-cyan-200/15 bg-cyan-200/[0.04] px-4 py-3 text-xs leading-5 text-cyan-100">
    Analizando tu creativo…
  </p>
) : null}
{suggestionsApplied && !suggestionsLoading ? (
  <p className="rounded-xl border border-cyan-200/15 bg-cyan-200/[0.04] px-4 py-3 text-xs leading-5 text-cyan-100">
    ✨ Sugerido por tu imagen — revisa antes de continuar.
  </p>
) : null}
```

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add components/content/content-form.tsx tests/components/content-form.test.tsx
git commit -m "feat: apply image-derived suggestions with one-way edit provenance"
```

---

## Task 7: reordenar el formulario — imagen primero

**Files:**
- Modify: `components/content/content-form.tsx`

- [ ] **Step 1: Mover la sección que contiene `<AssetDropzone>` al primer
  lugar visual del `<form>`**, antes de la sección "Contexto comercial".
  Las demás secciones conservan su orden relativo entre sí. El campo CTA
  se queda donde está hoy (en la misma sección que `AssetDropzone`, ver el
  archivo actual) — solo se mueve la sección completa, no se reparten sus
  campos.
- [ ] **Step 2: Correr la suite de tests de este componente, confirmar que
  sigue en verde** (reordenar no debería romper ningún test si los
  selectores usan roles/labels y no orden de DOM — si algún test asume
  orden, ajústalo).

Run: `npm test -- --run tests/components/content-form.test.tsx`

- [ ] **Step 3: Commit**

```bash
git add components/content/content-form.tsx
git commit -m "refactor: move the image dropzone to the top of the intake form"
```

---

## Task 8: Verificación final

- [ ] **Step 1:** `npm test -- --run` (suite completa) — todo verde.
- [ ] **Step 2:** `npx tsc --noEmit` — sin errores.
- [ ] **Step 3:** `npm run lint` — sin errores.
- [ ] **Step 4:** `npm run build` — build exitoso.
- [ ] **Step 5:** Revisar `git diff feat/personal-pilot-hardening...HEAD` completo por si quedó algo suelto (`console.log` de depuración, comentario TODO, etc.).
- [ ] **Step 6:** Commit final si quedó algo suelto.

---

## Nota para quien despache esto a Codex CLI

Tareas 1-5 son secuenciales (cada una depende de la anterior: la migración
antes que el módulo de presupuesto, el módulo de presupuesto y el de
OpenRouter antes que la ruta). Tarea 6 depende de que la Tarea 5 exista
(el fetch a `/api/content/suggestions`). Tarea 7 es independiente y puede
ir en paralelo con la 6 si se dispachan por separado, pero como ambas
tocan `content-form.tsx`, es más simple despacharlas en secuencia para
evitar conflictos de merge entre dos procesos de Codex escribiendo el
mismo archivo a la vez. Incluye la regla de seguridad de git y la nota de
`.codebase-memory/` en cada prompt.
