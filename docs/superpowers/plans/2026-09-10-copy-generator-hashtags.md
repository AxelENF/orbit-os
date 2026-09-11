# Generador de copy real con hashtags — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar la generación de copy simulada por una real (OpenRouter con visión, 2 alternativas + 5-8 hashtags), disparada automáticamente al crear contenido, con guardrails de presupuesto/calidad y sin tocar la aprobación humana ni el bridge n8n.

**Architecture:** Worker interno (`worker/entrypoint.ts`) reclama jobs `COPY` vía `SupabaseCopyWorkerStore`; un nuevo `worker/providers/copy-processor.ts` llama a OpenRouter, valida forma/claims/presupuesto y completa el job. Una migración aditiva (`0014`) agrega la columna `hashtags`, una bitácora de costo de IA y un tope mensual opcional por organización, y extiende `fail_copy_automation_job` para que un fallo terminal deje rastro visible (`content_items` → `ERROR`, `audit_events`). `POST /api/content` encola el job automáticamente al crear un creativo — hoy nada lo hace.

**Tech Stack:** Next.js API routes, Supabase (Postgres + RPCs), Vitest + Testing Library, fetch nativo (sin SDK de OpenRouter), TypeScript.

**Spec de referencia:** [`docs/superpowers/specs/2026-09-10-copy-generator-hashtags-design.md`](../specs/2026-09-10-copy-generator-hashtags-design.md)

**Nota de alcance sobre `forbiddenClaims` (descubierta durante la planificación, no estaba en el spec):**
`content_items` no tiene ninguna columna de `forbidden_claims` en ningún migration (`grep forbidden` sobre `supabase/migrations/*.sql` no devuelve nada), así que el brief que arma `claim_next_copy_automation_job` (0013) nunca trae `forbiddenClaims`. En este código base, los claims prohibidos viven en el perfil AIAS de la organización (`organization_brand_profiles.aias_profile->>'forbiddenClaims'`, migración `0011`), no en el post. El Task 6 hace una lectura adicional de esa tabla para poder cumplir la promesa del spec ("valida contra allowedFacts/forbiddenClaims"). No se modifica el esquema de `content_items` ni la RPC de `0013` — es sólo una lectura nueva desde el processor.

**Nota de alcance sobre el recorrido completo de hashtags (también descubierta durante la planificación):**
El spec promete que los hashtags "aparecen editables antes de enviar a revisión, igual que hoy con headline/body/cta". Cumplir eso literalmente requiere que los hashtags viajen por *todo* el camino de lectura/escritura, no sólo que el worker los genere: `StoredCopyDraft` (lectura de un borrador), el editor de borrador, y la pieza inmutable `final_copy_versions` que de verdad se envía a revisión. Los Tasks 1-9 cubren generación y guardado en `copy_drafts`; los **Tasks 10 y 11** cierran el resto del recorrido.

---

## Antes de empezar

```bash
cd "C:\Users\AxelENF\Documents\Codex\2026-08-27\pode\snapgad-content-os"
npm test -- --run
```
Expected: `50 archivos / 263 tests`, todos pasan (línea base antes de tocar nada).

---

### Task 1: Migración `0014` — hashtags, bitácora de costo y presupuesto

**Files:**
- Create: `supabase/migrations/0014_copy_hashtags_and_ai_usage.sql`
- Test: `tests/content/copy-hashtags-migration.test.ts`

- [ ] **Step 1: Escribe el test que falla**

```typescript
// tests/content/copy-hashtags-migration.test.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0014_copy_hashtags_and_ai_usage.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("copy hashtags and AI usage migration", () => {
  it("adds a bounded hashtags column to copy_drafts", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.copy_drafts/i);
    expect(sql).toMatch(/add column hashtags jsonb not null default '\[\]'::jsonb/i);
    expect(sql).toMatch(/jsonb_array_length\(hashtags\)\s*<=\s*8/i);
  });

  it("extends ingest_copy_result_callback to accept and validate hashtags", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create or replace function public\.ingest_copy_result_callback/i);
    expect(sql).toMatch(/coalesce\(item\.draft -> 'hashtags', '\[\]'::jsonb\)/i);
    expect(sql).toMatch(/jsonb_array_length\(item\.draft -> 'hashtags'\)\s*>\s*8/i);
  });

  it("creates an append-only ai_usage_events ledger scoped by organization", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create table public\.ai_usage_events/i);
    expect(sql).toMatch(/organization_id uuid not null references public\.organizations/i);
    expect(sql).toMatch(/estimated_cost_usd numeric/i);
    expect(sql).toMatch(/is_organization_member\(organization_id\)/i);
  });

  it("adds an optional monthly AI budget cap to organizations", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.organizations/i);
    expect(sql).toMatch(/add column ai_monthly_budget_usd numeric/i);
  });

  it("extends fail_copy_automation_job to transition content on terminal failure", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create or replace function public\.fail_copy_automation_job/i);
    expect(sql).toMatch(/next_status in \('FAILED', 'DEAD_LETTER'\)/i);
    expect(sql).toMatch(/set state = 'ERROR'::public\.content_state/i);
    expect(sql).toMatch(/'COPY_JOB_FAILED'/i);
  });
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/content/copy-hashtags-migration.test.ts`
Expected: FAIL — `ENOENT` (el archivo de migración no existe todavía).

- [ ] **Step 3: Escribe la migración**

```sql
-- supabase/migrations/0014_copy_hashtags_and_ai_usage.sql
-- Additive migration. Not yet applied to a live project by this repository.

-- 1. Hashtags on stored copy drafts. Deliberately looser (0-8) than the
--    processor's own 5-8 guardrail, so an inactive n8n path that never
--    sends hashtags keeps working unchanged.
--    Postgres CHECK constraints cannot contain subqueries (including a
--    `select ... from jsonb_array_elements_text(...)`), so only the
--    subquery-free part (type + max length) is enforced here. The
--    non-empty-string-per-tag rule is enforced in
--    ingest_copy_result_callback below, which is a function body and can
--    use EXISTS/subqueries freely.
alter table public.copy_drafts
  add column hashtags jsonb not null default '[]'::jsonb
  check (
    jsonb_typeof(hashtags) = 'array'
    and jsonb_array_length(hashtags) <= 8
  );

-- 2. ingest_copy_result_callback: same name and signature, now also reads
--    and validates an optional `hashtags` array per draft.
create or replace function public.ingest_copy_result_callback(
  p_content_item_id uuid,
  p_idempotency_key uuid,
  p_visual_analysis jsonb,
  p_drafts jsonb,
  p_warnings jsonb,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  callback_run_id uuid;
  content_owner_id uuid;
  current_state public.content_state;
  request_content_item_id uuid;
begin
  if jsonb_typeof(p_visual_analysis) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_VISUAL_ANALYSIS';
  end if;
  if jsonb_typeof(p_warnings) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_WARNINGS';
  end if;
  if jsonb_typeof(p_drafts) is distinct from 'array' or jsonb_array_length(p_drafts) <> 2 then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_DRAFTS';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_drafts) as item(draft)
    where jsonb_typeof(item.draft) <> 'object'
      or nullif(btrim(item.draft ->> 'headline'), '') is null
      or nullif(btrim(item.draft ->> 'body'), '') is null
      or nullif(btrim(item.draft ->> 'cta'), '') is null
      or (item.draft ? 'hashtags' and jsonb_typeof(item.draft -> 'hashtags') <> 'array')
      or (item.draft ? 'hashtags' and jsonb_array_length(item.draft -> 'hashtags') > 8)
      or exists (
        select 1
        from jsonb_array_elements_text(coalesce(item.draft -> 'hashtags', '[]'::jsonb)) as tag
        where nullif(btrim(tag), '') is null
      )
  ) then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_DRAFTS';
  end if;

  select owner_id, state
  into content_owner_id, current_state
  from public.content_items
  where id = p_content_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_RESULT_CONTENT_NOT_FOUND';
  end if;

  select content_item_id
  into request_content_item_id
  from public.automation_runs
  where kind = 'COPY_REQUEST'
    and idempotency_key = p_idempotency_key;

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_REQUEST_NOT_FOUND';
  end if;
  if request_content_item_id <> p_content_item_id then
    raise exception using errcode = 'P0001', message = 'COPY_REQUEST_IDEMPOTENCY_KEY_REUSED';
  end if;

  insert into public.automation_runs (
    owner_id,
    content_item_id,
    kind,
    idempotency_key,
    status,
    response_payload
  ) values (
    content_owner_id,
    p_content_item_id,
    'COPY_CALLBACK',
    p_idempotency_key,
    'RECEIVED',
    jsonb_build_object(
      'visualAnalysis', p_visual_analysis,
      'drafts', p_drafts,
      'warnings', p_warnings,
      'provider', p_provider,
      'model', p_model
    )
  )
  on conflict (kind, idempotency_key) do nothing
  returning id into callback_run_id;

  if callback_run_id is null then
    return jsonb_build_object('created', false);
  end if;

  if current_state <> 'GENERATING' then
    raise exception using errcode = 'P0001', message = 'COPY_RESULT_INVALID_STATE';
  end if;

  insert into public.copy_drafts (
    owner_id,
    content_item_id,
    visual_analysis,
    headline,
    body,
    cta,
    hashtags,
    provider,
    model,
    revision
  )
  select
    content_owner_id,
    p_content_item_id,
    p_visual_analysis,
    item.draft ->> 'headline',
    item.draft ->> 'body',
    item.draft ->> 'cta',
    coalesce(item.draft -> 'hashtags', '[]'::jsonb),
    p_provider,
    p_model,
    item.ordinality::integer
  from jsonb_array_elements(p_drafts) with ordinality as item(draft, ordinality)
  order by item.ordinality;

  insert into public.audit_events (
    owner_id,
    content_item_id,
    event_type,
    metadata
  ) values (
    content_owner_id,
    p_content_item_id,
    'COPY_CALLBACK_RECEIVED',
    jsonb_build_object(
      'draftCount', jsonb_array_length(p_drafts),
      'warningCount', jsonb_array_length(p_warnings)
    )
  );

  update public.content_items
  set state = 'DRAFT'
  where id = p_content_item_id
    and state = 'GENERATING';

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_RESULT_INVALID_STATE';
  end if;

  update public.automation_runs
  set status = 'COMPLETED', completed_at = now()
  where id = callback_run_id;

  return jsonb_build_object('created', true);
end;
$$;

revoke all on function public.ingest_copy_result_callback(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.ingest_copy_result_callback(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) to service_role;

-- 3. Append-only AI usage ledger. Same spirit as audit_events: only the
--    worker (service_role) writes it; organization members can read it.
create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  job_id uuid references public.automation_jobs(id) on delete restrict,
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  estimated_cost_usd numeric(10, 4) not null check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index ai_usage_events_organization_created_idx
  on public.ai_usage_events (organization_id, created_at);
alter table public.ai_usage_events enable row level security;
create policy "Members read organization ai usage" on public.ai_usage_events
  for select to authenticated using (public.is_organization_member(organization_id));

-- 4. Optional monthly AI spend cap per organization. NULL = no cap, so
--    existing organizations are unaffected until Axel sets one explicitly.
alter table public.organizations
  add column ai_monthly_budget_usd numeric(10, 2)
  check (ai_monthly_budget_usd is null or ai_monthly_budget_usd >= 0);

-- 5. fail_copy_automation_job: same name and signature. A terminal failure
--    (FAILED or DEAD_LETTER — it will not be retried) now also moves the
--    stuck content_item out of GENERATING and leaves an audit trail, so
--    /drafts stops polling and /history shows what happened. A RETRY_WAIT
--    outcome leaves content_items untouched; the worker will try again.
create or replace function public.fail_copy_automation_job(
  p_job_id uuid,
  p_idempotency_key uuid,
  p_lease_token uuid,
  p_error text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  job public.automation_jobs%rowtype;
  next_status public.automation_job_status;
  next_due timestamptz;
  item_owner_id uuid;
begin
  if p_error is null or length(btrim(p_error)) = 0 or length(p_error) > 2000 then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_ERROR_INVALID';
  end if;

  select * into job
  from public.automation_jobs
  where id = p_job_id
    and kind = 'COPY'
    and idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_NOT_FOUND';
  end if;
  if job.status <> 'PROCESSING'
     or job.lease_token <> p_lease_token
     or job.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_LEASE_INVALID';
  end if;

  if p_retryable is false then
    next_status := 'FAILED';
    next_due := now();
  elsif job.attempt_count >= job.max_attempts then
    next_status := 'DEAD_LETTER';
    next_due := now();
  else
    next_status := 'RETRY_WAIT';
    next_due := greatest(
      job.run_at,
      now() + make_interval(secs => least(3600, (2 ^ greatest(job.attempt_count - 1, 0))::integer))
    );
  end if;

  update public.automation_jobs
  set status = next_status,
      next_attempt_at = next_due,
      sanitized_error = left(btrim(p_error), 2000),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = job.id;

  if next_status in ('FAILED', 'DEAD_LETTER') then
    select owner_id into item_owner_id
    from public.content_items
    where id = job.content_item_id
      and organization_id = job.organization_id
    for update;

    if found then
      update public.content_items
      set state = 'ERROR'::public.content_state
      where id = job.content_item_id
        and organization_id = job.organization_id
        and state = 'GENERATING';

      insert into public.audit_events (
        organization_id, owner_id, content_item_id, event_type, metadata
      ) values (
        job.organization_id, item_owner_id, job.content_item_id, 'COPY_JOB_FAILED',
        jsonb_build_object(
          'jobId', job.id,
          'status', next_status,
          'error', left(btrim(p_error), 2000)
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'state', next_status,
    'jobId', job.id,
    'attempts', job.attempt_count,
    'nextAttemptAt', next_due
  );
end;
$$;

revoke all on function public.fail_copy_automation_job(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_copy_automation_job(uuid, uuid, uuid, text, boolean)
  to service_role;
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/content/copy-hashtags-migration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verifica que la suite completa sigue pasando**

Run: `npm test -- --run`
Expected: `51 archivos` (uno más), todos pasan.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0014_copy_hashtags_and_ai_usage.sql tests/content/copy-hashtags-migration.test.ts
git commit -m "feat: add copy hashtags, AI usage ledger, and budget cap migration"
```

---

### Task 2: Hashtags en el contrato de copy final

**Files:**
- Modify: `lib/content/final-copy.ts`
- Test: Create `tests/content/final-copy.test.ts`

- [ ] **Step 1: Escribe el test que falla**

```typescript
// tests/content/final-copy.test.ts
import { describe, expect, it } from "vitest";

import { validateFinalCopy } from "@/lib/content/final-copy";

const baseBrief = {
  allowedFacts: ["El bot atiende preguntas y ayuda a agendar citas."],
  forbiddenClaims: ["Resultados garantizados"],
};

describe("validateFinalCopy — hashtags", () => {
  it("requires headline, body, and cta as before, independent of hashtags", () => {
    const result = validateFinalCopy(
      { headline: "", body: "Texto", cta: "Escribe AGENDA", hashtags: ["#Agenda"] },
      baseBrief,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a hashtag that repeats a forbidden claim, even camelCase and with no spaces", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "El bot atiende preguntas y ayuda a agendar citas.",
        cta: "Escribe AGENDA",
        hashtags: ["#ResultadosGarantizados"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/prohibida/i);
  });

  it("rejects a hashtag with an unsupported absolute promise not grounded in allowedFacts", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "El bot atiende preguntas y ayuda a agendar citas.",
        cta: "Escribe AGENDA",
        hashtags: ["#DuplicaTusVentas"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts hashtags grounded in allowedFacts or free of risky claims", () => {
    const result = validateFinalCopy(
      {
        headline: "Más control",
        body: "El bot atiende preguntas y ayuda a agendar citas.",
        cta: "Escribe AGENDA",
        hashtags: ["#AutomatizacionWhatsApp", "#NegociosMexico"],
      },
      baseBrief,
    );
    expect(result.ok).toBe(true);
  });

  it("treats a missing hashtags field as an empty list without throwing", () => {
    const result = validateFinalCopy(
      { headline: "Más control", body: "El bot atiende preguntas y ayuda a agendar citas.", cta: "Escribe AGENDA" },
      baseBrief,
    );
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/content/final-copy.test.ts`
Expected: FAIL — TypeScript error o assertion fallida (`hashtags` no existe en `FinalCopyInput`).

- [ ] **Step 3: Extiende `final-copy.ts`**

Modify `lib/content/final-copy.ts`:

```typescript
export type FinalCopyInput = {
  headline: string;
  body: string;
  cta: string;
  hashtags?: string[];
};
```

Un hashtag es un solo token sin espacios (`#ResultadosGarantizados`,
`#DuplicaTusVentas`). `containsForbiddenClaim` compara con `.includes()` de
substring y `unsupportedClaimPattern` usa `\b...\b` (límites de palabra) —
ninguno de los dos detecta un claim "pegado" dentro de un token CamelCase sin
separadores (`"resultadosgarantizados"` nunca contiene `"resultados
garantizados"` como substring). Por eso no basta con unir los hashtags al
texto tal cual: hay que separar sus palabras primero. Agrega este helper
privado arriba de `validateFinalCopy`:

```typescript
/**
 * A hashtag has no internal spaces, so a claim embedded in a CamelCase tag
 * (`#ResultadosGarantizados`) would never match `containsForbiddenClaim`'s
 * substring check or `unsupportedClaimPattern`'s `\b...\b` boundaries. This
 * inserts spaces at lower→upper transitions so hashtag text is checked the
 * same way as normal prose.
 */
function expandHashtagWords(tag: string): string {
  return tag.replace(/^#/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}
```

Y en `validateFinalCopy`, cambia la construcción de `combined` (línea ~49) para incluir las palabras expandidas de cada hashtag en el mismo texto que ya se valida:

```typescript
  const headline = normalize(input.headline);
  const body = normalize(input.body);
  const cta = normalize(input.cta);
  const hashtagWords = (input.hashtags ?? []).map((tag) => expandHashtagWords(normalize(tag)));
  const combined = [headline, body, cta, ...hashtagWords].join(" ").trim();
```

El resto de la función (`containsForbiddenClaim`, `unsupportedClaimPattern.test`, `isGroundedInAllowedFacts`) no cambia: ya opera sobre `combined`, así que las palabras de los hashtags heredan automáticamente la misma validación que headline/body/cta.

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/content/final-copy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Corre la suite de `final-copy` existente para confirmar que no rompiste nada**

Run: `npx vitest run tests/api/final-copy.test.ts`
Expected: PASS (sin cambios de comportamiento para llamadas sin `hashtags`).

- [ ] **Step 6: Commit**

```bash
git add lib/content/final-copy.ts tests/content/final-copy.test.ts
git commit -m "feat: validate hashtags with the same claims guardrail as copy body"
```

---

### Task 3: Hashtags en el store demo (paridad visual)

**Files:**
- Modify: `lib/demo/draft-store.ts`
- Test: Modify `tests/content/demo-draft-store.test.ts`

- [ ] **Step 1: Lee el test existente para entender el patrón**

Run: `npx vitest run tests/content/demo-draft-store.test.ts` (debe pasar tal cual, como línea base).

- [ ] **Step 2: Agrega un caso que falla**

Añade a `tests/content/demo-draft-store.test.ts` (junto a los tests existentes de `createDraftRecord`/`persistDemoDraft`):

```typescript
it("gives each local draft a deterministic, non-empty hashtag list", () => {
  const record = persistDemoDraft(/* usa el mismo setup que el test existente de creación */);
  for (const draft of record!.drafts) {
    expect(draft.hashtags.length).toBeGreaterThanOrEqual(1);
    expect(draft.hashtags.every((tag) => tag.startsWith("#"))).toBe(true);
  }
});
```

(Ajusta el setup exacto al fixture que ya usa el archivo — reutiliza el mismo asset/contenido que el resto de la suite, no inventes uno nuevo.)

- [ ] **Step 3: Corre el test y confirma que falla**

Run: `npx vitest run tests/content/demo-draft-store.test.ts`
Expected: FAIL — `draft.hashtags` es `undefined`.

- [ ] **Step 4: Extiende `draft-store.ts`**

Modify `lib/demo/draft-store.ts`:

```typescript
export type DemoCopyOption = {
  id: string;
  headline: string;
  body: string;
  cta: string;
  hashtags: string[];
  source: "local-demo";
};
```

Y en `createDraftRecord`, agrega hashtags deterministas a cada alternativa (mismo espíritu que el resto del demo: sin IA, plantilla local basada en el nicho/servicio del brief):

```typescript
  const baseHashtags = [
    `#${content.niche.replaceAll("_", "")}`,
    `#${content.service.replaceAll("_", "")}`,
    "#SnapGad",
  ];
  const firstDraft: DemoCopyOption = {
    id: createId("copy"),
    headline: "Más control para la operación diaria",
    body: `${firstFact} ${content.humanDescription} ${content.cta}.`,
    cta: content.cta,
    hashtags: baseHashtags,
    source: "local-demo",
  };
  const secondDraft: DemoCopyOption = {
    id: createId("copy"),
    headline: "Una atención que sí avanza",
    body: `${secondFact} ${content.humanDescription} Da el siguiente paso: ${content.cta}.`,
    cta: content.cta,
    hashtags: baseHashtags,
    source: "local-demo",
  };
```

Y `finalCopy` (unas líneas abajo) también gana `hashtags: firstDraft.hashtags` para que el tipo `DemoFinalCopy` (ya derivado con `Pick`) siga siendo consistente:

```typescript
export type DemoFinalCopy = Pick<DemoCopyOption, "headline" | "body" | "cta" | "hashtags">;
```

- [ ] **Step 5: Corre el test y confirma que pasa**

Run: `npx vitest run tests/content/demo-draft-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/draft-store.ts tests/content/demo-draft-store.test.ts
git commit -m "feat: give demo copy drafts deterministic hashtags for UI parity"
```

---

### Task 4: Clase de error para guardrails no reintentables

**Files:**
- Create: `worker/providers/copy-guardrail-error.ts`
- Test: Create `tests/worker/copy-guardrail-error.test.ts`

- [ ] **Step 1: Escribe el test que falla**

```typescript
// tests/worker/copy-guardrail-error.test.ts
import { describe, expect, it } from "vitest";

import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";

describe("CopyGuardrailError", () => {
  it("carries a retryable flag on top of a normal Error", () => {
    const error = new CopyGuardrailError("Monthly AI budget exceeded.", false);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CopyGuardrailError");
    expect(error.message).toBe("Monthly AI budget exceeded.");
    expect(error.retryable).toBe(false);
  });

  it("defaults nothing — retryable is always explicit", () => {
    const error = new CopyGuardrailError("Invalid draft shape.", true);
    expect(error.retryable).toBe(true);
  });
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/worker/copy-guardrail-error.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Escribe la implementación**

```typescript
// worker/providers/copy-guardrail-error.ts
/**
 * Signals a guardrail rejection (budget exceeded, forbidden claim) that the
 * copy processor wants to control explicitly instead of letting the durable
 * runner's default "everything is retryable" behavior apply.
 */
export class CopyGuardrailError extends Error {
  public readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CopyGuardrailError";
    this.retryable = retryable;
  }
}
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/worker/copy-guardrail-error.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/providers/copy-guardrail-error.ts tests/worker/copy-guardrail-error.test.ts
git commit -m "feat: add CopyGuardrailError for non-retryable copy job failures"
```

---

### Task 5: Helpers de presupuesto y costo de IA

**Files:**
- Create: `worker/providers/ai-usage.ts`
- Test: Create `tests/worker/ai-usage.test.ts`

- [ ] **Step 1: Escribe el test que falla**

```typescript
// tests/worker/ai-usage.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  estimateCostUsd,
  getMonthToDateSpendUsd,
  getMonthlyBudgetUsd,
  recordAiUsage,
} from "@/worker/providers/ai-usage";

const organizationId = "11111111-1111-4111-8111-111111111111";

function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.gte = vi.fn().mockReturnValue(builder);
  builder.single = vi.fn().mockResolvedValue(result);
  builder.maybeSingle = vi.fn().mockResolvedValue(result);
  builder.then = (resolve: (value: typeof result) => void) => resolve(result);
  return builder;
}

describe("estimateCostUsd", () => {
  it("prices input and output tokens per million and rounds to 4 decimals", () => {
    expect(estimateCostUsd(1_000, 500, 3, 15)).toBeCloseTo(0.0105, 4);
  });

  it("is zero for zero tokens regardless of price", () => {
    expect(estimateCostUsd(0, 0, 3, 15)).toBe(0);
  });
});

describe("getMonthToDateSpendUsd", () => {
  it("sums estimated_cost_usd for the organization since the start of the current month", async () => {
    const rows = chainable({
      data: [{ estimated_cost_usd: "1.5" }, { estimated_cost_usd: "2.25" }],
      error: null,
    });
    const from = vi.fn().mockReturnValue(rows);
    const client = { from } as unknown as SupabaseClient;

    const spend = await getMonthToDateSpendUsd(client, organizationId, new Date("2026-09-15T12:00:00.000Z"));

    expect(spend).toBeCloseTo(3.75, 4);
    expect(from).toHaveBeenCalledWith("ai_usage_events");
    expect(rows.eq).toHaveBeenCalledWith("organization_id", organizationId);
    expect(rows.gte).toHaveBeenCalledWith("created_at", "2026-09-01T00:00:00.000Z");
  });

  it("throws a clean error when Supabase returns an error", async () => {
    const rows = chainable({ data: null, error: { message: "boom" } });
    const client = { from: vi.fn().mockReturnValue(rows) } as unknown as SupabaseClient;

    await expect(getMonthToDateSpendUsd(client, organizationId, new Date())).rejects.toThrow(
      "Unable to read AI usage for the organization.",
    );
  });
});

describe("getMonthlyBudgetUsd", () => {
  it("returns null when the organization has no configured cap", async () => {
    const rows = chainable({ data: { ai_monthly_budget_usd: null }, error: null });
    const client = { from: vi.fn().mockReturnValue(rows) } as unknown as SupabaseClient;

    await expect(getMonthlyBudgetUsd(client, organizationId)).resolves.toBeNull();
  });

  it("returns the configured cap", async () => {
    const rows = chainable({ data: { ai_monthly_budget_usd: 20 }, error: null });
    const client = { from: vi.fn().mockReturnValue(rows) } as unknown as SupabaseClient;

    await expect(getMonthlyBudgetUsd(client, organizationId)).resolves.toBe(20);
  });
});

describe("recordAiUsage", () => {
  it("inserts a usage row with snake_case columns", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient;

    await recordAiUsage(client, {
      organizationId,
      jobId: "22222222-2222-4222-8222-222222222222",
      provider: "openrouter",
      model: "some/vision-model",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.0105,
    });

    expect(insert).toHaveBeenCalledWith({
      organization_id: organizationId,
      job_id: "22222222-2222-4222-8222-222222222222",
      provider: "openrouter",
      model: "some/vision-model",
      input_tokens: 1000,
      output_tokens: 500,
      estimated_cost_usd: 0.0105,
    });
  });

  it("throws a clean error when Supabase returns an error", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient;

    await expect(
      recordAiUsage(client, {
        organizationId,
        jobId: "job",
        provider: "openrouter",
        model: "model",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      }),
    ).rejects.toThrow("Unable to record AI usage.");
  });
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/worker/ai-usage.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 3: Escribe la implementación**

```typescript
// worker/providers/ai-usage.ts
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
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/worker/ai-usage.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/providers/ai-usage.ts tests/worker/ai-usage.test.ts
git commit -m "feat: add AI usage/budget helpers for the copy processor"
```

---

### Task 6: Processor de copy (OpenRouter + guardrails)

Esta es la pieza central. Depende de los Tasks 2, 4 y 5 ya mergeados.

**Files:**
- Modify: `.env.example`
- Create: `worker/providers/copy-processor.ts`
- Test: Create `tests/worker/copy-processor.test.ts`

- [ ] **Step 1: Agrega las variables de entorno nuevas**

Modify `.env.example` — agrega al final del bloque de variables server-only (junto a `SNAPGAD_WORKER_HEALTH_TOKEN` u otras `SNAPGAD_*`):

```bash
# Copy processor (worker/providers/copy-processor.ts) — server-only, never in the browser.
OPENROUTER_API_KEY=
SNAPGAD_COPY_OPENROUTER_MODEL=
SNAPGAD_COPY_TIMEOUT_MS=45000
SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD=
SNAPGAD_COPY_MODEL_OUTPUT_PRICE_PER_1M_USD=
```

`SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD`/`..._OUTPUT_...` son necesarias para poder registrar un costo real en `ai_usage_events` (no estaban en el spec original; se agregan aquí porque sin un precio no hay forma de calcular `estimated_cost_usd`). Ninguna de las cinco tiene un valor por defecto que haga red real — el processor falla cerrado si faltan, igual que el resto del worker.

- [ ] **Step 2: Escribe el test que falla**

```typescript
// tests/worker/copy-processor.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DurableJob } from "@/lib/automation/durable-job-contract";
import type { SupabaseCopyJobPayload } from "@/lib/automation/supabase-copy-worker-store";
import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import { createCopyProcessor } from "@/worker/providers/copy-processor";

const organizationId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function baseJob(overrides: Partial<SupabaseCopyJobPayload> = {}): DurableJob<SupabaseCopyJobPayload, unknown> {
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
}): SupabaseClient {
  const tables: Record<string, unknown> = {
    organizations: chainable({ data: { ai_monthly_budget_usd: overrides.budget ?? null }, error: null }),
    ai_usage_events:
      overrides.spend === undefined
        ? { insert: vi.fn().mockResolvedValue({ error: null }) }
        : chainable({ data: [{ estimated_cost_usd: overrides.spend }], error: null }),
    organization_brand_profiles: chainable({
      data: { aias_profile: { forbiddenClaims: overrides.forbiddenClaims ?? [] } },
      error: null,
    }),
  };
  return { from: vi.fn().mockImplementation((table: string) => tables[table]) } as unknown as SupabaseClient;
}

const environment = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  OPENROUTER_API_KEY: "openrouter-key",
  SNAPGAD_COPY_OPENROUTER_MODEL: "some/vision-model",
  SNAPGAD_COPY_TIMEOUT_MS: "45000",
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

    await expect(processor(baseJob())).rejects.toMatchObject({
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
    const userMessage = body.messages.find((message: { role: string }) => message.role === "user");
    expect(JSON.stringify(userMessage.content)).toContain("https://signed.example.com/asset.png");
    expect(result.drafts).toHaveLength(2);
    expect(result.provider).toBe("openrouter");
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
```

- [ ] **Step 3: Corre el test y confirma que falla**

Run: `npx vitest run tests/worker/copy-processor.test.ts`
Expected: FAIL — módulo no existe.

- [ ] **Step 4: Escribe la implementación**

```typescript
// worker/providers/copy-processor.ts
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
```

- [ ] **Step 5: Corre el test y confirma que pasa**

Run: `npx vitest run tests/worker/copy-processor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Corre la suite completa**

Run: `npm test -- --run`
Expected: todos los archivos pasan, incluidos los de las Tasks 1-5.

- [ ] **Step 7: Verifica tipos y lint**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: ambos sin errores.

- [ ] **Step 8: Commit**

```bash
git add .env.example worker/providers/copy-processor.ts tests/worker/copy-processor.test.ts
git commit -m "feat: implement OpenRouter copy processor with budget/claims guardrails"
```

---

### Task 7: Wiring de reintentabilidad en `worker/entrypoint.ts`

**Files:**
- Modify: `worker/entrypoint.ts`
- Test: Create `tests/worker/entrypoint.test.ts`

- [ ] **Step 1: Escribe el test que falla**

```typescript
// tests/worker/entrypoint.test.ts
import { describe, expect, it } from "vitest";

import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
import { isCopyJobRetryable } from "@/worker/entrypoint";

describe("isCopyJobRetryable", () => {
  it("treats a non-guardrail error as retryable by default", () => {
    expect(isCopyJobRetryable(new Error("network blip"))).toBe(true);
  });

  it("respects the guardrail's own retryable flag", () => {
    expect(isCopyJobRetryable(new CopyGuardrailError("budget exceeded", false))).toBe(false);
    expect(isCopyJobRetryable(new CopyGuardrailError("bad shape", true))).toBe(true);
  });
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/worker/entrypoint.test.ts`
Expected: FAIL — `isCopyJobRetryable` no está exportado.

- [ ] **Step 3: Modifica `worker/entrypoint.ts`**

Agrega el import junto a los existentes:

```typescript
import { CopyGuardrailError } from "@/worker/providers/copy-guardrail-error";
```

Agrega la función exportada (junto a `parseWorkerDuration`):

```typescript
/**
 * Without this, DurableJobRunner's default treats every error as retryable
 * (see worker/durable-runner.ts), so a budget or claims guardrail would
 * reach DEAD_LETTER through retries instead of failing straight to FAILED.
 */
export function isCopyJobRetryable(error: unknown): boolean {
  return !(error instanceof CopyGuardrailError) || error.retryable;
}
```

Y en `main()`, agrega la opción al construir el runner:

```typescript
  const runner = new DurableJobRunner(store, processor, {
    pollIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    leaseDurationMs: parseWorkerDuration("SNAPGAD_WORKER_LEASE_DURATION_MS", DEFAULT_LEASE_DURATION_MS),
    heartbeatIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_HEARTBEAT_INTERVAL_MS", DEFAULT_HEARTBEAT_INTERVAL_MS),
    recoveryIntervalMs: parseWorkerDuration("SNAPGAD_WORKER_RECOVERY_INTERVAL_MS", DEFAULT_RECOVERY_INTERVAL_MS),
    isRetryable: isCopyJobRetryable,
    logger: {
      error(message, metadata) {
        console.error(JSON.stringify({ message, ...metadata }));
      },
    },
  });
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/worker/entrypoint.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Corre la suite de `durable-runner` existente (importa desde `entrypoint.ts`)**

Run: `npx vitest run tests/worker/durable-runner.test.ts`
Expected: PASS, sin cambios de comportamiento.

- [ ] **Step 6: Commit**

```bash
git add worker/entrypoint.ts tests/worker/entrypoint.test.ts
git commit -m "feat: wire CopyGuardrailError retryability into the durable runner"
```

---

### Task 8: Auto-enqueue del job de copy al crear contenido

**Files:**
- Modify: `app/api/content/route.ts`
- Modify: `tests/api/content-create.test.ts` (actualiza expectativas existentes + agrega un caso nuevo)

- [ ] **Step 1: Actualiza el test existente para reflejar el comportamiento nuevo (debe fallar primero)**

En `tests/api/content-create.test.ts`, cambia la primera aserción de `state: "UPLOADED"` a `state: "GENERATING"` (el enqueue automático transiciona el estado como parte de la misma llamada):

```typescript
  it("validates the final creative and creates an uploaded demo item, then queues its copy job", async () => {
    const repository = createDemoRepository();
    const response = await createContentCreateHandler({
      getRepository: async () => repository,
      createId: () => "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
    })(requestWithAsset());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      content: {
        state: "GENERATING",
        assetId: "8ab76cc5-f59a-48ed-8bc8-186cc7007533",
        campaign: {
          campaignName: "Agenda clínica septiembre",
          offer: "Automatización de agenda por WhatsApp",
          funnelStage: "captacion",
          destination: "whatsapp",
          destinationValue: "https://wa.me/5215555555555?text=AGENDA",
        },
      },
    });

    const record = await repository.getContentRecord("8ab76cc5-f59a-48ed-8bc8-186cc7007533");
    expect(record?.content.state).toBe("GENERATING");
  });
```

(Deja el resto del archivo, incluido el test de "rejects an invalid brief or asset before repository writes", sin tocar — ese caso nunca llega a crear contenido, así que no le afecta el enqueue.)

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/api/content-create.test.ts`
Expected: FAIL — el estado sigue siendo `UPLOADED` porque nada encola el job todavía.

- [ ] **Step 3: Modifica `app/api/content/route.ts`**

Cambia el tipo de dependencias del handler de creación (línea ~52-55):

```typescript
type ContentCreateHandlerDependencies = {
  getRepository?: () => Promise<
    Pick<ContentRepository, "createContentItemWithAsset" | "enqueueCopyJob">
  >;
  createId?: () => string;
};
```

Y en el cuerpo del handler (dentro del `try`, línea ~98-116), captura el repositorio una sola vez y encola el job justo después de crear el contenido:

```typescript
    try {
      const brief = campaignBriefSchema.parse(briefPayload);
      const validatedAsset = await validateAsset(assetFile);
      const checksum = createHash("sha256")
        .update(validatedAsset.bytes)
        .digest("hex");
      const repository = await getRepository();
      const content = await repository.createContentItemWithAsset({
        brief,
        asset: {
          id: createId(),
          filename: assetFile.name,
          mimeType: validatedAsset.mimeType,
          width: validatedAsset.width,
          height: validatedAsset.height,
          checksum,
          bytes: validatedAsset.bytes,
        },
      });
      await repository.enqueueCopyJob({
        contentItemId: content.id,
        idempotencyKey: createId(),
      });
      return Response.json({ content: { ...content, state: "GENERATING" } }, { status: 201 });
    } catch (error) {
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/api/content-create.test.ts`
Expected: PASS.

- [ ] **Step 5: Corre la suite completa**

Run: `npm test -- --run`
Expected: todos pasan. Revisa especialmente cualquier otro test que dependiera del estado `UPLOADED` justo después de `POST /api/content` (grep rápido: `grep -rn "UPLOADED" tests/api` antes de dar la task por cerrada).

- [ ] **Step 6: Verifica tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add app/api/content/route.ts tests/api/content-create.test.ts
git commit -m "feat: auto-enqueue the copy job right after content creation"
```

---

### Task 9: Poll de estado `GENERATING` en `/drafts`

**Files:**
- Modify: `app/(app)/drafts/page.tsx`
- Test: Create `tests/components/drafts-page.test.tsx`

- [ ] **Step 1: Escribe el test que falla**

```typescript
// tests/components/drafts-page.test.tsx
/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => <img {...(props as Record<string, string>)} alt={props.alt as string} />,
}));
vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig: () => true }));

const listContentItems = vi.fn();
const getContentRecord = vi.fn();
vi.mock("@/lib/content/client", () => ({
  listContentItems: (...args: unknown[]) => listContentItems(...args),
  getContentRecord: (...args: unknown[]) => getContentRecord(...args),
}));

import DraftsPage from "@/app/(app)/drafts/page";

function record(state: "GENERATING" | "DRAFT") {
  return {
    content: { id: "content-1", state, service: "bot_whatsapp", niche: "clinicas", contentType: "venta_directa" },
    drafts: [],
    targets: [],
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DraftsPage polling", () => {
  it("polls every 4s while a record is GENERATING and stops once it becomes DRAFT", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listContentItems.mockResolvedValue([{ id: "content-1" }]);
    getContentRecord
      .mockResolvedValueOnce(record("GENERATING"))
      .mockResolvedValueOnce(record("DRAFT"));

    render(<DraftsPage />);

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(4000);
    expect(getContentRecord).toHaveBeenCalledTimes(2);
  });

  it("does not poll when nothing is GENERATING", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listContentItems.mockResolvedValue([{ id: "content-1" }]);
    getContentRecord.mockResolvedValue(record("DRAFT"));

    render(<DraftsPage />);
    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4000);
    expect(getContentRecord).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/components/drafts-page.test.tsx`
Expected: FAIL — hoy la pantalla carga una sola vez y nunca vuelve a llamar `getContentRecord`.

- [ ] **Step 3: Modifica `app/(app)/drafts/page.tsx`**

Reemplaza el `useEffect` actual (líneas 33-47) por una versión que se reprograma sola mientras haya algo en `GENERATING`:

```typescript
  useEffect(() => {
    if (!isProductionMode) {
      const timer = window.setTimeout(() => {
        setDrafts(readDemoDrafts());
        setIsLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const items = await listContentItems();
        const records = await Promise.all(items.map((item) => getContentRecord(item.id)));
        if (cancelled) return;
        setProductionRecords(records);
        setIsLoading(false);
        if (records.some((record) => record.content.state === "GENERATING")) {
          pollTimer = setTimeout(load, 4000);
        }
      } catch {
        if (!cancelled) {
          setProductionRecords([]);
          setIsLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [isProductionMode]);
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/components/drafts-page.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Corre la suite completa y verifica tipos/lint**

Run: `npm test -- --run`
Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: todo pasa.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/drafts/page.tsx" tests/components/drafts-page.test.tsx
git commit -m "feat: poll /drafts while a content item is still generating"
```

---

### Task 10: Hashtags visibles al leer y elegir una alternativa (lectura)

El worker ya guarda `hashtags` en `copy_drafts` (Task 1) y `final-copy.ts` ya los valida (Task 2), pero nada en el camino de lectura de producción los expone todavía: `lib/content/repository.ts`'s `CopyResultCallback["drafts"]` (de donde se deriva `StoredCopyDraft`) no tiene el campo, el `SELECT` de `lib/supabase/repository.ts:666` no lo pide, y `components/content/draft-editor.tsx` no los muestra en ninguno de los dos editores (demo y producción). Sin este task, el spec no se cumple: *"El copy y los hashtags aparecen editables antes de enviar a revisión, igual que hoy con headline/body/cta"* — hoy los hashtags se generarían y guardarían, pero nunca llegarían al humano que revisa.

**Files:**
- Modify: `lib/content/repository.ts`
- Modify: `lib/supabase/repository.ts`
- Modify: `components/content/draft-editor.tsx`
- Test: Modify `tests/content/supabase-repository.test.ts`

- [ ] **Step 1: Actualiza el test existente para que falle**

En `tests/content/supabase-repository.test.ts`, agrega `hashtags: ["#Agenda", "#POS"]` a `draftRow` (línea ~291-301) y extiende la aserción de `getContentRecord` (línea ~329-334):

```typescript
    const draftRow = {
      id: "0b93d53f-1d18-4d83-b7c8-cb8cf9fc4e1d",
      content_item_id: createdRow.id,
      visual_analysis: { scene: "Mostrador" },
      headline: "Control al cierre",
      body: "Consulta las ventas registradas.",
      cta: "Escribe POS",
      hashtags: ["#Agenda", "#POS"],
      provider: "openrouter",
      model: "test-model",
      created_at: "2026-09-02T18:02:00.000Z",
    };
```

```typescript
    await expect(repository.getContentRecord(createdRow.id)).resolves.toMatchObject({
      content: { id: createdRow.id },
      targets: [{ id: targetRow.id, status: "APPROVED" }],
      drafts: [{ id: draftRow.id, headline: draftRow.headline, hashtags: ["#Agenda", "#POS"] }],
      auditEvents: [{ type: "TARGET_APPROVED", status: "success" }],
    });
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/content/supabase-repository.test.ts`
Expected: FAIL — `hashtags` no está en el objeto devuelto (aunque `toMatchObject` es parcial, `hashtags` con valor específico sí se compara y no coincide con `undefined`).

- [ ] **Step 3: Extiende los tipos en `lib/content/repository.ts`**

```typescript
export type CopyResultCallback = {
  contentItemId: string;
  idempotencyKey: string;
  visualAnalysis: Record<string, unknown>;
  drafts: Array<{
    headline: string;
    body: string;
    cta: string;
    hashtags?: string[];
  }>;
  warnings: string[];
  provider?: string;
  model?: string;
};
```

(`StoredCopyDraft` se deriva de `CopyResultCallback["drafts"][number]` con un `&`, así que hereda `hashtags` automáticamente — no hace falta tocar su definición.)

- [ ] **Step 4: Extiende `lib/supabase/repository.ts`**

Agrega `hashtags` al schema de fila (línea ~125-135):

```typescript
const copyDraftRowSchema = z.object({
  id: z.string().uuid(),
  content_item_id: z.string().uuid(),
  visual_analysis: z.record(z.string(), z.unknown()),
  headline: z.string().min(1),
  body: z.string().min(1),
  cta: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  created_at: z.string().datetime({ offset: true }),
});
```

Agrega la columna al `SELECT` (línea ~666):

```typescript
        .select("id, content_item_id, visual_analysis, headline, body, cta, hashtags, provider, model, created_at")
```

Y al mapeo en `toCopyDrafts` (línea ~268-279):

```typescript
  return parsedRows.data.map((row) => ({
    id: row.id,
    contentItemId: row.content_item_id,
    visualAnalysis: row.visual_analysis,
    headline: row.headline,
    body: row.body,
    cta: row.cta,
    hashtags: row.hashtags,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: row.created_at,
  }));
```

- [ ] **Step 5: Corre el test y confirma que pasa**

Run: `npx vitest run tests/content/supabase-repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Muestra los hashtags en el selector de alternativas (`draft-editor.tsx`)**

En `DemoDraftEditor`, dentro del `.map` de `record.drafts` (línea ~209-224), agrega una lista de hashtags bajo el body:

```typescript
                    <span className="mt-3 block text-sm font-semibold leading-5 text-white">{draft.headline}</span>
                    <span className="mt-2 block line-clamp-4 text-xs leading-5 text-slate-400">{draft.body}</span>
                    <span className="mt-2 block text-xs text-cyan-200/70">{draft.hashtags.join(" ")}</span>
```

En `ProductionDraftEditor`, dentro del `.map` de `record.drafts` (línea ~503), agrega lo mismo después del CTA:

```typescript
<p className="mt-3 text-xs text-cyan-100/75">CTA: {draft.cta}</p><p className="mt-1 text-xs text-cyan-200/70">{(draft.hashtags ?? []).join(" ")}</p>
```

- [ ] **Step 7: Corre la suite completa, tipos y lint**

Run: `npm test -- --run`
Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: todo pasa.

- [ ] **Step 8: Commit**

```bash
git add lib/content/repository.ts lib/supabase/repository.ts components/content/draft-editor.tsx tests/content/supabase-repository.test.ts
git commit -m "feat: surface hashtags when reading and choosing a copy draft"
```

---

### Task 11: Hashtags en el copy final enviado a revisión

Cierra el último tramo: hoy `finalCopySchema` (en la ruta), `submitFinalCopyForReview` (Supabase y demo), `final_copy_versions` y el propio editor sólo conocen headline/body/cta. Para que los hashtags sean de verdad "editables antes de enviar a revisión, igual que headline/body/cta" (spec), tienen que viajar hasta esta pieza inmutable, no quedarse sólo en el borrador.

**Files:**
- Modify: `supabase/migrations/0014_copy_hashtags_and_ai_usage.sql` (agrega una sexta pieza)
- Modify: `lib/content/repository.ts`
- Modify: `lib/supabase/repository.ts`
- Modify: `lib/demo/repository.ts`
- Modify: `app/api/content/[id]/final-copy/route.ts`
- Modify: `components/content/draft-editor.tsx`
- Test: Modify `tests/content/copy-hashtags-migration.test.ts`, `tests/api/final-copy.test.ts`

- [ ] **Step 1: Agrega un caso que falla al test de forma SQL**

En `tests/content/copy-hashtags-migration.test.ts`, agrega:

```typescript
  it("adds hashtags to the immutable final copy record", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/alter table public\.final_copy_versions/i);
    expect(sql).toMatch(/add column hashtags jsonb not null default '\[\]'::jsonb/i);
    expect(sql).toMatch(/p_hashtags jsonb/i);
  });

  it("drops the 8-parameter submit_final_copy_for_review instead of creating a coexisting overload", async () => {
    const sql = await readMigration();
    // Adding a parameter via create-or-replace creates a second overload
    // instead of replacing the function, and Postgres grants PUBLIC execute
    // on newly created functions by default — an easy way to accidentally
    // expose a service_role-only RPC to any authenticated caller. Guard
    // against reintroducing that pattern.
    expect(sql).toMatch(
      /drop function if exists public\.submit_final_copy_for_review\(\s*uuid, uuid, uuid, uuid, text, text, text, text\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.submit_final_copy_for_review/i);
    expect(sql).toMatch(/create function public\.submit_final_copy_for_review/i);
  });

  it("restricts the new submit_final_copy_for_review overload to service_role", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /revoke all on function public\.submit_final_copy_for_review\(\s*uuid, uuid, uuid, uuid, text, text, text, text, jsonb\s*\)[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.submit_final_copy_for_review\(\s*uuid, uuid, uuid, uuid, text, text, text, text, jsonb\s*\)[\s\S]*to service_role/i,
    );
  });
```

- [ ] **Step 2: Corre el test y confirma que falla**

Run: `npx vitest run tests/content/copy-hashtags-migration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Agrega la sexta pieza a la migración `0014`**

Añade al final de `supabase/migrations/0014_copy_hashtags_and_ai_usage.sql`:

```sql
-- 6. Hashtags on the immutable final copy record, so what a human approves
--    for review is what actually gets published — not just what the AI
--    proposed in copy_drafts.
--
--    Postgres identifies a function by (name, parameter TYPES), so adding
--    `p_hashtags` — even with a default — via `create or replace` would NOT
--    replace the existing 8-parameter function; it would create a second,
--    coexisting 9-parameter overload. Postgres grants EXECUTE on a newly
--    created function to PUBLIC by default, and nothing in this repo alters
--    that default, so the new overload would be callable directly by any
--    `authenticated` role via PostgREST/supabase-js — bypassing the Next.js
--    route entirely and this RPC's `service_role`-only intent (see the
--    revoke/grant pair for the 8-parameter version in
--    0009_tenantize_content_and_jobs.sql:324,328). `assert_organization_actor`
--    trusts `p_owner_id`/`p_organization_id` as already-verified — it does not
--    check them against `auth.uid()` — so an exposed overload would let any
--    authenticated member of any organization submit final copy while
--    attributing it to an arbitrary `p_owner_id` from that org's membership.
--    Dropping the old signature and creating a single 9-parameter function
--    under the same name avoids the overload trap entirely. The sole caller
--    (lib/supabase/repository.ts, Task 11 Step 6) is updated in the same
--    task to pass all nine parameters by name, so nothing is left calling
--    the old 8-parameter shape.
alter table public.final_copy_versions
  add column hashtags jsonb not null default '[]'::jsonb
  check (
    jsonb_typeof(hashtags) = 'array'
    and jsonb_array_length(hashtags) <= 8
  );

drop function if exists public.submit_final_copy_for_review(
  uuid, uuid, uuid, uuid, text, text, text, text
);

create function public.submit_final_copy_for_review(
  p_organization_id uuid, p_owner_id uuid, p_content_item_id uuid,
  p_selected_copy_draft_id uuid, p_headline text, p_body text, p_cta text,
  p_checksum text, p_hashtags jsonb
)
returns public.final_copy_versions
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  item public.content_items;
  created_copy public.final_copy_versions;
  next_version integer;
begin
  if jsonb_typeof(p_hashtags) is distinct from 'array' or jsonb_array_length(p_hashtags) > 8 then
    raise exception using errcode = '22023', message = 'FINAL_COPY_INVALID_HASHTAGS';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_hashtags) as tag
    where nullif(btrim(tag), '') is null
  ) then
    raise exception using errcode = '22023', message = 'FINAL_COPY_INVALID_HASHTAGS';
  end if;
  perform public.assert_organization_actor(
    p_organization_id, p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );
  select * into item from public.content_items as content
  where content.id = p_content_item_id and content.organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0001', message = 'FINAL_COPY_CONTENT_NOT_FOUND'; end if;
  if item.state <> 'DRAFT' then raise exception using errcode = 'P0001', message = 'FINAL_COPY_SUBMISSION_INVALID_STATE'; end if;
  if item.campaign_code is null then raise exception using errcode = 'P0001', message = 'FINAL_COPY_CAMPAIGN_REQUIRED'; end if;
  if p_selected_copy_draft_id is not null and not exists (
    select 1 from public.copy_drafts as draft
    where draft.id = p_selected_copy_draft_id
      and draft.content_item_id = p_content_item_id
      and draft.organization_id = p_organization_id
  ) then raise exception using errcode = 'P0001', message = 'FINAL_COPY_DRAFT_MISMATCH'; end if;
  select coalesce(max(version), 0) + 1 into next_version
  from public.final_copy_versions as copy where copy.content_item_id = p_content_item_id;
  insert into public.final_copy_versions (
    organization_id, owner_id, content_item_id, selected_copy_draft_id, headline,
    body, cta, hashtags, checksum, version
  ) values (
    p_organization_id, item.owner_id, p_content_item_id, p_selected_copy_draft_id,
    p_headline, p_body, p_cta, p_hashtags, p_checksum, next_version
  ) returning * into created_copy;
  update public.content_items set selected_final_copy_id = created_copy.id, state = 'REVIEW'
  where id = p_content_item_id and organization_id = p_organization_id;
  insert into public.audit_events (organization_id, owner_id, actor_id, content_item_id, event_type, metadata)
  values (p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    'FINAL_COPY_SUBMITTED', jsonb_build_object('finalCopyId', created_copy.id, 'version', next_version));
  return created_copy;
end;
$$;

revoke all on function public.submit_final_copy_for_review(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.submit_final_copy_for_review(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;
```

- [ ] **Step 4: Corre el test y confirma que pasa**

Run: `npx vitest run tests/content/copy-hashtags-migration.test.ts`
Expected: PASS (8 tests en total en este archivo).

- [ ] **Step 5: Extiende los tipos en `lib/content/repository.ts`**

```typescript
export type FinalCopy = {
  id: string;
  contentItemId: string;
  selectedCopyDraftId?: string;
  headline: string;
  body: string;
  cta: string;
  hashtags: string[];
  checksum: string;
  version: number;
  createdAt: string;
};

export type FinalCopySubmission = {
  selectedCopyDraftId?: string;
  headline: string;
  body: string;
  cta: string;
  hashtags?: string[];
};
```

- [ ] **Step 6: Actualiza `lib/supabase/repository.ts`**

En `submitFinalCopyForReview` (línea ~724-753), incluye `hashtags` en el checksum (para que la inmutabilidad cubra también los hashtags) y pásalos a la RPC:

```typescript
  async submitFinalCopyForReview(
    contentItemId: string,
    input: FinalCopySubmission,
  ): Promise<FinalCopy> {
    const content = await this.getContentItem(contentItemId);
    if (!content || !content.campaign) throw new CopyResultConflictError();
    const validation = validateFinalCopy(input, content);
    if (!validation.ok) throw new CopyResultConflictError();

    const hashtags = (input.hashtags ?? []).map((tag) => tag.trim());
    const checksum = createHash("sha256")
      .update(
        JSON.stringify({
          contentItemId,
          selectedCopyDraftId: input.selectedCopyDraftId ?? null,
          headline: input.headline.trim(),
          body: input.body.trim(),
          cta: input.cta.trim(),
          hashtags,
        }),
      )
      .digest("hex");
    const { data, error } = await this.client.rpc("submit_final_copy_for_review", {
      p_owner_id: this.organization.userId,
      p_organization_id: this.organization.organizationId,
      p_content_item_id: contentItemId,
      p_selected_copy_draft_id: input.selectedCopyDraftId ?? null,
      p_headline: input.headline.trim(),
      p_body: input.body.trim(),
      p_cta: input.cta.trim(),
      p_checksum: checksum,
      p_hashtags: hashtags,
    });
```

Busca el zod schema que valida la fila de `final_copy_versions` (cerca de la línea 78, junto a `checksum: z.string().min(1)` / `version: z.number().int().positive()`) y agrega `hashtags: z.array(z.string()).default([])`. `submitFinalCopyForReview` no arma el objeto `FinalCopy` inline — termina con `return toFinalCopy(data);` — así que el mapeo real va dentro de la función compartida `toFinalCopy()` (la misma que usa `getContentRecord`): agrégale `hashtags: data.hashtags` junto a `checksum`/`version`.

**Ojo, esto es fácil de dejar a medias:** `getContentRecord` lee `final_copy_versions` en un `SELECT` **separado**, no reutiliza `submitFinalCopyForReview`. Busca ese otro `.select(...)` sobre `final_copy_versions` (contiene literalmente `"id, content_item_id, selected_copy_draft_id, headline, body, cta, checksum, version, created_at"`) y agrégale `hashtags`:

```typescript
        .select("id, content_item_id, selected_copy_draft_id, headline, body, cta, hashtags, checksum, version, created_at")
```

Si usa el mismo zod schema que acabas de extender (probable, ya que ambos leen la misma tabla), no hace falta nada más aquí; si usa un schema separado, agrégale `hashtags: z.array(z.string()).default([])` también. Sin este cambio, `hashtags: z.array(z.string()).default([])` no fallaría (usa el default silenciosamente) y el campo "Hashtags finales" del editor (Step 12) se vería permanentemente vacío después de la primera recarga, aunque el dato sí esté guardado — un bug silencioso, no un error visible.

- [ ] **Step 7: Actualiza `lib/demo/repository.ts`**

Busca el método `submitFinalCopyForReview` del repositorio demo (in-memory) y agrega `hashtags: input.hashtags ?? []` al objeto `FinalCopy` que construye, con el mismo patrón que ya usa para `headline`/`body`/`cta`.

- [ ] **Step 8: Actualiza la ruta `app/api/content/[id]/final-copy/route.ts`**

```typescript
const finalCopySchema = z.object({
  selectedCopyDraftId: z.string().uuid().optional(),
  headline: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(5000),
  cta: z.string().trim().min(1).max(240),
  hashtags: z.array(z.string().trim().min(1)).max(8).optional(),
});
```

Y en `isSameFinalCopy` (línea ~31-39), agrega la comparación de hashtags:

```typescript
function isSameFinalCopy(
  stored: FinalCopy,
  submitted: z.infer<typeof finalCopySchema>,
): boolean {
  const submittedHashtags = (submitted.hashtags ?? []).map((tag) => tag.trim());
  return stored.selectedCopyDraftId === submitted.selectedCopyDraftId &&
    stored.headline === submitted.headline.trim() &&
    stored.body === submitted.body.trim() &&
    stored.cta === submitted.cta.trim() &&
    stored.hashtags.length === submittedHashtags.length &&
    stored.hashtags.every((tag, index) => tag === submittedHashtags[index]);
}
```

- [ ] **Step 9: Agrega un caso al test de la ruta**

En `tests/api/final-copy.test.ts`, agrega un caso que envíe `hashtags` en el payload y confirme que el repositorio inyectado los recibe (sigue el patrón de test ya existente en ese archivo, inspeccionando el mock de `submitFinalCopyForReview`).

- [ ] **Step 10: Corre el test y confirma que pasa**

Run: `npx vitest run tests/api/final-copy.test.ts`
Expected: PASS.

- [ ] **Step 11: Agrega el campo editable en `draft-editor.tsx`**

En ambos editores (demo y producción), agrega un campo de texto para hashtags junto al de CTA final, guardado como array separado por espacios/comas. Ejemplo para la sección demo (junto al bloque de `final-cta`, línea ~240-242):

```typescript
              <label className="block text-sm font-semibold text-slate-100" htmlFor="final-hashtags">Hashtags finales
                <input
                  id="final-hashtags"
                  className={fieldClasses}
                  value={finalCopy.hashtags.join(" ")}
                  onChange={(event) => setFinalCopy((current) => ({
                    ...current,
                    hashtags: event.target.value.split(/\s+/).map((tag) => tag.trim()).filter(Boolean),
                  }))}
                  placeholder="#AutomatizacionWhatsApp #NegociosMexico"
                />
              </label>
```

Repite el mismo patrón para `ProductionDraftEditor` (junto a `production-final-cta`, línea ~504). Además, en estos puntos concretos:

- `emptyEditableFinalCopy()` (línea ~281-287): agrega `hashtags: []`.
- `toEditableFinalCopy()` (línea ~289-310): agrega `hashtags: record.finalCopy.hashtags` en la rama con `finalCopy`, y `hashtags: latest.hashtags` en la rama que usa el último draft.
- `DemoDraftEditor`: el estado inicial de `finalCopy` (línea ~68-72) agrega `hashtags: []`; su función `chooseDraft` (línea ~88-92) agrega `hashtags: draft.hashtags` al `setFinalCopy(...)`.
- `ProductionDraftEditor`: su función `chooseProductionDraft` (línea ~438-447) agrega `hashtags: draft.hashtags` al `setFinalCopy(...)`.

`npx tsc --noEmit` (Step 12) marcará si olvidas el de `DemoDraftEditor` (`DemoFinalCopy.hashtags` es obligatorio desde el Task 3). `FinalCopySubmission.hashtags` es opcional (Step 5), así que un olvido del lado de `ProductionDraftEditor` **no** lo detecta tsc — sólo se notaría al usar la app (el campo de hashtags se vería vacío al elegir una alternativa). Revísalo a mano antes del Step 13.

- [ ] **Step 12: Corre la suite completa, tipos y lint**

Run: `npm test -- --run`
Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: todo pasa.

- [ ] **Step 13: Commit**

```bash
git add supabase/migrations/0014_copy_hashtags_and_ai_usage.sql lib/content/repository.ts lib/supabase/repository.ts lib/demo/repository.ts "app/api/content/[id]/final-copy/route.ts" components/content/draft-editor.tsx tests/content/copy-hashtags-migration.test.ts tests/api/final-copy.test.ts
git commit -m "feat: carry hashtags through to the immutable final copy sent to review"
```

---

## Verificación final

- [ ] `npm test -- --run` — todos los archivos pasan (línea base + 9 archivos de test nuevos/editados).
- [ ] `npx tsc --noEmit` — sin errores.
- [ ] `npm run lint` — sin errores.
- [ ] `npm run build` — compila y genera las rutas, incluida `/api/content`.
- [ ] Ninguna llamada real a OpenRouter, Meta ni n8n se hizo durante la implementación (todo mockeado en tests; las variables reales sólo se configuran cuando Axel decida activar staging).
- [ ] `git log` de esta unidad no toca `supabase/migrations/0001` a `0013`, sólo agrega `0014`.
