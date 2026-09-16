# API v1 con claves por organización — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exponer el pipeline de marketing de Orbit OS (campañas, generación, composición de logo, publicación) vía una API v1 versionada, autenticada por clave por organización — la base sobre la que se construirá la capa MCP como sub-proyecto siguiente.

**Architecture:** Una tabla nueva `organization_api_keys` (claves hasheadas, gestionadas vía RPCs `security definer`) autentica requests a `/api/v1/*`; la clave resuelve la identidad de su creador (siempre owner) y construye el mismo `OrganizationContext`/repositorio que ya usa el resto del sistema — cero pipeline paralelo. La composición de logo gana un puerto server-side (`sharp`) del mismo cálculo puro ya usado en el compositor manual.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + RLS + RPCs `security definer`), Zod, Vitest, `sharp` (nueva dependencia).

**Spec:** `docs/superpowers/specs/2026-09-14-api-v1-tenant-keys-design.md` — léelo completo antes de implementar cualquier tarea; este plan resume decisiones, el spec tiene el razonamiento completo de cada una (3 rondas de revisión con Codex CLI).

---

### Task 1: Migración 0019 — tabla `organization_api_keys` + RPCs de gestión

**Files:**
- Create: `supabase/migrations/0019_organization_api_keys.sql`
- Test: `tests/organizations/api-keys-migration.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment node */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0019_organization_api_keys.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("organization_api_keys migration", () => {
  it("creates the table with RLS enabled and no general-purpose write policy", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/create table if not exists public\.organization_api_keys/i);
    expect(sql).toMatch(/key_hash text not null unique/i);
    expect(sql).toMatch(/alter table public\.organization_api_keys enable row level security/i);
    // Solo debe existir una policy (SELECT) — la escritura pasa por las RPCs.
    const policyMatches = sql.match(/create policy .* on public\.organization_api_keys/gi) ?? [];
    expect(policyMatches).toHaveLength(1);
    expect(policyMatches[0]).toMatch(/for select/i);
  });

  it("protects key_hash from the authenticated role at the column-privilege level, not just RLS", async () => {
    const sql = await readMigration();
    // Corrección ronda 2 del spec: un REVOKE de columna sola no alcanza si
    // el rol ya tiene SELECT de tabla completa — debe revocarse la tabla y
    // conceder solo las columnas seguras.
    expect(sql).toMatch(/revoke select on public\.organization_api_keys from authenticated/i);
    expect(sql).toMatch(
      /grant select \(id, organization_id, label, key_prefix, created_by, created_at, last_used_at, revoked_at\)\s*\n?\s*on public\.organization_api_keys to authenticated/i,
    );
    expect(sql).not.toMatch(/revoke select \(key_hash\)/i);
  });

  it("guards create_organization_api_key against the NULL-bypass bug (non-member must be rejected, not silently allowed)", async () => {
    const sql = await readMigration();
    // has_organization_role devuelve NULL, no false, para quien no tiene
    // ninguna membresía — `if not <NULL>` no ejecuta el bloque en plpgsql.
    // Debe envolverse en coalesce(..., false).
    const createFn = sql.split("create function public.create_organization_api_key")[1] ?? "";
    expect(createFn).toMatch(/if not coalesce\(public\.has_organization_role\([^)]*\), false\) then/i);
    expect(createFn).toMatch(/raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER'/i);
  });

  it("guards revoke_organization_api_key against the same NULL-bypass bug", async () => {
    const sql = await readMigration();
    const revokeFn = sql.split("create function public.revoke_organization_api_key")[1] ?? "";
    expect(revokeFn).toMatch(/or not coalesce\(public\.has_organization_role\([^)]*\), false\) then/i);
  });

  it("never lets the caller choose organization_id or created_by directly", async () => {
    const sql = await readMigration();
    // El secreto y el hash se generan dentro de la función; created_by viene
    // de auth.uid(), nunca de un parámetro.
    expect(sql).toMatch(/values \(p_organization_id, p_label, v_hash, v_prefix, auth\.uid\(\)\)/i);
  });

  it("restricts both RPCs to authenticated only, never public/anon", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/revoke all on function public\.create_organization_api_key\(uuid, text\) from public, anon/i);
    expect(sql).toMatch(/revoke all on function public\.revoke_organization_api_key\(uuid\) from public, anon/i);
    expect(sql).toMatch(/grant execute on function public\.create_organization_api_key\(uuid, text\) to authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.revoke_organization_api_key\(uuid\) to authenticated/i);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/organizations/api-keys-migration.test.ts`
Expected: FAIL — el archivo de migración no existe todavía.

- [ ] **Step 3: Implementar la migración**

```sql
-- 0019_organization_api_keys.sql
-- Tabla + RPCs para claves de API por organización (API v1). Ver
-- docs/superpowers/specs/2026-09-14-api-v1-tenant-keys-design.md.

create table if not exists public.organization_api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  key_hash text not null unique,
  key_prefix text not null check (length(key_prefix) = 12),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table public.organization_api_keys enable row level security;

create policy "Owners read their api keys" on public.organization_api_keys
  for select to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));

-- Sin policy de insert/update/delete: solo las RPCs de abajo escriben esta
-- tabla, corriendo con privilegios de servicio (security definer), no con
-- los del caller. Evita que una policy amplia permita a un owner reescribir
-- created_by de una clave para atribuirla a otro usuario.

create function public.create_organization_api_key(p_organization_id uuid, p_label text)
returns table (id uuid, key_prefix text, secret text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text := 'sk_live_' || encode(gen_random_bytes(32), 'hex');
  v_hash text := encode(digest(v_secret, 'sha256'), 'hex');
  v_prefix text := left(v_secret, 12);
  v_id uuid;
begin
  -- has_organization_role devuelve NULL (no false) cuando el caller no
  -- tiene ninguna fila de membresía, y `if not null` es `if null` en
  -- plpgsql — no ejecuta el bloque. coalesce fuerza NULL a "no autorizado".
  if not coalesce(public.has_organization_role(p_organization_id, array['owner']::public.organization_role[]), false) then
    raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER';
  end if;
  insert into public.organization_api_keys (organization_id, label, key_hash, key_prefix, created_by)
  values (p_organization_id, p_label, v_hash, v_prefix, auth.uid())
  returning organization_api_keys.id into v_id;
  return query select v_id, v_prefix, v_secret;
end;
$$;

create function public.revoke_organization_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  select organization_id into v_organization_id
  from public.organization_api_keys where id = p_key_id;
  if v_organization_id is null
     or not coalesce(public.has_organization_role(v_organization_id, array['owner']::public.organization_role[]), false) then
    raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER';
  end if;
  update public.organization_api_keys set revoked_at = now()
  where id = p_key_id and revoked_at is null;
end;
$$;

revoke all on function public.create_organization_api_key(uuid, text) from public, anon;
revoke all on function public.revoke_organization_api_key(uuid) from public, anon;
grant execute on function public.create_organization_api_key(uuid, text) to authenticated;
grant execute on function public.revoke_organization_api_key(uuid) to authenticated;

revoke select on public.organization_api_keys from authenticated;
grant select (id, organization_id, label, key_prefix, created_by, created_at, last_used_at, revoked_at)
  on public.organization_api_keys to authenticated;
```

(`pgcrypto` ya está habilitado en `0001_content_os.sql:2` — `gen_random_bytes`/`digest` están disponibles sin extensión adicional, verificado en la ronda 3 de revisión del spec.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/organizations/api-keys-migration.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint tests/organizations/api-keys-migration.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0019_organization_api_keys.sql tests/organizations/api-keys-migration.test.ts
git commit -m "feat: add organization_api_keys table and key management RPCs"
```

---

### Task 2: Migración 0020 — RPCs de auditoría con `p_actor_metadata`

**Files:**
- Create: `supabase/migrations/0020_actor_metadata_for_api_keys.sql`
- Test: `tests/organizations/actor-metadata-migration.test.ts`

**Antes de escribir código, lee `supabase/migrations/0009_tenantize_content_and_jobs.sql:164-214`** (la función completa `create_content_item_with_asset_in_organization`, **24 parámetros** — corrección ronda 2 de revisión del plan, la ronda 1 decía "23" por error de conteo) **y `supabase/migrations/0010_automation_jobs.sql:30-120`** (`enqueue_copy_automation_job`, 4 parámetros) — este task recrea ambas con un parámetro nuevo (25 y 5 respectivamente), copiando el resto de cada cuerpo exactamente como está hoy, sin cambiar ninguna otra línea de su lógica.

**Por qué `drop function` y no `create or replace`:** en Postgres, `create or replace function` con un parámetro nuevo agregado NO reemplaza la función — crea un *overload* con una firma distinta, y la vieja queda viva junto a la nueva, con riesgo real de ambigüedad para callers que no pasan el parámetro nuevo. Este mismo proyecto ya resolvió este problema exacto en `supabase/migrations/0014_copy_hashtags_and_ai_usage.sql:348-356` (`drop function if exists public.submit_final_copy_for_review(<firma vieja exacta>)` antes de recrearla) — sigue el mismo patrón aquí, no `create or replace`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment node */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readMigration(): Promise<string> {
  const path = fileURLToPath(
    new URL("../../supabase/migrations/0020_actor_metadata_for_api_keys.sql", import.meta.url),
  );
  return readFile(path, "utf8");
}

describe("actor metadata migration", () => {
  it("drops the old 24-parameter create_content_item_with_asset_in_organization instead of coexisting as an overload", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /drop function if exists public\.create_content_item_with_asset_in_organization\(\s*uuid, uuid, uuid, text,\s*text, text, integer, integer,\s*text, text, text, text,\s*text, text, text, text,\s*text, jsonb, text,\s*text, text, text,\s*text, text\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.create_content_item_with_asset_in_organization/i);
    expect(sql).toMatch(/create function public\.create_content_item_with_asset_in_organization/i);
  });

  it("gives create_content_item_with_asset_in_organization a p_actor_metadata parameter merged into its audit event", async () => {
    const sql = await readMigration();
    const fn = sql.split("create function public.create_content_item_with_asset_in_organization")[1] ?? "";
    expect(fn).toMatch(/p_actor_metadata jsonb default '\{\}'::jsonb/i);
    expect(fn).toMatch(
      /jsonb_build_object\('assetId', p_asset_id, 'campaignCode', p_campaign_code\) \|\| p_actor_metadata/i,
    );
  });

  it("drops the old 4-parameter enqueue_copy_automation_job instead of coexisting as an overload", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /drop function if exists public\.enqueue_copy_automation_job\(\s*uuid, uuid, uuid, uuid\s*\)/i,
    );
    expect(sql).not.toMatch(/create or replace function public\.enqueue_copy_automation_job/i);
  });

  it("gives enqueue_copy_automation_job a p_actor_metadata parameter merged into its audit event", async () => {
    const sql = await readMigration();
    const fn = sql.split("create function public.enqueue_copy_automation_job")[1] ?? "";
    expect(fn).toMatch(/p_actor_metadata jsonb default '\{\}'::jsonb/i);
    expect(fn).toMatch(
      /jsonb_build_object\('jobId', created_job\.id, 'idempotencyKey', p_idempotency_key\) \|\| p_actor_metadata/i,
    );
  });

  it("re-grants execute on both recreated functions to service_role only, never to authenticated/public/anon", async () => {
    // Corrección ronda 1 de revisión del plan (hallazgo real de seguridad):
    // ambas funciones ya están revocadas de public/anon/authenticated y
    // concedidas solo a service_role hoy (0009:321-329, 0010:151-156) —
    // createContentRepository las llama con el cliente de service role
    // después de validar la sesión en TypeScript (repository-factory.ts:193),
    // nunca directo desde una sesión de navegador. Conceder EXECUTE a
    // authenticated aquí abriría estas RPCs privilegiadas a cualquier
    // usuario autenticado, saltándose esa validación.
    const sql = await readMigration();
    expect(sql).toMatch(
      /revoke all on function public\.create_content_item_with_asset_in_organization\([^)]*\) from public, anon, authenticated/is,
    );
    expect(sql).toMatch(
      /grant execute on function public\.create_content_item_with_asset_in_organization\([^)]*\) to service_role/is,
    );
    expect(sql).toMatch(
      /revoke all on function public\.enqueue_copy_automation_job\([^)]*\) from public, anon, authenticated/is,
    );
    expect(sql).toMatch(
      /grant execute on function public\.enqueue_copy_automation_job\([^)]*\) to service_role/is,
    );
    expect(sql).not.toMatch(/grant execute on function public\.create_content_item_with_asset_in_organization\([^)]*\) to authenticated/is);
    expect(sql).not.toMatch(/grant execute on function public\.enqueue_copy_automation_job\([^)]*\) to authenticated/is);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/organizations/actor-metadata-migration.test.ts`
Expected: FAIL — el archivo no existe todavía.

- [ ] **Step 3: Implementar la migración**

Copia el cuerpo completo de cada función tal cual está en `0009`/`0010` (enlazadas arriba), agregando solo `p_actor_metadata jsonb default '{}'::jsonb` al final de la lista de parámetros y fusionándolo (`||`) en el `jsonb_build_object(...)` del `insert into audit_events` de cada una. El resto de cada cuerpo — validaciones, inserts en `assets`/`content_items`/`publication_targets`/`automation_jobs`/`automation_runs` — se copia exactamente igual, sin modificar ninguna otra línea.

```sql
-- 0020_actor_metadata_for_api_keys.sql
-- Agrega p_actor_metadata a las RPCs que insertan audit_events y que la API
-- v1 puede disparar, para atribuir la acción a una clave de API cuando
-- corresponda. drop+create (no create or replace) para evitar un overload
-- ambiguo — mismo patrón que 0014_copy_hashtags_and_ai_usage.sql:348-356.

drop function if exists public.create_content_item_with_asset_in_organization(
  uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, text,
  text, text, text, text, text, jsonb, text, text, text, text, text, text
);

create function public.create_content_item_with_asset_in_organization(
  p_organization_id uuid, p_owner_id uuid, p_asset_id uuid, p_storage_path text,
  p_filename text, p_mime_type text, p_width integer, p_height integer,
  p_checksum text, p_business_line text, p_service text, p_niche text,
  p_content_type text, p_objective text, p_format text, p_cta text,
  p_human_description text, p_allowed_facts jsonb, p_campaign_name text,
  p_offer text, p_funnel_stage text, p_destination text,
  p_destination_value text, p_campaign_code text,
  p_actor_metadata jsonb default '{}'::jsonb
)
returns public.content_items
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_item public.content_items;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );
  insert into public.assets (
    id, organization_id, owner_id, bucket_id, storage_path, filename, mime_type,
    width, height, checksum
  ) values (
    p_asset_id, p_organization_id, p_owner_id, 'content-assets', p_storage_path,
    p_filename, p_mime_type, p_width, p_height, p_checksum
  );
  insert into public.content_items (
    organization_id, owner_id, asset_id, business_line, service, niche,
    content_type, objective, format, cta, human_description, allowed_facts,
    state, campaign_name, offer, funnel_stage, destination, destination_value,
    campaign_code
  ) values (
    p_organization_id, p_owner_id, p_asset_id, p_business_line, p_service,
    p_niche, p_content_type, p_objective, p_format, p_cta,
    p_human_description, p_allowed_facts, 'UPLOADED', p_campaign_name, p_offer,
    p_funnel_stage, p_destination, p_destination_value, p_campaign_code
  ) returning * into created_item;
  insert into public.publication_targets (organization_id, owner_id, content_item_id, platform, status)
  values
    (p_organization_id, p_owner_id, created_item.id, 'FACEBOOK', 'PENDING_REVIEW'),
    (p_organization_id, p_owner_id, created_item.id, 'INSTAGRAM', 'PENDING_REVIEW');
  insert into public.audit_events (organization_id, owner_id, actor_id, content_item_id, event_type, metadata)
  values (
    p_organization_id, p_owner_id, p_owner_id, created_item.id, 'CONTENT_CREATED',
    jsonb_build_object('assetId', p_asset_id, 'campaignCode', p_campaign_code) || p_actor_metadata
  );
  return created_item;
end;
$$;

-- Corrección ronda 1 de revisión del plan (hallazgo real de seguridad): la
-- versión anterior de este plan concedía EXECUTE a `authenticated` — pero
-- esta función hoy está revocada de public/anon/authenticated y concedida
-- solo a service_role (0009:321-329); createContentRepository ya valida la
-- sesión/membresía en TypeScript antes de invocarla con el cliente de
-- service role (repository-factory.ts:193). Conceder EXECUTE a
-- authenticated aquí saltearía esa validación para cualquier usuario con
-- sesión. Se replica el mismo revoke/grant que la función ya tenía.
revoke all on function public.create_content_item_with_asset_in_organization(
  uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, text,
  text, text, text, text, text, jsonb, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_content_item_with_asset_in_organization(
  uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, text,
  text, text, text, text, text, jsonb, text, text, text, text, text, text, jsonb
) to service_role;

drop function if exists public.enqueue_copy_automation_job(uuid, uuid, uuid, uuid);

create function public.enqueue_copy_automation_job(
  p_organization_id uuid,
  p_actor_id uuid,
  p_content_item_id uuid,
  p_idempotency_key uuid,
  p_actor_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  item public.content_items%rowtype;
  existing_job public.automation_jobs%rowtype;
  created_job public.automation_jobs%rowtype;
begin
  perform public.assert_organization_actor(
    p_organization_id,
    p_actor_id,
    array['owner', 'editor']::public.organization_role[]
  );
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || p_idempotency_key::text));
  select * into existing_job
  from public.automation_jobs
  where organization_id = p_organization_id
    and kind = 'COPY'
    and idempotency_key = p_idempotency_key;
  if found then
    if existing_job.content_item_id <> p_content_item_id then
      raise exception using errcode = 'P0001', message = 'COPY_JOB_IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object(
      'created', false,
      'jobId', existing_job.id,
      'idempotencyKey', existing_job.idempotency_key
    );
  end if;

  select * into item
  from public.content_items
  where id = p_content_item_id
    and organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_CONTENT_NOT_FOUND';
  end if;
  if item.asset_id is null or not exists (
    select 1 from public.assets as asset
    where asset.id = item.asset_id
      and asset.organization_id = p_organization_id
  ) then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_ASSET_REQUIRED';
  end if;
  if item.state not in ('UPLOADED', 'DRAFT', 'ERROR') then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_INVALID_STATE';
  end if;

  update public.content_items
  set state = 'GENERATING'::public.content_state
  where id = item.id and organization_id = p_organization_id;
  insert into public.automation_jobs (
    organization_id, content_item_id, kind, status, idempotency_key
  ) values (
    p_organization_id, item.id, 'COPY', 'QUEUED', p_idempotency_key
  ) returning * into created_job;
  insert into public.automation_runs (
    organization_id, owner_id, content_item_id, kind, idempotency_key,
    status, response_payload
  ) values (
    p_organization_id, item.owner_id, item.id, 'COPY_REQUEST',
    p_idempotency_key, 'RECEIVED',
    jsonb_build_object('jobId', created_job.id, 'source', 'automation_jobs')
  ) on conflict (kind, idempotency_key) do nothing;
  insert into public.audit_events (
    organization_id, owner_id, actor_id, content_item_id, event_type, metadata
  ) values (
    p_organization_id, item.owner_id, p_actor_id, item.id, 'COPY_JOB_QUEUED',
    jsonb_build_object('jobId', created_job.id, 'idempotencyKey', p_idempotency_key) || p_actor_metadata
  );
  return jsonb_build_object(
    'created', true,
    'jobId', created_job.id,
    'idempotencyKey', created_job.idempotency_key
  );
end;
$$;

-- Mismo motivo que create_content_item_with_asset_in_organization arriba:
-- service_role únicamente, replicando el revoke/grant que ya tenía
-- (0010:151-156).
revoke all on function public.enqueue_copy_automation_job(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_copy_automation_job(uuid, uuid, uuid, uuid, jsonb) to service_role;
```

(Verifica contra el archivo real `0009_tenantize_content_and_jobs.sql` que no exista ninguna otra función que dependa de la firma vieja de 24 parámetros antes de aplicar el `drop function` — `grep -rn "create_content_item_with_asset_in_organization" supabase/ lib/` para confirmarlo.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/organizations/actor-metadata-migration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint tests/organizations/actor-metadata-migration.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0020_actor_metadata_for_api_keys.sql tests/organizations/actor-metadata-migration.test.ts
git commit -m "feat: add p_actor_metadata to audit-writing RPCs for API key attribution"
```

---

### Task 3: `OrganizationContext` + repositorio — hilo de `apiKey`

**Files:**
- Modify: `lib/organizations/context.ts`
- Modify: `lib/supabase/repository.ts:550-609` (`createContentItemWithAsset`), `lib/supabase/repository.ts:966-990` (`enqueueCopyJob`)
- Test: `tests/organizations/context.test.ts` (ya existe — agrega casos, no lo reescribas completo)
- Test: `tests/content/supabase-repository.test.ts` (ya existe — agrega los dos pares de casos de `p_actor_metadata` y actualiza la aserción existente de `enqueueCopyJob` en la línea ~367)

- [ ] **Step 1: Escribir los tests que fallan**

Agrega a `tests/organizations/context.test.ts` (revisa el archivo primero para seguir su estilo exacto de mocks):

```typescript
it("carries an optional apiKey field, absent by default, for session-authenticated contexts", async () => {
  const context = await requireOrganizationContext("org-1", {
    getSession: async () => ({ userId: "user-1" }),
    getMembership: async () => ({ organizationId: "org-1", userId: "user-1", role: "owner" }),
  });
  expect(context.apiKey).toBeUndefined();
});
```

**Corrección ronda 2 de revisión del plan (hallazgo real — estos dos tests seguían siendo placeholders tras la ronda 1, que no los tocó):** agrega a `tests/content/supabase-repository.test.ts` (léelo primero — ya existe y ya cubre `createContentItemWithAsset`/`enqueueCopyJob` con un mock de `client.rpc`; sigue su patrón exacto, no inventes uno nuevo):

```typescript
it("passes p_actor_metadata with the api key context when the organization context came from an API key", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { id: "content-1" }, error: null });
  const repository = createSupabaseRepository(
    { rpc, storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }) }) } } as never,
    { organizationId: "org-1", userId: "user-1", role: "owner", apiKey: { id: "key-1", label: "n8n integration" } },
  );

  await repository.createContentItemWithAsset({
    brief: validCampaignBrief, // reutiliza el fixture de brief que ya use este archivo
    asset: validAssetUpload,   // reutiliza el fixture de asset que ya use este archivo
  });

  expect(rpc).toHaveBeenCalledWith(
    "create_content_item_with_asset_in_organization",
    expect.objectContaining({
      p_actor_metadata: { via: "api_key", apiKeyId: "key-1", apiKeyLabel: "n8n integration" },
    }),
  );
});

it("passes an empty p_actor_metadata when the organization context has no apiKey (session-authenticated)", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { id: "content-1" }, error: null });
  const repository = createSupabaseRepository(
    { rpc, storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }) }) } } as never,
    { organizationId: "org-1", userId: "user-1", role: "owner" },
  );

  await repository.createContentItemWithAsset({ brief: validCampaignBrief, asset: validAssetUpload });

  expect(rpc).toHaveBeenCalledWith(
    "create_content_item_with_asset_in_organization",
    expect.objectContaining({ p_actor_metadata: {} }),
  );
});
```

(Ajusta los nombres de los fixtures `validCampaignBrief`/`validAssetUpload`/el mock de `storage.from(...).upload` a lo que el archivo real ya declara — el punto no negociable es la aserción sobre `p_actor_metadata`, no los datos de entrada exactos. Escribe el par equivalente para `enqueueCopyJob` en el mismo archivo o el que ya cubra ese método, verificando `p_actor_metadata` en la llamada a `"enqueue_copy_automation_job"`.)

**Además, corrección ronda 2 (hallazgo real):** `tests/content/supabase-repository.test.ts:367` ya tiene un test existente para `enqueueCopyJob` con una aserción exacta sobre los argumentos de `client.rpc(...)` — al agregar `p_actor_metadata` a esa llamada real (Step 3), esa aserción existente deja de coincidir. Actualízala en el mismo commit para incluir `p_actor_metadata: {}`, no la dejes rota.

- [ ] **Step 2: Confirmar que fallan**

Run: `npm test -- tests/organizations/context.test.ts`
Expected: FAIL en el primer test (`apiKey` no existe en el tipo todavía). Localiza y corre también el archivo de test del repositorio que cubre estos dos métodos; debe fallar igual.

- [ ] **Step 3: Implementar**

En `lib/organizations/context.ts`, extiende el tipo:

```typescript
export type OrganizationApiKeyContext = {
  id: string;
  label: string;
};

export type OrganizationMembership = {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  apiKey?: OrganizationApiKeyContext;
};
```

(`OrganizationContext = OrganizationMembership` ya existe — no hace falta tocar esa línea.)

En `lib/supabase/repository.ts`, dentro de `createContentItemWithAsset` (alrededor de la línea 588), agrega al objeto pasado a `.rpc(...)`:

```typescript
p_actor_metadata: this.organization.apiKey
  ? { via: "api_key", apiKeyId: this.organization.apiKey.id, apiKeyLabel: this.organization.apiKey.label }
  : {},
```

Y en `enqueueCopyJob` (alrededor de la línea 970), el mismo patrón dentro del objeto que ya se pasa a `.rpc("enqueue_copy_automation_job", {...})`.

- [ ] **Step 4: Confirmar que pasan**

Run: `npm test -- tests/organizations/context.test.ts tests/content/supabase-repository.test.ts`
Expected: PASS — 1 test nuevo en `context.test.ts`, 4 nuevos (2 pares) más la aserción actualizada en `supabase-repository.test.ts`.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/organizations/context.ts lib/supabase/repository.ts tests/organizations/context.test.ts tests/content/supabase-repository.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add lib/organizations/context.ts lib/supabase/repository.ts tests/organizations/context.test.ts tests/content/supabase-repository.test.ts
git commit -m "feat: thread API key context into audit metadata"
```

---

### Task 4: `lib/api/keys.ts` — verificación de clave

**Corrección ronda 1 de revisión del plan (rediseño, no solo un fix puntual):** la versión anterior de este task hacía que `verifyApiKey` resolviera TAMBIÉN el rol de membresía (una segunda consulta a `organization_members`), duplicando lógica que `requireOrganizationContext` (`lib/organizations/context.ts:35-54`) ya existe para hacer — y como resultado, el spec exigía que la Task 5 usara `requireOrganizationContext` para la revalidación de membresía/manejo de `OrganizationAccessError`, pero la Task 5 nunca lo hacía, porque `verifyApiKey` ya se había quedado con toda la lógica. Se separa así: **esta task SOLO verifica el secreto y resuelve `organizationId`/`userId`/`apiKey`** — una única consulta, sin rol. La Task 5 usa `requireOrganizationContext` para resolver el rol real y manejar `OrganizationAccessError`, reutilizando código existente en vez de duplicar su lógica.

**Files:**
- Create: `lib/api/keys.ts`
- Test: `lib/api/keys.test.ts`

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import { verifyApiKey, ApiKeyAuthenticationError } from "@/lib/api/keys";

function serviceClient(overrides: Partial<{ keyRow: unknown; keyError: unknown }> = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: overrides.keyRow ?? null,
    error: overrides.keyError ?? null,
  });
  const is = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi.fn().mockReturnValue({ is });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

describe("verifyApiKey", () => {
  it("resolves organizationId/userId/apiKey from a valid, active key", async () => {
    const client = serviceClient({
      keyRow: { id: "key-1", organization_id: "org-1", label: "n8n", created_by: "user-1" },
    });
    const result = await verifyApiKey("sk_live_abc", client as never);
    expect(result).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      apiKey: { id: "key-1", label: "n8n" },
    });
  });

  it("hashes the secret before querying — never queries with the raw secret", async () => {
    const client = serviceClient({
      keyRow: { id: "key-1", organization_id: "org-1", label: "n8n", created_by: "user-1" },
    });
    await verifyApiKey("sk_live_abc", client as never);
    const selectCall = vi.mocked(client.from).mock.results[0]!.value.select;
    const eqCall = vi.mocked(selectCall).mock.results[0]!.value.eq;
    expect(eqCall).toHaveBeenCalledWith("key_hash", expect.not.stringContaining("sk_live_abc"));
  });

  it("rejects when no key row matches (unknown or revoked secret)", async () => {
    const client = serviceClient({ keyRow: null });
    await expect(verifyApiKey("sk_live_unknown", client as never)).rejects.toThrow(ApiKeyAuthenticationError);
  });

  it("rejects on a real lookup failure (not a leak — same error type as an unknown key)", async () => {
    const client = serviceClient({ keyError: new Error("connection reset") });
    await expect(verifyApiKey("sk_live_abc", client as never)).rejects.toThrow(ApiKeyAuthenticationError);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- lib/api/keys.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
import "server-only";
import { createHash } from "node:crypto";

export class ApiKeyAuthenticationError extends Error {
  constructor() {
    super("Invalid or revoked API key.");
    this.name = "ApiKeyAuthenticationError";
  }
}

export type ApiKeyPrincipal = {
  organizationId: string;
  userId: string;
  apiKey: { id: string; label: string };
};

// Corrección ronda 1 de revisión del plan (hallazgo real): el cliente real
// de Supabase devuelve un PostgrestBuilder, que implementa PromiseLike, no
// Promise — un tipo estructural que exige Promise<...> no compila contra
// el cliente real. PromiseLike es correcto aquí y sigue siendo awaitable.
type ServiceRoleClientLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        is: (column: string, value: null) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
};

export async function verifyApiKey(
  secret: string,
  serviceClient: ServiceRoleClientLike,
): Promise<ApiKeyPrincipal> {
  const keyHash = createHash("sha256").update(secret).digest("hex");

  const { data: keyRow, error: keyError } = await serviceClient
    .from("organization_api_keys")
    .select("id, organization_id, label, created_by")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (keyError || !keyRow) throw new ApiKeyAuthenticationError();

  const key = keyRow as { id: string; organization_id: string; label: string; created_by: string };
  return {
    organizationId: key.organization_id,
    userId: key.created_by,
    apiKey: { id: key.id, label: key.label },
  };
}
```

(Verifica el tipo real de retorno de `createSupabaseServiceRoleClient()` contra `lib/supabase/server.ts:36-47` antes de dar por bueno `ServiceRoleClientLike` — el objetivo es que la llamada real `verifyApiKey(secret, createSupabaseServiceRoleClient())` en la Task 5 compile sin `as never`/`as any`; ajusta la forma estructural si el cliente real encadena los métodos de otro modo.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- lib/api/keys.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/api/keys.ts lib/api/keys.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add lib/api/keys.ts lib/api/keys.test.ts
git commit -m "feat: add API key hash verification"
```

---

### Task 5: Fachada de autenticación para `/api/v1/*` — construir el repositorio de la request

Este módulo es el punto único que las rutas de `/api/v1/*` (Tasks 9-10) usan para pasar de un `Request` a un repositorio listo para usar.

**Corrección ronda 1 de revisión del plan (hallazgo real — esta task, tal como estaba antes, no hacía lo que el spec exige):** el spec (sección "Autenticación de la superficie v1", paso 7) exige que esta capa use `requireOrganizationContext` (`lib/organizations/context.ts:35-54`) para resolver el rol real y capturar `OrganizationAccessError` si la membresía desapareció entre la verificación de la clave y la construcción del repositorio. La versión anterior de este task construía el `OrganizationContext` directo desde `verifyApiKey`, sin pasar por `requireOrganizationContext` en absoluto — ahora que la Task 4 ya no resuelve el rol (ver su corrección), esta task es el lugar correcto para hacerlo, reutilizando la función existente en vez de reimplementar su lógica.

**Files:**
- Create: `lib/api/v1-context.ts`
- Test: `lib/api/v1-context.test.ts`

**Antes de escribir código, lee `lib/organizations/context.ts` completo y `lib/content/repository-factory.ts:106-194`** — esta función combina ambas: usa `requireOrganizationContext` (como ya hace `repository-factory.ts:177-191`) para resolver membresía/rol, pero con `getSession`/`getMembership` construidos desde la clave de API en vez de una sesión de cookies.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/keys", () => ({
  verifyApiKey: vi.fn(),
  ApiKeyAuthenticationError: class ApiKeyAuthenticationError extends Error {},
}));
vi.mock("@/lib/content/repository-factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/content/repository-factory")>();
  return { ...actual, getContentRepositoryMode: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/supabase/repository", () => ({
  createSupabaseRepository: vi.fn(),
}));

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";
import { verifyApiKey } from "@/lib/api/keys";
import { getContentRepositoryMode } from "@/lib/content/repository-factory";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createSupabaseRepository } from "@/lib/supabase/repository";

function requestWithAuth(header?: string) {
  const headers = new Headers();
  if (header) headers.set("authorization", header);
  return new Request("http://localhost/api/v1/campaigns", { headers });
}

function fakeServiceClient(membershipRow: unknown, membershipError: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: membershipRow, error: membershipError });
  const eq2 = vi.fn().mockReturnValue({ maybeSingle });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });
  return { from };
}

describe("resolveV1RequestContext", () => {
  it("rejects a missing Authorization header", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    await expect(resolveV1RequestContext(requestWithAuth())).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects a header that isn't a Bearer token", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    await expect(resolveV1RequestContext(requestWithAuth("Basic xyz"))).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects when the app is in demo or misconfigured mode, even with a well-formed key", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("demo");
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"))).rejects.toThrow(V1NotConfiguredError);
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it("wraps ApiKeyAuthenticationError as V1AuthenticationError, not an unhandled exception", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fakeServiceClient(null) as never);
    const { ApiKeyAuthenticationError } = await import("@/lib/api/keys");
    vi.mocked(verifyApiKey).mockRejectedValue(new ApiKeyAuthenticationError());
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_bad"))).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects when the key's creator has no membership in the organization at all (OrganizationAccessError, not an unhandled exception)", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(verifyApiKey).mockResolvedValue({
      organizationId: "org-1", userId: "user-1", apiKey: { id: "key-1", label: "n8n" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(fakeServiceClient(null) as never);
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"))).rejects.toThrow(V1AuthenticationError);
  });

  it("rejects when the key's creator is no longer an owner (role changed since the key was created)", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(verifyApiKey).mockResolvedValue({
      organizationId: "org-1", userId: "user-1", apiKey: { id: "key-1", label: "n8n" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeServiceClient({ organization_id: "org-1", user_id: "user-1", role: "editor" }) as never,
    );
    await expect(resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"))).rejects.toThrow(V1AuthenticationError);
  });

  it("returns a fresh repository built from the verified owner's real membership", async () => {
    vi.mocked(getContentRepositoryMode).mockReturnValue("supabase");
    vi.mocked(verifyApiKey).mockResolvedValue({
      organizationId: "org-1", userId: "user-1", apiKey: { id: "key-1", label: "n8n" },
    });
    const serviceClient = fakeServiceClient({ organization_id: "org-1", user_id: "user-1", role: "owner" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient as never);
    const fakeRepository = { listContentItems: vi.fn() };
    vi.mocked(createSupabaseRepository).mockReturnValue(fakeRepository as never);

    const result = await resolveV1RequestContext(requestWithAuth("Bearer sk_live_abc"));

    expect(result.organization).toEqual({
      organizationId: "org-1", userId: "user-1", role: "owner",
      apiKey: { id: "key-1", label: "n8n" },
    });
    expect(result.repository).toBe(fakeRepository);
    // Construido de cero, con el mismo cliente de service role usado para
    // verificar la clave — nunca el demoRepository singleton.
    expect(createSupabaseRepository).toHaveBeenCalledWith(serviceClient, result.organization);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- lib/api/v1-context.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
import "server-only";

import { verifyApiKey, ApiKeyAuthenticationError } from "@/lib/api/keys";
import { getContentRepositoryMode } from "@/lib/content/repository-factory";
import {
  requireOrganizationContext,
  OrganizationAccessError,
  type OrganizationApiKeyContext,
} from "@/lib/organizations/context";
import { createSupabaseRepository } from "@/lib/supabase/repository";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type { ContentRepository } from "@/lib/content/repository";
import type { OrganizationContext } from "@/lib/organizations/context";

export class V1AuthenticationError extends Error {
  constructor() {
    super("Invalid or missing API key.");
    this.name = "V1AuthenticationError";
  }
}

export class V1NotConfiguredError extends Error {
  constructor() {
    super("API v1 is not available: Supabase is not configured.");
    this.name = "V1NotConfiguredError";
  }
}

export type V1RequestContext = {
  organization: OrganizationContext;
  repository: ContentRepository;
};

function extractBearerSecret(request: Request): string {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer (.+)$/);
  if (!match) throw new V1AuthenticationError();
  return match[1];
}

// Construye un repositorio nuevo, no cacheado, en cada llamada — nunca se
// reutiliza entre requests concurrentes (a diferencia del demoRepository
// singleton de repository-factory.ts, que este módulo evita por completo
// al rechazar el modo demo antes de llegar ahí).
export async function resolveV1RequestContext(request: Request): Promise<V1RequestContext> {
  if (getContentRepositoryMode() !== "supabase") {
    throw new V1NotConfiguredError();
  }

  const secret = extractBearerSecret(request);
  const serviceClient = createSupabaseServiceRoleClient();

  let apiKeyPrincipal: { organizationId: string; userId: string; apiKey: OrganizationApiKeyContext };
  try {
    apiKeyPrincipal = await verifyApiKey(secret, serviceClient);
  } catch (error) {
    if (error instanceof ApiKeyAuthenticationError) throw new V1AuthenticationError();
    throw error;
  }

  let membership: OrganizationContext;
  try {
    membership = await requireOrganizationContext(apiKeyPrincipal.organizationId, {
      getSession: async () => ({ userId: apiKeyPrincipal.userId }),
      getMembership: async ({ organizationId, userId }) => {
        const { data, error } = await serviceClient
          .from("organization_members")
          .select("organization_id, user_id, role")
          .eq("organization_id", organizationId)
          .eq("user_id", userId)
          .maybeSingle();
        if (error || !data) return null;
        const row = data as { organization_id: string; user_id: string; role: string };
        return { organizationId: row.organization_id, userId: row.user_id, role: row.role as never };
      },
    });
  } catch (error) {
    if (error instanceof OrganizationAccessError) throw new V1AuthenticationError();
    throw error;
  }

  // Explícito: aunque cualquier rol produce un OrganizationContext válido,
  // solo un owner puede haber creado esta clave (create_organization_api_key
  // lo exige) — si ya no lo es, se trata igual que una clave inválida.
  if (membership.role !== "owner") throw new V1AuthenticationError();

  const organization: OrganizationContext = { ...membership, apiKey: apiKeyPrincipal.apiKey };
  const repository = createSupabaseRepository(serviceClient, organization);
  return { organization, repository };
}
```

(Verifica la firma real de `createSupabaseRepository` y el tipo exacto de fila que devuelve una consulta a `organization_members` contra los archivos reales antes de dar esto por bueno — el ejemplo asume que acepta `(client, organization)` como ya vimos en `repository-factory.ts:193`, y que `organization_role` en la fila es directamente asignable a `OrganizationRole`.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- lib/api/v1-context.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/api/v1-context.ts lib/api/v1-context.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add lib/api/v1-context.ts lib/api/v1-context.test.ts
git commit -m "feat: add API v1 request authentication context"
```

---

### Task 6: Rutas de gestión de claves (autenticadas por sesión)

**Files:**
- Create: `app/api/organizations/[id]/api-keys/route-handlers.ts` (POST, GET — inyectable para test, mismo patrón que `route.ts`/lógica separada ya usa `app/api/organizations/[id]/logo/route.ts`)
- Create: `app/api/organizations/[id]/api-keys/route.ts` (reexporta `GET`/`POST` de `route-handlers.ts` sin dependencias inyectadas — el patrón real de Next.js)
- Create: `app/api/organizations/[id]/api-keys/[keyId]/route-handlers.ts` (DELETE)
- Create: `app/api/organizations/[id]/api-keys/[keyId]/route.ts`
- Test: `tests/organizations/api-keys-route.test.ts`

**Corrección ronda 1 de revisión del plan (hallazgo real):** la versión anterior de este task tenía el test importando `.../api-keys/route-handlers`, pero ese archivo nunca aparecía en `Files` ni en el `git add` del Step 6 — no puede existir sin declararlo. Ahora está explícito arriba, siguiendo el mismo patrón de separación `route-handlers.ts`/`route.ts` que ya usa `app/api/organizations/[id]/logo/route.ts` (revísalo para el ejemplo exacto de cómo `route.ts` importa y reexporta desde `route-handlers.ts`).

**Antes de escribir código, lee `app/api/organizations/[id]/profile/route.ts` completo** — estas rutas siguen su misma secuencia base (validar UUID con zod → `supabase.auth.getUser()` → resolver membership), con sesión de navegador, no clave de API — son las rutas que un owner usa desde el dashboard para gestionar sus propias claves.

- [ ] **Step 1: Escribir los tests que fallan**

**Corrección ronda 2 de revisión del plan (hallazgo real):** el patrón real de `app/api/organizations/[id]/logo/route.ts:34` inyecta **dos** dependencias de auth por separado — `getSession` y `getMembership` — no solo la segunda. La versión anterior de este task solo inyectaba `getMembership` en todos los tests, lo que no compila contra el patrón real o termina pegándole a Supabase real para resolver la sesión. Todos los `createApiKey*Handler(...)` de abajo pasan ambas.

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

import {
  createApiKeyCreateHandler,
  createApiKeyListHandler,
  createApiKeyRevokeHandler,
} from "@/app/api/organizations/[id]/api-keys/route-handlers";

const organizationId = "1e62a32f-64c2-4da4-bad0-2837baad7812";
const ownerSession = { getSession: async () => ({ userId: "user-1" }), getMembership: async () => ({ role: "owner" }) };

function context(extra: Record<string, string> = {}) {
  return { params: Promise.resolve({ id: organizationId, ...extra }) };
}

describe("POST /api/organizations/[id]/api-keys", () => {
  it("unwraps the single row the RPC returns as an array into a flat object", async () => {
    // Corrección ronda 3 del spec: create_organization_api_key usa
    // `returns table`, que PostgREST expone como un arreglo aunque haya una
    // sola fila — la ruta debe desenvolverlo explícitamente.
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "key-1", key_prefix: "sk_live_a1b2", secret: "sk_live_a1b2c3..." }],
      error: null,
    });
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: "key-1", keyPrefix: "sk_live_a1b2", secret: "sk_live_a1b2c3...",
    });
  });

  it("responds 500 if the RPC unexpectedly returns zero or multiple rows, instead of silently picking one", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(500);
  });

  it("responds 403 when the RPC rejects a non-owner", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "NOT_ORGANIZATION_OWNER" } });
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(403);
  });

  it("rejects an empty label with 400 before calling the RPC", async () => {
    const rpc = vi.fn();
    const handler = createApiKeyCreateHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/organizations/[id]/api-keys", () => {
  it("lists key metadata, never the secret or hash", async () => {
    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockResolvedValue({
      data: [{ id: "key-1", label: "n8n", key_prefix: "sk_live_a1b2", created_at: "2026-09-15T00:00:00Z", last_used_at: null, revoked_at: null }],
      error: null,
    });
    const from = vi.fn().mockReturnValue({ select, eq });
    const handler = createApiKeyListHandler({ ...ownerSession, getClient: async () => ({ from } as never) });
    const response = await handler(new Request("http://localhost"), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keys[0]).not.toHaveProperty("secret");
    expect(body.keys[0]).not.toHaveProperty("keyHash");
  });

  it("filters by the organization_id in the URL, not just by the caller's owner role", async () => {
    // Corrección ronda 2 de revisión del plan (hallazgo real): la policy de
    // RLS deja leer claves de CUALQUIER organización donde el caller sea
    // owner — sin un filtro explícito por organization_id, un owner de
    // varias organizaciones vería claves de la organización equivocada al
    // pedir GET para una específica.
    const eq = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const handler = createApiKeyListHandler({ ...ownerSession, getClient: async () => ({ from } as never) });
    await handler(new Request("http://localhost"), context());
    expect(eq).toHaveBeenCalledWith("organization_id", organizationId);
  });
});

describe("DELETE /api/organizations/[id]/api-keys/[keyId]", () => {
  it("revokes the key via the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const handler = createApiKeyRevokeHandler({ ...ownerSession, getClient: async () => ({ rpc } as never) });
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context({ keyId: "key-1" }),
    );
    expect(response.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("revoke_organization_api_key", { p_key_id: "key-1" });
  });
});

// Corrección ronda 1 de revisión del plan (hallazgo real): los tests de
// arriba solo prueban que un error DEVUELTO POR LA RPC se traduce en 403 —
// una implementación que se saltara el gate de la ruta y llamara la RPC
// directamente para CUALQUIER rol pasaría igual, porque el mock de la RPC
// nunca refleja el rol real. Estos tres tests fuerzan el gate a nivel de
// ruta: mockean la resolución de membership (no la RPC) devolviendo un rol
// no-owner, y confirman que la RPC ni se llama.
describe("owner-only gate enforced by the route itself, not just the RPC", () => {
  const nonOwnerSession = { getSession: async () => ({ userId: "user-1" }), getMembership: async () => ({ role: "editor" }) };

  it("POST rejects a non-owner without calling create_organization_api_key", async () => {
    const rpc = vi.fn();
    const handler = createApiKeyCreateHandler({ ...nonOwnerSession, getClient: async () => ({ rpc } as never) });
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ label: "n8n" }) });
    const response = await handler(request, context());
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("GET rejects a non-owner without querying organization_api_keys", async () => {
    const from = vi.fn();
    const handler = createApiKeyListHandler({ ...nonOwnerSession, getClient: async () => ({ from } as never) });
    const response = await handler(new Request("http://localhost"), context());
    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("DELETE rejects a non-owner without calling revoke_organization_api_key", async () => {
    const rpc = vi.fn();
    const handler = createApiKeyRevokeHandler({ ...nonOwnerSession, getClient: async () => ({ rpc } as never) });
    const response = await handler(
      new Request("http://localhost", { method: "DELETE" }),
      context({ keyId: "key-1" }),
    );
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});
```

(`route-handlers.ts` separado de `route.ts` sigue el patrón ya usado en otras rutas de este proyecto para poder inyectar dependencias en el test sin pegarle a Supabase real — revisa `app/api/organizations/[id]/logo/route.ts` para el patrón exacto de `createOrganizationLogoGetHandler`/`withDependencies` y replícalo aquí en vez de inventar uno nuevo. `getSession`/`getMembership` en las inyecciones de arriba son las mismas dos dependencias que ese patrón ya usa — ajusta los nombres exactos a como ese archivo real las llama.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/organizations/api-keys-route.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

Sigue el patrón de `app/api/organizations/[id]/logo/route.ts` (auth de sesión vía `getSession` → resolver membership vía `getMembership` → gate `canManageConnections`, owner-únicamente, igual que las claves de API) para las tres rutas. Puntos no negociables del spec/plan:
- `POST`: valida `label` no vacío con zod antes de llamar la RPC; llama `create_organization_api_key`; **desenvuelve `data[0]`** del arreglo devuelto (`data.length !== 1` → `500`); responde `201` con `{ id, keyPrefix, secret }` (mapea `key_prefix`→`keyPrefix` en la respuesta).
- `GET`: `select` directo sobre `organization_api_keys` con las columnas seguras (las mismas que el `grant select (...)` de la Task 1 permite) — nunca pidas `key_hash`. **Corrección ronda 2 de revisión del plan (hallazgo real):** además filtra explícitamente `.eq("organization_id", organizationId)` — la policy de RLS por sí sola permite a un owner leer claves de CUALQUIERA de sus organizaciones, no solo la de la URL, así que sin este filtro un owner de varias organizaciones vería la lista equivocada.
- `DELETE`: llama `revoke_organization_api_key` con el `keyId` de la URL; `204` sin body en éxito.
- Las tres exigen rol owner (mismo gate `canManageConnections` que ya usa Logo Studio) antes de llegar a la RPC — la RPC también lo exige, pero fallar rápido en la ruta da un mensaje más claro que dejar que la RPC lo rechace.

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/organizations/api-keys-route.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: `tsc`, lint, build**

Run: `npx tsc --noEmit && npx eslint "app/api/organizations/[id]/api-keys/**/*.ts" tests/organizations/api-keys-route.test.ts && npm run build`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add "app/api/organizations/[id]/api-keys" tests/organizations/api-keys-route.test.ts
git commit -m "feat: add session-authenticated API key management routes"
```

(El `git add` de la carpeta captura los 4 archivos nuevos — `route-handlers.ts`/`route.ts` en ambos niveles — confirma con `git status` antes de commitear que los 4 están efectivamente staged, no solo los dos `route.ts`.)

---

### Task 7: Bajar `MAX_LOGO_BYTES` a 2MB y exportarlo

**Files:**
- Modify: `app/api/organizations/[id]/logo/route.ts`
- Test: `tests/api/organization-logo.test.ts` (ya existe — ajusta el caso de tamaño, no reescribas el archivo completo)

- [ ] **Step 1: Ajustar el test existente que verifica el límite**

Busca el test `"rejects a file over 5MB with 413"` en `tests/api/organization-logo.test.ts` y cámbialo a 2MB:

```typescript
it("rejects a file over 2MB with 413", async () => {
  const tooLarge = new Uint8Array(2 * 1024 * 1024 + 1);
  tooLarge.set(pngSignature);
  // ...resto del test igual, solo cambia el tamaño y el nombre.
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/api/organization-logo.test.ts`
Expected: FAIL — la constante todavía es 5MB.

- [ ] **Step 3: Implementar**

En `app/api/organizations/[id]/logo/route.ts:11`, cambia:

```typescript
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
```

a:

```typescript
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
```

(Exportada — la Task 8 la importa para el mismo límite en la validación del logo descargado, un único lugar de verdad.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/api/organization-logo.test.ts`
Expected: PASS.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint "app/api/organizations/[id]/logo/route.ts" tests/api/organization-logo.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add "app/api/organizations/[id]/logo/route.ts" tests/api/organization-logo.test.ts
git commit -m "fix: lower and export MAX_LOGO_BYTES to 2MB for API-driven compositing"
```

---

### Task 8: `lib/logo-studio/compose-server.ts` — puerto server-side con `sharp`

**Files:**
- Create: `lib/logo-studio/compose-server.ts`
- Test: `lib/logo-studio/compose-server.test.ts`
- Modify: `package.json` (agrega `sharp` a `dependencies`)

**Elección de librería:** `sharp` en vez de `@napi-rs/canvas` — la operación necesaria (redimensionar el logo al tamaño calculado por `computeLogoPlacement` y superponerlo en una posición x/y sobre el creativo) es exactamente el caso de uso de `sharp.composite()`, con una API mucho más directa para esto que replicar llamadas de dibujo de Canvas a mano. `sharp` ya es una dependencia habitual en el ecosistema Next.js (Next la usa para su propia optimización de imágenes).

- [ ] **Step 1: Instalar `sharp`**

```bash
npm install sharp
```

- [ ] **Step 2: Escribir el test que falla**

```typescript
/** @vitest-environment node */
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { composeLogoServerSide, LogoTooLargeError } from "@/lib/logo-studio/compose-server";

async function solidPng(width: number, height: number, color: { r: number; g: number; b: number; alpha: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

describe("composeLogoServerSide", () => {
  it("overlays the logo onto the creative at the position computeLogoPlacement would compute", async () => {
    const creative = await solidPng(1080, 1350, { r: 255, g: 0, b: 0, alpha: 1 });
    const logo = await solidPng(200, 100, { r: 0, g: 255, b: 0, alpha: 1 });

    const result = await composeLogoServerSide({
      creativeBytes: creative,
      logoBytes: logo,
      options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
      outputFormat: "image/png",
    });

    const resultImage = sharp(result);
    const metadata = await resultImage.metadata();
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(1350);
    // Esquina inferior derecha debe tener algo de verde (el logo); esquina
    // superior izquierda debe seguir siendo puro rojo (sin logo ahí).
    const bottomRightPixel = await resultImage
      .clone()
      .extract({ left: 1000, top: 1300, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(bottomRightPixel[1]).toBeGreaterThan(100); // canal verde presente
    const topLeftPixel = await resultImage
      .clone()
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(topLeftPixel[0]).toBeGreaterThan(200); // sigue siendo rojo puro
    expect(topLeftPixel[1]).toBeLessThan(50);
  });

  it(`rejects a logo over MAX_LOGO_BYTES even though it was already accepted at upload time (fallback para logos heredados)`, async () => {
    const creative = await solidPng(1080, 1350, { r: 255, g: 0, b: 0, alpha: 1 });
    const oversizedLogo = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(
      composeLogoServerSide({
        creativeBytes: creative,
        logoBytes: oversizedLogo,
        options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
        outputFormat: "image/png",
      }),
    ).rejects.toThrow(LogoTooLargeError);
  });

  it("outputs JPEG when outputFormat is image/jpeg", async () => {
    const creative = await solidPng(1080, 1350, { r: 255, g: 0, b: 0, alpha: 1 });
    const logo = await solidPng(200, 100, { r: 0, g: 255, b: 0, alpha: 1 });
    const result = await composeLogoServerSide({
      creativeBytes: creative, logoBytes: logo,
      options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
      outputFormat: "image/jpeg",
    });
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe("jpeg");
  });
});
```

- [ ] **Step 3: Confirmar que falla**

Run: `npm test -- lib/logo-studio/compose-server.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 4: Implementar**

```typescript
import "server-only";
import sharp from "sharp";

import { computeLogoPlacement, type CompositeOptions, type OutputFormat } from "@/lib/logo-studio/compose";
import { MAX_LOGO_BYTES } from "@/app/api/organizations/[id]/logo/route";

export class LogoTooLargeError extends Error {
  constructor() {
    super(`The stored logo exceeds ${MAX_LOGO_BYTES} bytes and cannot be used for server-side compositing.`);
    this.name = "LogoTooLargeError";
  }
}

export async function composeLogoServerSide(input: {
  creativeBytes: Buffer;
  logoBytes: Buffer;
  options: CompositeOptions;
  outputFormat: OutputFormat;
  jpegQuality?: number;
}): Promise<Buffer> {
  if (input.logoBytes.byteLength > MAX_LOGO_BYTES) {
    throw new LogoTooLargeError();
  }

  const creative = sharp(input.creativeBytes);
  const creativeMetadata = await creative.metadata();
  const creativeWidth = creativeMetadata.width ?? 0;
  const creativeHeight = creativeMetadata.height ?? 0;

  const logo = sharp(input.logoBytes);
  const logoMetadata = await logo.metadata();
  const logoWidth = logoMetadata.width ?? 0;
  const logoHeight = logoMetadata.height ?? 0;

  const placement = computeLogoPlacement(creativeWidth, creativeHeight, logoWidth, logoHeight, input.options);

  const resizedLogo = await logo
    .resize(Math.round(placement.width), Math.round(placement.height))
    .toBuffer();

  const composited = creative.composite([
    { input: resizedLogo, left: Math.round(placement.x), top: Math.round(placement.y) },
  ]);

  return input.outputFormat === "image/png"
    ? composited.png().toBuffer()
    : composited.jpeg({ quality: Math.round((input.jpegQuality ?? 0.92) * 100) }).toBuffer();
}
```

- [ ] **Step 5: Confirmar que pasa**

Run: `npm test -- lib/logo-studio/compose-server.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/logo-studio/compose-server.ts lib/logo-studio/compose-server.test.ts`
Expected: limpio. Si `sharp` no trae tipos suficientes, instala `@types/sharp` como fallback (las versiones recientes de `sharp` ya incluyen sus propios tipos — confírmalo antes de instalar un paquete extra innecesario).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/logo-studio/compose-server.ts lib/logo-studio/compose-server.test.ts
git commit -m "feat: add server-side logo compositing with sharp"
```

(Confirma que `pnpm-lock.yaml` NO fue tocado — `pnpm` no está instalado en este entorno, ver la nota ya establecida en los planes anteriores de esta sesión.)

---

### Task 9: `GET/POST /api/v1/campaigns` y `GET /api/v1/campaigns/:id`

**Files:**
- Create: `app/api/v1/campaigns/route.ts`
- Create: `app/api/v1/campaigns/[id]/route.ts`
- Modify: `lib/content/repository.ts` (agrega `downloadOrganizationLogo` a la interfaz `ContentRepository`)
- Modify: `lib/supabase/repository.ts` (implementación real, reutilizando el mismo bucket/manejo de `StorageApiError` que `app/api/organizations/[id]/logo/route.ts`)
- Modify: `lib/demo/repository.ts` (implementación de `DemoContentRepository` — sin Storage real en modo demo, devuelve `null` siempre; la API v1 nunca llega a llamarla porque rechaza el modo demo en la Task 5, pero la interfaz debe seguir siendo implementable)
- Test: `tests/api/v1-campaigns.test.ts`

**Corrección ronda 1 de revisión del plan (hallazgo real):** la versión anterior de este task usaba `repository.downloadOrganizationLogo?.()` (encadenamiento opcional) como si el método pudiera no existir — eso permite que una implementación incompleta omita el estampado en silencio. Ahora es un método **requerido** de `ContentRepository`, implementado en las dos clases que la satisfacen hoy (`SupabaseRepository`/`DemoContentRepository`) — verifica con `grep -rn "implements ContentRepository\|: ContentRepository" lib/` que no haya una tercera implementación antes de dar esto por completo.

**Antes de escribir código, lee `app/api/content/route.ts` y `app/api/content/[id]/route.ts` completos, Y `app/api/organizations/[id]/logo/route.ts` (la parte del `GET`, líneas ~88-109) para el manejo exacto de `StorageApiError`/`NoSuchKey`** — estas rutas nuevas replican el contrato exacto de las primeras dos (mismo `campaignBriefSchema`, mismo `validateAsset`, mismo `MAX_MULTIPART_BYTES`, mismo `enqueueCopyJob` tras crear el item, mismo checksum sha-256), cambiando únicamente la resolución de auth (`resolveV1RequestContext` de la Task 5 en vez de `createContentRepository`) y agregando el paso de estampado de logo entre validar el asset y crear el item.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/v1-context", () => ({
  resolveV1RequestContext: vi.fn(),
  V1AuthenticationError: class V1AuthenticationError extends Error {},
  V1NotConfiguredError: class V1NotConfiguredError extends Error {},
}));
vi.mock("@/lib/logo-studio/compose-server", () => ({
  composeLogoServerSide: vi.fn(),
  LogoTooLargeError: class LogoTooLargeError extends Error {},
}));

import { GET as listCampaigns, POST as createCampaign } from "@/app/api/v1/campaigns/route";
import { GET as getCampaign } from "@/app/api/v1/campaigns/[id]/route";
import { resolveV1RequestContext, V1AuthenticationError } from "@/lib/api/v1-context";
import { composeLogoServerSide } from "@/lib/logo-studio/compose-server";

describe("GET /api/v1/campaigns", () => {
  it("responds 401 when authentication fails, without leaking whether the key format was merely wrong", async () => {
    vi.mocked(resolveV1RequestContext).mockRejectedValue(new V1AuthenticationError());
    const response = await listCampaigns(new Request("http://localhost/api/v1/campaigns"));
    expect(response.status).toBe(401);
  });

  it("lists campaigns for the organization resolved from the key", async () => {
    const listContentSummaries = vi.fn().mockResolvedValue([{ id: "content-1" }]);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { listContentSummaries } as never,
    });
    const response = await listCampaigns(new Request("http://localhost/api/v1/campaigns"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [{ id: "content-1" }] });
  });
});

describe("GET /api/v1/campaigns/:id", () => {
  it("responds 404 for a campaign that doesn't belong to this organization (repository already scopes by organization_id)", async () => {
    const getContentRecord = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { getContentRecord } as never,
    });
    const response = await getCampaign(
      new Request("http://localhost"),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(response.status).toBe(404);
  });
});

// Corrección ronda 2 de revisión del plan (hallazgo real): este helper no
// existía en ningún lado del repositorio — la ronda 1 lo referenciaba como
// si ya existiera. `validateAsset` (lib/content/asset-validation.ts) solo
// lee la firma PNG (8 bytes) y el ancho/alto del chunk IHDR (offsets 16 y
// 20, big-endian) para sus checks de dimensión/aspecto — NO decodifica
// píxeles reales, así que un IHDR mínimo y correcto basta, sin necesidad de
// datos de imagen comprimidos válidos ni de una librería de imágenes real.
function makeValidPng(width = 1080, height = 1350): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // firma PNG
  bytes.set([0, 0, 0, 13], 8); // longitud del chunk IHDR (13, big-endian)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24); // bit depth, color type, compression, filter, interlace
  bytes.set([0, 0, 0, 0], 29); // CRC (no validado por inspectImageDimensions)
  return bytes;
}

describe("POST /api/v1/campaigns", () => {
  function formDataRequest(png: Uint8Array) {
    const formData = new FormData();
    formData.set("brief", JSON.stringify({
      businessLine: "b", service: "s", niche: "n", contentType: "IMAGE", objective: "o",
      format: "SINGLE_IMAGE", cta: "c", humanDescription: "d", allowedFacts: [],
      campaignName: "Campaña", offer: "Oferta", funnelStage: "TOFU",
      destination: "WHATSAPP", destinationValue: "https://wa.me/1",
    }));
    formData.set("asset", new File([png], "creative.png", { type: "image/png" }));
    return new Request("http://localhost", { method: "POST", body: formData });
  }

  it("stamps the organization's logo onto the creative automatically when one is configured", async () => {
    const validCreativePng = makeValidPng();
    // Corrección ronda 2 de revisión del plan (hallazgo real): la versión
    // anterior mockeaba composeLogoServerSide devolviendo
    // Buffer.from("composed-bytes") — bytes que no son un PNG válido. El
    // handler revalida el resultado con el validateAsset REAL después de
    // componer (fix de la ronda 1), así que ese mock habría hecho fallar
    // la request con 400 en vez de 201. El mock debe devolver un PNG
    // realmente válido para que la revalidación posterior lo acepte.
    const composedBuffer = Buffer.from(makeValidPng());
    vi.mocked(composeLogoServerSide).mockResolvedValue(composedBuffer);
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockResolvedValue({ created: true });
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(Buffer.from("logo-bytes"));
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(response.status).toBe(201);
    expect(downloadOrganizationLogo).toHaveBeenCalled();
    expect(composeLogoServerSide).toHaveBeenCalled();
    // El asset persistido debe ser el resultado COMPUESTO, no el creativo
    // original — confirma que los bytes que llegan a
    // createContentItemWithAsset vienen de composedBuffer, no del PNG crudo
    // subido en la request.
    const persistedAsset = createContentItemWithAsset.mock.calls[0][0].asset;
    expect(Buffer.from(persistedAsset.bytes)).toEqual(composedBuffer);
  });

  it("creates the campaign without a logo, without error, when the organization has none configured yet", async () => {
    const validCreativePng = makeValidPng();
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockResolvedValue({ created: true });
    // downloadOrganizationLogo resuelve null cuando no hay logo — el
    // manejo de StorageApiError/NoSuchKey vive DENTRO de la implementación
    // real del repositorio (Step 3), nunca se filtra hasta esta ruta.
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(response.status).toBe(201);
    expect(composeLogoServerSide).not.toHaveBeenCalled();
    const persistedAsset = createContentItemWithAsset.mock.calls[0][0].asset;
    expect(Buffer.from(persistedAsset.bytes)).toEqual(Buffer.from(validCreativePng));
  });

  it("enqueues the copy generation job after creating the item, matching POST /api/content's behavior exactly", async () => {
    const validCreativePng = makeValidPng();
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockResolvedValue({ created: true });
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(enqueueCopyJob).toHaveBeenCalledWith(
      expect.objectContaining({ contentItemId: "content-1" }),
    );
    const body = await response.json();
    expect(body.content.state).toBe("GENERATING");
  });

  it("responds 202 with COPY_QUEUE_PENDING, not a false GENERATING state, when the queue is temporarily unavailable", async () => {
    // Mismo comportamiento que app/api/content/route.ts:119-132 — el asset
    // ya se persistió de forma durable, así que esto no es un error, es un
    // 202 con advertencia para que el caller pueda reintentar el encolado.
    const validCreativePng = makeValidPng();
    const createContentItemWithAsset = vi.fn().mockResolvedValue({ id: "content-1" });
    const enqueueCopyJob = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const downloadOrganizationLogo = vi.fn().mockResolvedValue(null);
    vi.mocked(resolveV1RequestContext).mockResolvedValue({
      organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
      repository: { createContentItemWithAsset, enqueueCopyJob, downloadOrganizationLogo } as never,
    });

    const response = await createCampaign(formDataRequest(validCreativePng));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.warning).toBe("COPY_QUEUE_PENDING");
  });

  it("rejects a request over the multipart size limit with 413 before even reading the body", async () => {
    const request = formDataRequest(makeValidPng());
    Object.defineProperty(request, "headers", {
      value: new Headers({ "content-length": String(25 * 1024 * 1024) }),
    });
    const response = await createCampaign(request);
    expect(response.status).toBe(413);
  });
});
```

(`makeValidPng()` está definido arriba, antes del primer `describe("POST /api/v1/campaigns", ...)` — es síncrono, no devuelve una promesa. `vi.mock("@/lib/logo-studio/compose-server", ...)` con `composeLogoServerSide` mockeado ya está agregado junto a los otros `vi.mock(...)` al inicio del archivo, junto a `resolveV1RequestContext`.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/api/v1-campaigns.test.ts`
Expected: FAIL — los módulos no existen todavía.

- [ ] **Step 3: Implementar**

**Paso previo — agregar `downloadOrganizationLogo` a `ContentRepository` (`lib/content/repository.ts`, junto a las otras firmas de la interfaz):**

```typescript
// Descarga el logo de la organización activa para composición server-side.
// null cuando la organización no tiene logo configurado todavía — nunca
// lanza para ese caso, solo para un fallo real de Storage.
downloadOrganizationLogo(): Promise<Buffer | null>;
```

**Implementación real en `lib/supabase/repository.ts`** (mismo bucket y misma distinción `StorageApiError`/`NoSuchKey` que ya usa `app/api/organizations/[id]/logo/route.ts:88-109` — reutiliza ese predicado exacto, no lo reinventes):

```typescript
async downloadOrganizationLogo(): Promise<Buffer | null> {
  const { data, error } = await this.client.storage
    .from("organization-logos")
    .download(`${this.organization.organizationId}/logo.png`);
  if (error) {
    if (error instanceof StorageApiError && error.code === "NoSuchKey") return null;
    throw error;
  }
  return Buffer.from(await data.arrayBuffer());
}
```

**Implementación en `lib/demo/repository.ts`** (`DemoContentRepository` — sin Storage real en modo demo; la API v1 nunca llega a invocar esto porque la Task 5 rechaza el modo demo antes, pero la interfaz debe seguir siendo implementable):

```typescript
async downloadOrganizationLogo(): Promise<Buffer | null> {
  return null;
}
```

`app/api/v1/campaigns/route.ts`:

```typescript
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";
import { campaignBriefSchema } from "@/lib/content/campaign";
import { AssetValidationError, MAX_ASSET_BYTES, validateAsset } from "@/lib/content/asset-validation";
import { composeLogoServerSide, LogoTooLargeError } from "@/lib/logo-studio/compose-server";

const MAX_MULTIPART_BYTES = MAX_ASSET_BYTES + 64_000;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { repository } = await resolveV1RequestContext(request);
    const items = repository.listContentSummaries
      ? await repository.listContentSummaries()
      : await repository.listContentItems();
    return Response.json({ items });
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    return jsonError("CAMPAIGN_LIST_FAILED", 500);
  }
}

function isFilePart(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value !== "string" && typeof value.arrayBuffer === "function");
}

export async function POST(request: Request): Promise<Response> {
  // Corrección ronda 1 de revisión del plan: límite de multipart ANTES de
  // leer el body, igual que app/api/content/route.ts:75-78 — la versión
  // anterior de este plan lo omitía por completo.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    return jsonError("ASSET_TOO_LARGE", 413);
  }

  try {
    const { repository } = await resolveV1RequestContext(request);

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_MULTIPART_REQUEST", 400);
    }

    const rawBrief = formData.get("brief");
    const assetFile = formData.get("asset");
    if (typeof rawBrief !== "string" || !isFilePart(assetFile)) {
      return jsonError("BRIEF_AND_ASSET_REQUIRED", 400);
    }

    let briefPayload: unknown;
    try {
      briefPayload = JSON.parse(rawBrief);
    } catch {
      return jsonError("INVALID_BRIEF", 400);
    }

    campaignBriefSchema.parse(briefPayload);
    let validatedAsset = await validateAsset(assetFile);
    let finalBytes = validatedAsset.bytes;

    // Estampa el logo de la organización automáticamente si existe — sin
    // logo configurado (downloadOrganizationLogo devuelve null), sigue con
    // el creativo original, sin error (ver spec: "Composición de logo
    // server-side"). El resultado se revalida completo con validateAsset
    // otra vez — recalcula dimensiones/MIME, no confía en el compositor.
    const logoBytes = await repository.downloadOrganizationLogo();
    if (logoBytes) {
      const composedBytes = await composeLogoServerSide({
        creativeBytes: Buffer.from(validatedAsset.bytes),
        logoBytes,
        options: { corner: "bottom-right", sizePercent: 15, marginPercent: 4 },
        outputFormat: validatedAsset.mimeType === "image/png" ? "image/png" : "image/jpeg",
      });
      const composedFile = new File(
        [composedBytes as unknown as BlobPart],
        assetFile.name,
        { type: validatedAsset.mimeType === "image/png" ? "image/png" : "image/jpeg" },
      );
      validatedAsset = await validateAsset(composedFile);
      finalBytes = validatedAsset.bytes;
    }

    // Corrección ronda 1: checksum real sobre los bytes FINALES (compuestos
    // o no), igual que app/api/content/route.ts:103-105 — no un placeholder.
    const checksum = createHash("sha256").update(finalBytes).digest("hex");

    const content = await repository.createContentItemWithAsset({
      brief: briefPayload,
      asset: {
        id: randomUUID(),
        filename: assetFile.name,
        mimeType: validatedAsset.mimeType,
        width: validatedAsset.width,
        height: validatedAsset.height,
        checksum,
        bytes: finalBytes,
      },
    });

    // Corrección ronda 1 (hallazgo real): la versión anterior nunca llamaba
    // enqueueCopyJob y devolvía state: "GENERATING" de todas formas, aunque
    // la base quedaba en UPLOADED sin ningún job de generación encolado —
    // ahora replica exactamente app/api/content/route.ts:119-133.
    try {
      await repository.enqueueCopyJob({
        contentItemId: content.id,
        idempotencyKey: randomUUID(),
      });
    } catch {
      return Response.json({ content, warning: "COPY_QUEUE_PENDING" }, { status: 202 });
    }

    return Response.json({ content: { ...content, state: "GENERATING" } }, { status: 201 });
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    if (error instanceof z.ZodError || error instanceof AssetValidationError) {
      return jsonError("INVALID_CONTENT_ASSET", 400);
    }
    if (error instanceof LogoTooLargeError) return jsonError("LOGO_TOO_LARGE", 503);
    return jsonError("CAMPAIGN_CREATE_FAILED", 500);
  }
}
```

(Verifica el shape real de `ContentRepository`/`SupabaseRepository`/`DemoContentRepository` contra los archivos reales antes de dar esto por bueno — los tres bloques de arriba son el diseño completo, no un boceto, pero confirma nombres exactos de propiedades/imports (`this.client.storage`, `this.organization.organizationId`) contra el código real de `lib/supabase/repository.ts` antes de copiarlos literalmente.)

`app/api/v1/campaigns/[id]/route.ts`:

```typescript
import { z } from "zod";

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";

const contentIdSchema = z.string().uuid();

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const params = await context.params;
    const parsed = contentIdSchema.safeParse(params.id);
    if (!parsed.success) return jsonError("INVALID_CAMPAIGN_ID", 400);

    const { repository } = await resolveV1RequestContext(request);
    const record = await repository.getContentRecord(parsed.data);
    if (!record) return jsonError("CAMPAIGN_NOT_FOUND", 404);
    return Response.json(record);
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    return jsonError("CAMPAIGN_LOOKUP_FAILED", 500);
  }
}
```

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/api/v1-campaigns.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: `tsc`, lint, build**

Run: `npx tsc --noEmit && npx eslint app/api/v1/campaigns/route.ts "app/api/v1/campaigns/[id]/route.ts" lib/content/repository.ts lib/supabase/repository.ts lib/demo/repository.ts tests/api/v1-campaigns.test.ts && npm run build`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/campaigns lib/content/repository.ts lib/supabase/repository.ts lib/demo/repository.ts tests/api/v1-campaigns.test.ts
git commit -m "feat: add GET/POST /api/v1/campaigns with automatic logo stamping"
```

(Confirma con `git status` que los tres archivos de repositorio modificados quedaron staged — es fácil olvidarlos porque no están en `app/api/v1/campaigns`.)

---

### Task 10: `POST /api/v1/campaigns/:id/publish`

**Files:**
- Create: `app/api/v1/campaigns/[id]/publish/route.ts`
- Modify: `lib/content/repository.ts` (agrega `checkPublicationTargetOwnership` a la interfaz)
- Modify: `lib/supabase/repository.ts` (implementación real)
- Modify: `lib/demo/repository.ts` (implementación de `DemoContentRepository`)
- Test: `tests/api/v1-publish.test.ts`

**Corrección ronda 1 de revisión del plan (hallazgo real):** la versión anterior de este task inyectaba un `supabaseClientForTests` inventado en el repositorio de prueba, sin que `checkPublicationTargetOwnership` estuviera declarado en ningún lado real (`ContentRepository`, `SupabaseRepository`, `DemoContentRepository`) ni en la lista de `Files`. Ahora es, igual que `downloadOrganizationLogo` en la Task 9, un método **requerido** de la interfaz, con sus dos implementaciones reales listadas explícitamente — los tests mockean el método del repositorio directamente, no un cliente interno inventado.

**Antes de escribir código, lee `app/api/integrations/n8n/publish/route.ts` y `lib/integrations/n8n-client.ts` completos** — esta ruta reutiliza `requestN8nPublish`, pero deriva `assetUrl`/`copy` del `ContentRecord` almacenado en vez de aceptarlos del caller (hallazgo de seguridad de la ronda 2 del spec).

**Paso previo — agregar `checkPublicationTargetOwnership` a `ContentRepository` (`lib/content/repository.ts`):**

```typescript
// Existencia + pertenencia + estado de un target, clasificados por
// separado de PublishTargetConflictError (que colapsa "no existe" y "error
// real" en el mismo tipo) — ver spec, sección de publicación.
checkPublicationTargetOwnership(
  contentItemId: string,
  publicationTargetId: string,
): Promise<{ target: { id: string; status: string } | null; failed: boolean }>;
```

**Implementación real en `lib/supabase/repository.ts`** (misma consulta base que ya usa `preparePublishRequest`, `lib/supabase/repository.ts:995-1001`, pero sin colapsar "sin fila" y "error" en la misma rama):

```typescript
async checkPublicationTargetOwnership(
  contentItemId: string,
  publicationTargetId: string,
): Promise<{ target: { id: string; status: string } | null; failed: boolean }> {
  const { data, error } = await this.client
    .from("publication_targets")
    .select("id, status")
    .eq("id", publicationTargetId)
    .eq("content_item_id", contentItemId)
    .eq("organization_id", this.organization.organizationId)
    .maybeSingle();
  if (error) return { target: null, failed: true };
  return { target: data as { id: string; status: string } | null, failed: false };
}
```

**Implementación en `lib/demo/repository.ts`** (`DemoContentRepository` — busca en su propia colección local de targets en memoria; sigue el mismo patrón que ya usan sus otros métodos de lectura de `publication_targets`, revísalos antes de escribir este):

```typescript
async checkPublicationTargetOwnership(
  contentItemId: string,
  publicationTargetId: string,
): Promise<{ target: { id: string; status: string } | null; failed: boolean }> {
  const target = /* busca en el store local de demo, filtrando por ambos ids */;
  return { target: target ? { id: target.id, status: target.status } : null, failed: false };
}
```

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/v1-context", () => ({
  resolveV1RequestContext: vi.fn(),
  V1AuthenticationError: class V1AuthenticationError extends Error {},
  V1NotConfiguredError: class V1NotConfiguredError extends Error {},
}));
vi.mock("@/lib/integrations/n8n-client", () => ({
  requestN8nPublish: vi.fn(),
  N8nPublishConfigurationError: class N8nPublishConfigurationError extends Error {},
  N8nPublishDeliveryError: class N8nPublishDeliveryError extends Error {},
}));

import { POST as publishCampaign } from "@/app/api/v1/campaigns/[id]/publish/route";
import { resolveV1RequestContext } from "@/lib/api/v1-context";
import { requestN8nPublish } from "@/lib/integrations/n8n-client";

const contentItemId = "11111111-1111-1111-1111-111111111111";
const targetId = "22222222-2222-2222-2222-222222222222";

function context() {
  return { params: Promise.resolve({ id: contentItemId }) };
}

function requestWithBody(body: unknown) {
  return new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });
}

function mockRepository(overrides: {
  checkPublicationTargetOwnership: { target: { id: string; status: string } | null; failed: boolean };
  getContentRecord?: unknown;
}) {
  vi.mocked(resolveV1RequestContext).mockResolvedValue({
    organization: { organizationId: "org-1", userId: "user-1", role: "owner" },
    repository: {
      checkPublicationTargetOwnership: vi.fn().mockResolvedValue(overrides.checkPublicationTargetOwnership),
      getContentRecord: vi.fn().mockResolvedValue(overrides.getContentRecord ?? null),
    } as never,
  });
}

describe("POST /api/v1/campaigns/:id/publish", () => {
  it("responds 404 when the target doesn't exist for this organization — never distinguishing from a cross-tenant target", async () => {
    mockRepository({ checkPublicationTargetOwnership: { target: null, failed: false } });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(404);
  });

  it("responds 503, not a false 409, when the ownership lookup itself fails", async () => {
    mockRepository({ checkPublicationTargetOwnership: { target: null, failed: true } });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
  });

  it("responds 409 when the target exists for this organization but isn't APPROVED", async () => {
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "PENDING_REVIEW" }, failed: false },
    });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(409);
    expect(requestN8nPublish).not.toHaveBeenCalled();
  });

  it("responds 503 (internal inconsistency, not a caller error) when the approved target has no signed asset URL", async () => {
    // Corrección ronda 1 de revisión del plan (hallazgo real):
    // ContentRecord.asset.signedUrl es opcional (lib/content/repository.ts:90)
    // — sin este guard, un undefined llegaría hasta requestN8nPublish y su
    // propia validación zod lo convertiría en un 400 que culpa al caller,
    // cuando en realidad es un estado interno inconsistente (target
    // aprobado pero sin asset servible).
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "APPROVED" }, failed: false },
      getContentRecord: { asset: {}, finalCopy: { headline: "H", body: "B", cta: "C" } },
    });
    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
    expect(requestN8nPublish).not.toHaveBeenCalled();
  });

  it("derives assetUrl/copy from the stored record server-side — the caller cannot supply their own", async () => {
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "APPROVED" }, failed: false },
      getContentRecord: {
        asset: { signedUrl: "https://storage.example/real-asset.png" },
        finalCopy: { headline: "Real headline", body: "Real body", cta: "Real CTA" },
      },
    });
    vi.mocked(requestN8nPublish).mockResolvedValue({
      created: true, status: "QUEUED", idempotencyKey: "idem-1", publicationTargetId: targetId, platform: "FACEBOOK",
    });

    // El caller intenta declarar su propio assetUrl/copy — debe ser ignorado.
    await publishCampaign(
      requestWithBody({ publicationTargetId: targetId, assetUrl: "https://evil.example/fake.png", copy: { body: "fake" } }),
      context(),
    );

    expect(requestN8nPublish).toHaveBeenCalledWith(
      expect.objectContaining({ assetUrl: "https://storage.example/real-asset.png", copy: expect.objectContaining({ body: "Real body" }) }),
      expect.anything(),
    );
  });

  it("reclassifies a PublishTargetConflictError from the second, redundant preparePublishRequest call as 503, not 409", async () => {
    // El pre-chequeo propio ya confirmó APPROVED; si requestN8nPublish
    // (que internamente vuelve a llamar preparePublishRequest) igual lanza
    // PublishTargetConflictError, es una condición de carrera transitoria,
    // no un 409 real — el 409 real ya se habría dado en el paso anterior.
    mockRepository({
      checkPublicationTargetOwnership: { target: { id: targetId, status: "APPROVED" }, failed: false },
      getContentRecord: {
        asset: { signedUrl: "https://storage.example/real-asset.png" },
        finalCopy: { headline: "H", body: "B", cta: "C" },
      },
    });
    const { PublishTargetConflictError } = await import("@/lib/content/repository");
    vi.mocked(requestN8nPublish).mockRejectedValue(new PublishTargetConflictError());

    const response = await publishCampaign(requestWithBody({ publicationTargetId: targetId }), context());
    expect(response.status).toBe(503);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/api/v1-publish.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
import { z } from "zod";

import { resolveV1RequestContext, V1AuthenticationError, V1NotConfiguredError } from "@/lib/api/v1-context";
import {
  N8nPublishConfigurationError,
  N8nPublishDeliveryError,
  requestN8nPublish,
} from "@/lib/integrations/n8n-client";
import { PublishTargetConflictError } from "@/lib/content/repository";

const bodySchema = z.object({
  publicationTargetId: z.string().uuid(),
  idempotencyKey: z.string().uuid().optional(),
});
const contentIdSchema = z.string().uuid();

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const params = await context.params;
    const contentItemId = contentIdSchema.parse(params.id);

    const { repository } = await resolveV1RequestContext(request);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    const body = bodySchema.parse(rawBody);

    // Paso propio: existencia + pertenencia + estado, antes de tocar
    // requestN8nPublish — clasificación 404/503/409 explícita, no delegada
    // a PublishTargetConflictError (que colapsa "no existe" con "error real").
    const ownershipCheck = await repository.checkPublicationTargetOwnership(
      contentItemId,
      body.publicationTargetId,
    );
    if (ownershipCheck.failed) return jsonError("TARGET_LOOKUP_FAILED", 503);
    if (!ownershipCheck.target) return jsonError("TARGET_NOT_FOUND", 404);
    if (ownershipCheck.target.status !== "APPROVED") return jsonError("TARGET_NOT_APPROVED", 409);

    const record = await repository.getContentRecord(contentItemId);
    // Corrección ronda 1 de revisión del plan (hallazgo real):
    // record.asset.signedUrl es opcional — un target APPROVED sin una URL
    // firmada servible es una inconsistencia interna, no un error del
    // caller. Se distingue explícitamente en vez de dejar que
    // assetUrl: undefined llegue a la validación zod de requestN8nPublish,
    // que lo clasificaría como 400 (culpa del caller) en vez de 503.
    if (!record?.asset?.signedUrl || !record.finalCopy) {
      return jsonError("TARGET_LOOKUP_FAILED", 503);
    }

    try {
      const result = await requestN8nPublish(
        {
          contentItemId,
          publicationTargetId: body.publicationTargetId,
          assetUrl: record.asset.signedUrl,
          idempotencyKey: body.idempotencyKey,
          copy: {
            headline: record.finalCopy.headline,
            body: record.finalCopy.body,
            cta: record.finalCopy.cta,
          },
        },
        { repository },
      );
      return Response.json(result, { status: result.created ? 202 : 200 });
    } catch (error) {
      // Segunda llamada redundante dentro de requestN8nPublish a
      // preparePublishRequest — si conflict aquí, el pre-chequeo de arriba
      // ya probó que el target existe/pertenece/está APPROVED segundos
      // antes, así que es una carrera transitoria, no un 409 real.
      if (error instanceof PublishTargetConflictError) return jsonError("TARGET_LOOKUP_FAILED", 503);
      if (error instanceof N8nPublishConfigurationError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
      if (error instanceof N8nPublishDeliveryError) return jsonError("N8N_DELIVERY_FAILED", 502);
      throw error;
    }
  } catch (error) {
    if (error instanceof V1AuthenticationError) return jsonError("INVALID_API_KEY", 401);
    if (error instanceof V1NotConfiguredError) return jsonError("INTEGRATION_NOT_CONFIGURED", 503);
    if (error instanceof z.ZodError) return jsonError("INVALID_REQUEST", 400);
    return jsonError("PUBLISH_REQUEST_FAILED", 500);
  }
}
```

(Verifica el shape real de `ContentRecord`/`getContentRecord` contra `lib/content/repository.ts`/`lib/supabase/repository.ts:754-758` antes de dar esto por bueno.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/api/v1-publish.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: `tsc`, lint, build**

Run: `npx tsc --noEmit && npx eslint "app/api/v1/campaigns/[id]/publish/route.ts" lib/content/repository.ts lib/supabase/repository.ts lib/demo/repository.ts tests/api/v1-publish.test.ts && npm run build`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add "app/api/v1/campaigns/[id]/publish" lib/content/repository.ts lib/supabase/repository.ts lib/demo/repository.ts tests/api/v1-publish.test.ts
git commit -m "feat: add POST /api/v1/campaigns/:id/publish with server-derived payload"
```

(Confirma con `git status` que los tres archivos de repositorio quedaron staged junto con la ruta nueva — si la Task 9 ya los había modificado y commiteado, este `git add` solo captura los cambios incrementales de esta task.)

---

### Task 11: Verificación final end-to-end

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Suite completa**

Run: `npm test`
Expected: todos los tests en PASS, incluidas las 10 tasks anteriores.

- [ ] **Step 2: Tipos, lint, build**

Run: `npx tsc --noEmit && npm run build`
Expected: limpio. Para lint completo: `npx eslint . --ignore-pattern ".codebase-memory/**"` (evita el `EPERM` conocido de `npm run lint` sin argumentos en este entorno).

- [ ] **Step 3: Confirmar que ningún caller de sesión existente se rompió**

Las dos RPCs recreadas en la Task 2 las siguen llamando rutas de sesión (`POST /api/content`, worker de copy) sin pasar `p_actor_metadata` — corré específicamente sus suites para confirmar que un default de `{}` no cambió su comportamiento:

Run: `npm test -- tests/api/content-create.test.ts tests/content` (ajusta a los nombres reales de archivo que cubren `POST /api/content` y el enqueue de copy jobs)
Expected: PASS, sin cambios de comportamiento respecto a antes de este plan.

- [ ] **Step 4: No commit en este task — es solo verificación**

Si algo falla, vuelve a la task correspondiente y corrige ahí, con su propio commit adicional.

## Fuera de alcance de este plan (recordatorio, ver spec)

- La envoltura MCP en sí — sub-proyecto siguiente, spec y plan aparte, después de que esta API exista mergeada.
- Arreglar el vacío preexistente de `automation_runs`/`PUBLISH_REQUEST` en `preparePublishRequest` — heredado, documentado en el spec, no se toca aquí.
- Scopes finos por acción, rate-limiting, estampado automático de logo en `/library/new` — decisiones de alcance ya cerradas.
