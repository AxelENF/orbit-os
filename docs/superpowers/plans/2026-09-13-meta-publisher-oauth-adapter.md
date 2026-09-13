# Meta Publisher: OAuth + Adaptador Graph API — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar de verdad en Facebook e Instagram (Graph API real, OAuth por organización) gateado por el diagnóstico de ADR-008, reusando el worker durable existente.

**Architecture:** Job del worker (`automation_jobs`, `kind = 'PUBLISH'`) paralelo al de `COPY`, corriendo en el mismo proceso. El diagnóstico corre síncrono en TypeScript al someter el copy final; una RPC (`apply_publication_diagnosis`) decide auto-aprobar o retener para revisión humana. Un adaptador propio (`lib/integrations/meta-publisher.ts`) llama Graph API — sin Postiz, sin n8n.

**Tech Stack:** Next.js 16 (route handlers), Supabase (Postgres + RPCs + Storage signed URLs), Zod, Vitest, Graph API v21.0 (fetch nativo, sin SDK de Meta).

**Spec de referencia:** `docs/superpowers/specs/2026-09-13-meta-publisher-oauth-adapter-design.md` (revisión 4). Este plan asume que ya se leyó — no repite el "por qué", solo el "cómo" y el orden exacto.

**Rama:** `feat/meta-publisher-oauth-adapter` (ya creada sobre `feat/personal-pilot-hardening`).

**Migraciones aplicadas hasta hoy:** `0001`–`0017`. Este plan crea `0018_meta_publisher.sql` — una sola migración, dividida en Tareas 1-7 por claridad, pero se aplica como un solo archivo (no se hace `db push` intermedio entre esas tareas; el archivo se va extendiendo y cada tarea corre sus tests contra el archivo completo hasta ese punto).

---

## Convenciones para quien implemente

- **Nunca** modifiques `supabase/migrations/0001` a `0017`. Todo cambio de esquema va en `0018_meta_publisher.sql`.
- Cada función `SECURITY DEFINER` nueva necesita su par `revoke all ... from public, anon, authenticated;` / `grant execute ... to service_role;` (o el rol que corresponda), igual que el resto del esquema. No hay excepciones.
- **REGLA DE SEGURIDAD GIT:** nunca ejecutes `git reset --hard`, `git checkout --`, `git clean`, ni ningún comando que descarte trabajo ya commiteado. Si algo parece ir mal, para y pregunta — no "limpies" el estado del repo por tu cuenta.
- Sigue TDD: el test se escribe y se corre en rojo antes que la implementación, en cada tarea.
- Commits pequeños y frecuentes — uno por tarea como mínimo (varias tareas piden más de uno).
- Cuando una tarea dice "mismo patrón que X", léelo primero. No lo adivines.

---

## Task 1: `content_item_assets` — modelo de assets múltiples

**Files:**
- Create: `supabase/migrations/0018_meta_publisher.sql`
- Test: `tests/content/meta-publisher-migration.test.ts`

Referencia de estilo de test: `tests/content/copy-hashtags-migration.test.ts` (usa un cliente Supabase real contra la base de test, no mocks — sigue exactamente ese patrón de setup/teardown).

- [ ] **Step 1: Escribir los tests que deben fallar**

```typescript
// tests/content/meta-publisher-migration.test.ts (arranca el archivo aquí; más tareas le agregan tests)
import { describe, expect, it } from "vitest";
// import el mismo helper de cliente de test que usa copy-hashtags-migration.test.ts

describe("content_item_assets", () => {
  it("acepta hasta 10 posiciones por content item, rechaza la 11", async () => {
    // crear un content_item real (usar el helper existente de fixtures)
    // insertar 10 filas con position 0..9 → debe pasar
    // insertar una 11ª con position 10 → debe fallar por el check (0-9)
  });

  it("rechaza duplicar la misma position dos veces para el mismo content item", async () => {
    // insertar position=0 dos veces → viola unique(content_item_id, position)
  });

  it("rechaza un asset_id de otra organización aunque el content_item_id sea válido", async () => {
    // crear organization A con su content_item, organization B con su asset
    // intentar insertar content_item_assets con content_item de A y asset de B
    // debe fallar por la FK compuesta (asset_id, organization_id)
  });

  it("el backfill crea position=0 para content_items existentes con asset_id", async () => {
    // Este test solo tiene sentido corrido contra una base con datos previos a
    // la migración 0018 — si el entorno de test recrea el esquema desde cero
    // cada vez, documenta explícitamente que este caso se verifica manualmente
    // en staging antes de aplicar 0018 ahí (ver Task 1, Step 5).
  });
});
```

- [ ] **Step 2: Correr los tests, confirmar que fallan**

Run: `npm test -- --run tests/content/meta-publisher-migration.test.ts`
Expected: FAIL — la tabla `content_item_assets` no existe todavía.

- [ ] **Step 3: Escribir la migración**

```sql
-- supabase/migrations/0018_meta_publisher.sql
-- Real Meta publisher: multi-asset carousel model, OAuth connection storage,
-- PUBLISH job lifecycle, and the ADR-008 diagnosis gate.
-- Spec: docs/superpowers/specs/2026-09-13-meta-publisher-oauth-adapter-design.md (rev 4)

-- ============================================================
-- Task 1: content_item_assets
-- ============================================================

alter table public.content_items
  add constraint content_items_id_organization_unique unique (id, organization_id);
alter table public.assets
  add constraint assets_id_organization_unique unique (id, organization_id);

create table public.content_item_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  content_item_id uuid not null,
  asset_id uuid not null,
  position smallint not null check (position >= 0 and position <= 9),
  created_at timestamptz not null default now(),
  unique (content_item_id, position),
  unique (content_item_id, asset_id),
  foreign key (content_item_id, organization_id)
    references public.content_items (id, organization_id) on delete restrict,
  foreign key (asset_id, organization_id)
    references public.assets (id, organization_id) on delete restrict
);

create index content_item_assets_content_item_idx
  on public.content_item_assets (content_item_id, position);

alter table public.content_item_assets enable row level security;
create policy "Organization members read content item assets"
  on public.content_item_assets
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Backfill: content_items creados antes de esta migración con asset_id
-- asignado obtienen su fila de portada. No toca content_items sin asset_id
-- (el camino create_content_item_with_targets, que crea items sin imagen a
-- propósito — ver spec, sección "Modelo de assets múltiples").
insert into public.content_item_assets (organization_id, content_item_id, asset_id, position)
select organization_id, id, asset_id, 0
from public.content_items
where asset_id is not null
on conflict (content_item_id, position) do nothing;
```

- [ ] **Step 4: Correr los tests, confirmar que pasan**

Run: `npm test -- --run tests/content/meta-publisher-migration.test.ts`
Expected: PASS (excepto el test de backfill si el entorno recrea el esquema desde cero — documentarlo como skip con comentario explícito, no borrarlo).

- [ ] **Step 5: Verificar el backfill manualmente contra staging**

Antes de aplicar `0018` a cualquier proyecto Supabase con datos reales:
```bash
# contra una copia de staging, NUNCA producción sin respaldo:
npx supabase@2.117.0 db push --db-url <staging-url> --dry-run
```
Confirma que el `insert ... on conflict do nothing` del backfill no falla por
ningún content_item con `asset_id` apuntando a un asset ya borrado (no
debería poder pasar por las FKs existentes, pero verifícalo antes de aplicar
en caliente).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "feat: add content_item_assets for multi-image carousel support"
```

---

## Task 2: `organization_meta_connections` — almacenamiento de la conexión OAuth

**Files:**
- Modify: `supabase/migrations/0018_meta_publisher.sql`
- Modify: `tests/content/meta-publisher-migration.test.ts`

- [ ] **Step 1: Agregar los tests**

```typescript
describe("organization_meta_connections", () => {
  it("authenticated no puede hacer select directo, ni con RLS ni sin ella", async () => {
    // usar el cliente de test autenticado como un miembro real de la org
    // select * from organization_meta_connections where organization_id = ...
    // debe regresar error de permisos (no solo 0 filas)
  });

  it("get_meta_connection_status expone status/nombre/instagram pero nunca el token", async () => {
    // insertar una conexión vía el helper service_role
    // llamar la RPC como el miembro autenticado
    // el objeto resultado no debe tener ninguna clave que contenga el token
  });

  it("get_meta_connection_status rechaza a un no-miembro de la organización", async () => {
  });

  it("upsert_meta_connection y revoke_meta_connection solo son ejecutables por service_role", async () => {
    // intentar client.rpc(...) como authenticated → debe fallar por falta de grant
  });
});
```

- [ ] **Step 2: Correr, confirmar que fallan**

Run: `npm test -- --run tests/content/meta-publisher-migration.test.ts`
Expected: FAIL — las funciones/tabla no existen.

- [ ] **Step 3: Agregar a la migración**

```sql
-- ============================================================
-- Task 2: organization_meta_connections
-- ============================================================

create table public.organization_meta_connections (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  facebook_page_id text not null check (length(btrim(facebook_page_id)) > 0),
  facebook_page_name text not null check (length(btrim(facebook_page_name)) > 0),
  instagram_business_account_id text,
  page_access_token text not null check (length(btrim(page_access_token)) > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED', 'ERROR')),
  connected_by uuid not null references public.profiles(id) on delete restrict,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Sin ninguna policy para authenticated/anon: select directo queda denegado
-- por RLS incluso si alguien olvida el revoke de abajo. Las dos capas son
-- intencionales, no redundantes.
alter table public.organization_meta_connections enable row level security;
revoke all on public.organization_meta_connections from public, anon, authenticated;

create function public.get_meta_connection_status(
  p_organization_id uuid, p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  connection public.organization_meta_connections%rowtype;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_actor_id,
    array['owner', 'editor', 'reviewer']::public.organization_role[]
  );
  select * into connection
  from public.organization_meta_connections
  where organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('status', 'NOT_CONNECTED');
  end if;
  return jsonb_build_object(
    'status', connection.status,
    'facebookPageName', connection.facebook_page_name,
    'hasInstagram', connection.instagram_business_account_id is not null,
    'connectedAt', connection.connected_at
  );
end;
$$;

create function public.upsert_meta_connection(
  p_organization_id uuid, p_connected_by uuid,
  p_facebook_page_id text, p_facebook_page_name text,
  p_instagram_business_account_id text, p_page_access_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if nullif(btrim(p_facebook_page_id), '') is null
     or nullif(btrim(p_facebook_page_name), '') is null
     or nullif(btrim(p_page_access_token), '') is null then
    raise exception using errcode = '22023', message = 'META_CONNECTION_INVALID_INPUT';
  end if;
  insert into public.organization_meta_connections (
    organization_id, facebook_page_id, facebook_page_name,
    instagram_business_account_id, page_access_token, status,
    connected_by, connected_at, updated_at
  ) values (
    p_organization_id, btrim(p_facebook_page_id), btrim(p_facebook_page_name),
    nullif(btrim(p_instagram_business_account_id), ''), p_page_access_token, 'ACTIVE',
    p_connected_by, now(), now()
  )
  on conflict (organization_id) do update set
    facebook_page_id = excluded.facebook_page_id,
    facebook_page_name = excluded.facebook_page_name,
    instagram_business_account_id = excluded.instagram_business_account_id,
    page_access_token = excluded.page_access_token,
    status = 'ACTIVE',
    connected_by = excluded.connected_by,
    updated_at = now();
  return jsonb_build_object('connected', true);
end;
$$;

create function public.revoke_meta_connection(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.organization_meta_connections
  set status = 'REVOKED', page_access_token = '', updated_at = now()
  where organization_id = p_organization_id;
  return jsonb_build_object('revoked', found);
end;
$$;

create function public.mark_meta_connection_error(p_organization_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  update public.organization_meta_connections
  set status = 'ERROR', updated_at = now()
  where organization_id = p_organization_id
  returning jsonb_build_object('marked', true);
$$;

revoke all on function public.get_meta_connection_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.upsert_meta_connection(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.revoke_meta_connection(uuid) from public, anon, authenticated;
revoke all on function public.mark_meta_connection_error(uuid) from public, anon, authenticated;
grant execute on function public.get_meta_connection_status(uuid, uuid) to authenticated;
grant execute on function public.upsert_meta_connection(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.revoke_meta_connection(uuid) to service_role;
grant execute on function public.mark_meta_connection_error(uuid) to service_role;
```

Nota: `page_access_token = ''` en `revoke_meta_connection` en vez de `null`
porque la columna es `not null` — es una decisión deliberada de este paso,
no un olvido; una cadena vacía nunca puede ser un token real, así que sigue
siendo seguro.

- [ ] **Step 4: Correr, confirmar que pasan**

Run: `npm test -- --run tests/content/meta-publisher-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "feat: add organization_meta_connections storage and status RPC"
```

---

## Task 3: `organization_meta_oauth_sessions` — selección temporal de página

**Files:**
- Modify: `supabase/migrations/0018_meta_publisher.sql`
- Modify: `tests/content/meta-publisher-migration.test.ts`

- [ ] **Step 1: Tests**

```typescript
describe("organization_meta_oauth_sessions", () => {
  it("authenticated no puede leer la tabla directamente", async () => {});
  it("una fila con expires_at en el pasado no debe usarse (verificar en la app, no aquí — este test solo confirma que la columna existe y acepta timestamps pasados sin error)", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Migración**

```sql
-- ============================================================
-- Task 3: organization_meta_oauth_sessions
-- ============================================================

create table public.organization_meta_oauth_sessions (
  nonce uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  discovered_pages jsonb not null check (jsonb_typeof(discovered_pages) = 'array'),
  user_long_lived_token text not null check (length(btrim(user_long_lived_token)) > 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz not null
);
alter table public.organization_meta_oauth_sessions enable row level security;
revoke all on public.organization_meta_oauth_sessions from public, anon, authenticated;
```

No se agregan funciones de acceso todavía — la Tarea 18 (callback OAuth) y
la Tarea 19 (selección) las usan directamente vía `service_role` desde el
route handler (patrón ya usado en otras integraciones server-only de este
repo; no hace falta envolver cada operación en una RPC cuando el propio
route handler ya corre con la service role key y nunca expone el resultado
crudo al cliente).

- [ ] **Step 4: Correr, confirmar que pasa**
- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "feat: add temporary OAuth page-selection session table"
```

---

## Task 4: `automation_jobs` — `kind` extendido + `publication_target_id`

**Files:**
- Modify: `supabase/migrations/0018_meta_publisher.sql`
- Modify: `tests/content/meta-publisher-migration.test.ts`

- [ ] **Step 1: Tests**

```typescript
describe("automation_jobs PUBLISH kind", () => {
  it("acepta insertar un job kind='PUBLISH' con publication_target_id", async () => {});
  it("rechaza un job kind='PUBLISH' sin publication_target_id", async () => {});
  it("rechaza un job kind='COPY' que traiga publication_target_id", async () => {});
  it("sigue aceptando kind='COPY' sin publication_target_id (regresión)", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Migración**

```sql
-- ============================================================
-- Task 4: automation_jobs — kind PUBLISH + publication_target_id
-- ============================================================

-- 0010_automation_jobs.sql declaró `kind text not null check (kind = 'COPY')`
-- inline, sin nombre — Postgres la nombró automation_jobs_kind_check. Hay
-- que dropearla por ese nombre antes de agregar la nueva, o todo insert con
-- kind='PUBLISH' sigue fallando contra la restricción vieja.
alter table public.automation_jobs drop constraint if exists automation_jobs_kind_check;
alter table public.automation_jobs
  add constraint automation_jobs_kind_check check (kind in ('COPY', 'PUBLISH'));

alter table public.automation_jobs
  add column publication_target_id uuid references public.publication_targets(id);
alter table public.automation_jobs
  add constraint automation_jobs_publish_target_check
  check (
    (kind = 'COPY' and publication_target_id is null)
    or (kind = 'PUBLISH' and publication_target_id is not null)
  );
```

- [ ] **Step 4: Correr, confirmar que pasa**
- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "feat: extend automation_jobs for PUBLISH kind"
```

---

## Task 5: Ciclo de vida completo de jobs `PUBLISH`

**Files:**
- Modify: `supabase/migrations/0018_meta_publisher.sql`
- Modify: `tests/content/meta-publisher-migration.test.ts`

Seis funciones, calcadas 1:1 de sus contrapartes de `0010`/`0013`/`0014`
(lee esos archivos antes de escribir esta tarea — no reinventes la forma,
solo cambia qué datos carga el claim y qué efectos secundarios tiene el
fail terminal). La única que difiere de verdad en su cuerpo es
`claim_next_publish_automation_job` (carga distinta) y
`fail_publish_automation_job` (efecto de reconexión). Las otras cuatro son
`s/copy/publish/g` + `s/COPY/PUBLISH/g` sobre sus originales.

- [ ] **Step 1: Tests**

```typescript
describe("PUBLISH job lifecycle", () => {
  it("enqueue_publish_automation_job crea un job QUEUED con idempotency key derivada del target", async () => {});
  it("enqueue_publish_automation_job es idempotente: llamarlo dos veces con el mismo target no crea un segundo job", async () => {});
  it("claim_next_publish_automation_job regresa FAILED (no lanza excepción) si la organización no tiene conexión ACTIVE", async () => {});
  it("claim_next_publish_automation_job regresa FAILED si el target es INSTAGRAM y la organización no tiene instagram_business_account_id", async () => {});
  it("claim_next_publish_automation_job con conexión válida regresa CLAIMED con el copy final, los assets ordenados y el token de página", async () => {});
  it("renew_publish_automation_job extiende el lease de un job PROCESSING con el token correcto", async () => {});
  it("fail_publish_automation_job con p_retryable=false transiciona a FAILED, audita PUBLISH_JOB_FAILED y pone el target en ERROR", async () => {});
  it("fail_publish_automation_job con p_requires_reconnect=true además marca la conexión de la organización como ERROR", async () => {});
  it("fail_publish_automation_job con p_retryable=true y attempt_count < max_attempts transiciona a RETRY_WAIT sin tocar el target", async () => {});
  it("cancel_publish_automation_job cancela un job QUEUED", async () => {});
  it("recover_expired_publish_automation_jobs recupera un job PROCESSING con lease vencido", async () => {});
  it("summarize_publish_automation_jobs cuenta solo jobs kind='PUBLISH', no mezcla con COPY", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Migración**

```sql
-- ============================================================
-- Task 5: ciclo de vida de jobs PUBLISH
-- ============================================================

create function public.enqueue_publish_automation_job(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  -- Idempotency key determinística: un mismo target nunca produce dos jobs
  -- distintos vía este camino. gen_random_uuid() aquí sería un bug.
  derived_key uuid := public.uuid_generate_v5(
    'a3f1e9c0-6b3d-4f7e-8c1a-1d2e3f4a5b6c'::uuid,
    p_publication_target_id::text
  );
  existing_job public.automation_jobs%rowtype;
  created_job public.automation_jobs%rowtype;
begin
  -- Nota: NO llama assert_organization_actor. Es intencional (ver spec,
  -- "Correcciones a approve_publication_target", punto 2) — esta función es
  -- service_role-only y solo la invocan apply_publication_diagnosis y
  -- approve_publication_target, ambas ya autorizadas antes de llegar aquí.
  select * into existing_job
  from public.automation_jobs
  where organization_id = p_organization_id
    and kind = 'PUBLISH'
    and idempotency_key = derived_key
  for update;
  if found then
    return jsonb_build_object('created', false, 'jobId', existing_job.id);
  end if;

  insert into public.automation_jobs (
    organization_id, content_item_id, publication_target_id, kind, status, idempotency_key
  ) values (
    p_organization_id, p_content_item_id, p_publication_target_id, 'PUBLISH', 'QUEUED', derived_key
  ) returning * into created_job;

  return jsonb_build_object('created', true, 'jobId', created_job.id);
end;
$$;
```

**Si `uuid_generate_v5` no está disponible** (revisa si `uuid-ossp` está
habilitado en este proyecto Supabase antes de asumirlo — busca
`create extension` en `0001_content_os.sql`): usa en su lugar
`md5(p_publication_target_id::text)::uuid` como key determinística — menos
elegante pero no depende de una extensión adicional. Documenta cuál usaste
en el comentario de la función.

```sql
create function public.claim_next_publish_automation_job(
  p_provider text default null,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  job public.automation_jobs%rowtype;
  target public.publication_targets%rowtype;
  final_copy public.final_copy_versions%rowtype;
  connection public.organization_meta_connections%rowtype;
  assets_json jsonb;
  token uuid := gen_random_uuid();
begin
  select queued.* into job
  from public.automation_jobs as queued
  where queued.kind = 'PUBLISH'
    and (p_provider is null or queued.provider = p_provider)
    and (p_organization_id is null or queued.organization_id = p_organization_id)
    and queued.status in ('QUEUED', 'RETRY_WAIT')
    and queued.run_at <= now()
    and queued.next_attempt_at <= now()
    and not exists (
      select 1 from public.automation_jobs as active
      where active.publication_target_id = queued.publication_target_id
        and active.kind = 'PUBLISH'
        and active.status = 'PROCESSING'
        and active.lease_expires_at > now()
    )
  order by queued.next_attempt_at asc, queued.created_at asc
  limit 1
  for update skip locked;

  if not found then
    return jsonb_build_object('state', 'NOT_CLAIMABLE');
  end if;

  select * into target
  from public.publication_targets
  where id = job.publication_target_id and organization_id = job.organization_id;
  if not found or target.status <> 'APPROVED' then
    update public.automation_jobs set status = 'FAILED',
      sanitized_error = 'PUBLISH_JOB_TARGET_NOT_APPROVED', updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  select * into connection
  from public.organization_meta_connections
  where organization_id = job.organization_id and status = 'ACTIVE';
  if not found then
    update public.automation_jobs set status = 'FAILED',
      sanitized_error = 'PUBLISH_JOB_CONNECTION_NOT_FOUND', updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;
  if target.platform = 'INSTAGRAM' and connection.instagram_business_account_id is null then
    update public.automation_jobs set status = 'FAILED',
      sanitized_error = 'PUBLISH_JOB_INSTAGRAM_NOT_CONNECTED', updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  select * into final_copy
  from public.final_copy_versions
  where content_item_id = job.content_item_id and organization_id = job.organization_id
  order by version desc limit 1;
  if not found then
    update public.automation_jobs set status = 'FAILED',
      sanitized_error = 'PUBLISH_JOB_FINAL_COPY_NOT_FOUND', updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  select jsonb_agg(jsonb_build_object(
    'assetId', cia.asset_id, 'position', cia.position, 'storagePath', a.storage_path
  ) order by cia.position)
  into assets_json
  from public.content_item_assets as cia
  join public.assets as a on a.id = cia.asset_id and a.organization_id = cia.organization_id
  where cia.content_item_id = job.content_item_id and cia.organization_id = job.organization_id;
  if assets_json is null or jsonb_array_length(assets_json) = 0 then
    update public.automation_jobs set status = 'FAILED',
      sanitized_error = 'PUBLISH_JOB_ASSETS_NOT_FOUND', updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  update public.automation_jobs
  set status = 'PROCESSING', lease_token = token, lease_expires_at = now() + interval '10 minutes',
      claimed_at = coalesce(claimed_at, now()), attempt_count = attempt_count + 1, updated_at = now()
  where id = job.id;

  return jsonb_build_object(
    'state', 'CLAIMED',
    'job', jsonb_build_object(
      'id', job.id, 'organizationId', job.organization_id, 'kind', job.kind,
      'provider', job.provider, 'idempotencyKey', job.idempotency_key,
      'leaseToken', token, 'leaseExpiresAt', now() + interval '10 minutes',
      'contentItemId', job.content_item_id,
      'publicationTargetId', target.id, 'platform', target.platform,
      'assets', assets_json,
      'copy', jsonb_build_object(
        'headline', final_copy.headline, 'body', final_copy.body,
        'cta', final_copy.cta, 'hashtags', final_copy.hashtags
      ),
      'meta', jsonb_build_object(
        'facebookPageId', connection.facebook_page_id,
        'pageAccessToken', connection.page_access_token,
        'instagramBusinessAccountId', connection.instagram_business_account_id
      ),
      'attempts', job.attempt_count + 1, 'maxAttempts', job.max_attempts,
      'runAt', job.run_at, 'nextAttemptAt', job.next_attempt_at,
      'createdAt', job.created_at, 'updatedAt', now(), 'startedAt', coalesce(job.claimed_at, now())
    )
  );
end;
$$;

create function public.renew_publish_automation_job(
  p_job_id uuid, p_idempotency_key uuid, p_lease_token uuid, p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  renewed_expires_at timestamptz;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_LEASE_DURATION_INVALID';
  end if;
  renewed_expires_at := now() + make_interval(secs => p_lease_seconds);
  update public.automation_jobs
  set lease_expires_at = renewed_expires_at, updated_at = now()
  where id = p_job_id and kind = 'PUBLISH' and idempotency_key = p_idempotency_key
    and status = 'PROCESSING' and lease_token = p_lease_token and lease_expires_at > now();
  if not found then return jsonb_build_object('state', 'NOT_RENEWED'); end if;
  return jsonb_build_object('state', 'RENEWED', 'leaseExpiresAt', renewed_expires_at);
end;
$$;

create function public.complete_publish_automation_job(
  p_job_id uuid, p_idempotency_key uuid, p_lease_token uuid, p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  job public.automation_jobs%rowtype;
  item public.content_items%rowtype;
  target_count integer;
  published_count integer;
begin
  select * into job from public.automation_jobs
  where id = p_job_id and kind = 'PUBLISH' and idempotency_key = p_idempotency_key for update;
  if not found then raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_NOT_FOUND'; end if;
  if job.status = 'COMPLETED' then return jsonb_build_object('created', false); end if;
  if job.status <> 'PROCESSING' or job.lease_token <> p_lease_token or job.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_LEASE_INVALID';
  end if;
  if p_result->>'remotePostId' is null or p_result->>'remoteUrl' is null or p_result->>'publishedAt' is null then
    raise exception using errcode = '22023', message = 'PUBLISH_JOB_RESULT_INVALID';
  end if;

  -- Orden de locks: job (ya lockeado arriba) -> content_items -> publication_targets.
  -- Coincide a propósito con el orden de approve_publication_target /
  -- record_manual_publication_delivery para no crear un deadlock cuando una
  -- aprobación manual y esta finalización corren al mismo tiempo sobre el
  -- mismo content item.
  select * into item from public.content_items
  where id = job.content_item_id and organization_id = job.organization_id for update;

  update public.publication_targets
  set status = 'PUBLISHED'::public.publication_status,
      remote_post_id = p_result->>'remotePostId',
      remote_url = p_result->>'remoteUrl',
      published_at = (p_result->>'publishedAt')::timestamptz,
      last_error = null
  where id = job.publication_target_id and organization_id = job.organization_id;

  insert into public.audit_events (organization_id, owner_id, content_item_id, publication_target_id, event_type, metadata)
  values (
    job.organization_id, item.owner_id, job.content_item_id, job.publication_target_id,
    'TARGET_PUBLISHED', jsonb_build_object('source', 'automated', 'jobId', job.id)
  );

  select count(*), count(*) filter (where status = 'PUBLISHED')
  into target_count, published_count
  from public.publication_targets
  where content_item_id = job.content_item_id and organization_id = job.organization_id;
  if target_count > 0 and target_count = published_count then
    update public.content_items set state = 'PUBLISHED'::public.content_state
    where id = job.content_item_id and organization_id = job.organization_id;
  end if;

  update public.automation_jobs
  set status = 'COMPLETED', result_payload = p_result, completed_at = now(),
      lease_token = null, lease_expires_at = null, updated_at = now()
  where id = job.id;

  return jsonb_build_object('created', true);
end;
$$;

create function public.fail_publish_automation_job(
  p_job_id uuid, p_idempotency_key uuid, p_lease_token uuid,
  p_error text, p_retryable boolean default true, p_requires_reconnect boolean default false
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
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_ERROR_INVALID';
  end if;
  select * into job from public.automation_jobs
  where id = p_job_id and kind = 'PUBLISH' and idempotency_key = p_idempotency_key for update;
  if not found then raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_NOT_FOUND'; end if;
  if job.status <> 'PROCESSING' or job.lease_token <> p_lease_token or job.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_LEASE_INVALID';
  end if;

  if p_retryable is false then
    next_status := 'FAILED'; next_due := now();
  elsif job.attempt_count >= job.max_attempts then
    next_status := 'DEAD_LETTER'; next_due := now();
  else
    next_status := 'RETRY_WAIT';
    next_due := greatest(job.run_at, now() + make_interval(secs => least(3600, (2 ^ greatest(job.attempt_count - 1, 0))::integer)));
  end if;

  update public.automation_jobs
  set status = next_status, next_attempt_at = next_due,
      sanitized_error = left(btrim(p_error), 2000), lease_token = null, lease_expires_at = null, updated_at = now()
  where id = job.id;

  if next_status in ('FAILED', 'DEAD_LETTER') then
    select owner_id into item_owner_id from public.content_items
    where id = job.content_item_id and organization_id = job.organization_id for update;
    if found then
      update public.publication_targets
      set status = 'ERROR'::public.publication_status, last_error = left(btrim(p_error), 2000)
      where id = job.publication_target_id and organization_id = job.organization_id;
      insert into public.audit_events (organization_id, owner_id, content_item_id, publication_target_id, event_type, metadata)
      values (
        job.organization_id, item_owner_id, job.content_item_id, job.publication_target_id,
        'PUBLISH_JOB_FAILED', jsonb_build_object('jobId', job.id, 'status', next_status, 'error', left(btrim(p_error), 2000))
      );
    end if;
    if p_requires_reconnect then
      perform public.mark_meta_connection_error(job.organization_id);
    end if;
  end if;

  return jsonb_build_object('state', next_status, 'jobId', job.id, 'attempts', job.attempt_count, 'nextAttemptAt', next_due);
end;
$$;

create function public.cancel_publish_automation_job(
  p_job_id uuid, p_idempotency_key uuid, p_lease_token uuid default null, p_reason text default 'Cancelled by operator'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare job public.automation_jobs%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_CANCEL_REASON_INVALID';
  end if;
  select * into job from public.automation_jobs
  where id = p_job_id and kind = 'PUBLISH' and idempotency_key = p_idempotency_key for update;
  if not found then return jsonb_build_object('state', 'NOT_FOUND'); end if;
  if job.status in ('COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTER') then
    return jsonb_build_object('state', 'NOT_CANCELLABLE', 'status', job.status);
  end if;
  if job.status = 'PROCESSING' and (p_lease_token is null or job.lease_token <> p_lease_token) then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_LEASE_INVALID';
  end if;
  update public.automation_jobs
  set status = 'CANCELLED', cancelled_at = now(), sanitized_error = left(btrim(p_reason), 500),
      lease_token = null, lease_expires_at = null, updated_at = now()
  where id = job.id;
  return jsonb_build_object('state', 'CANCELLED', 'jobId', job.id);
end;
$$;

create function public.recover_expired_publish_automation_jobs(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare recovered_count integer := 0;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_RECOVERY_LIMIT_INVALID';
  end if;
  with expired as (
    select id, attempt_count, max_attempts from public.automation_jobs
    where kind = 'PUBLISH' and status = 'PROCESSING' and lease_expires_at <= now()
    order by lease_expires_at asc for update skip locked limit p_limit
  )
  update public.automation_jobs as job
  set status = case when expired.attempt_count >= expired.max_attempts then 'DEAD_LETTER'::public.automation_job_status else 'RETRY_WAIT'::public.automation_job_status end,
      next_attempt_at = now(), sanitized_error = coalesce(job.sanitized_error, 'Lease expired before completion'),
      lease_token = null, lease_expires_at = null, updated_at = now()
  from expired where job.id = expired.id;
  get diagnostics recovered_count = row_count;
  return jsonb_build_object('recovered', recovered_count);
end;
$$;

create function public.summarize_publish_automation_jobs()
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'queuedCount', count(*) filter (where status = 'QUEUED'),
    'retryCount', count(*) filter (where status = 'RETRY_WAIT'),
    'activeLeaseCount', count(*) filter (where status = 'PROCESSING' and lease_expires_at > now()),
    'failedCount', count(*) filter (where status = 'FAILED'),
    'deadLetterCount', count(*) filter (where status = 'DEAD_LETTER'),
    'queueLagMs', coalesce(greatest(0, extract(epoch from (now() - (min(next_attempt_at) filter (where status in ('QUEUED', 'RETRY_WAIT') and next_attempt_at <= now())))) * 1000), 0),
    'lastSuccessfulRun', max(completed_at) filter (where status = 'COMPLETED')
  )
  from public.automation_jobs where kind = 'PUBLISH';
$$;

revoke all on function public.enqueue_publish_automation_job(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_next_publish_automation_job(text, uuid) from public, anon, authenticated;
revoke all on function public.renew_publish_automation_job(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_publish_automation_job(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_publish_automation_job(uuid, uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.cancel_publish_automation_job(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.recover_expired_publish_automation_jobs(integer) from public, anon, authenticated;
revoke all on function public.summarize_publish_automation_jobs() from public, anon, authenticated;
grant execute on function public.enqueue_publish_automation_job(uuid, uuid, uuid) to service_role;
grant execute on function public.claim_next_publish_automation_job(text, uuid) to service_role;
grant execute on function public.renew_publish_automation_job(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.complete_publish_automation_job(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_publish_automation_job(uuid, uuid, uuid, text, boolean, boolean) to service_role;
grant execute on function public.cancel_publish_automation_job(uuid, uuid, uuid, text) to service_role;
grant execute on function public.recover_expired_publish_automation_jobs(integer) to service_role;
grant execute on function public.summarize_publish_automation_jobs() to service_role;
```

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "feat: add PUBLISH automation job lifecycle RPCs"
```

---

## Task 6: `apply_publication_diagnosis`

**Files:**
- Modify: `supabase/migrations/0018_meta_publisher.sql`
- Modify: `tests/content/meta-publisher-migration.test.ts`

- [ ] **Step 1: Tests**

```typescript
describe("apply_publication_diagnosis", () => {
  it("quality_level='promising' con findings solo info -> APPROVED + job PUBLISH encolado + TARGET_AUTO_APPROVED", async () => {});
  it("quality_level='promising' con un finding severity='warning' -> se queda PENDING_REVIEW, no encola job", async () => {});
  it("quality_level='needs_review' -> PENDING_REVIEW con TARGET_HELD_FOR_REVIEW y los findings en la metadata", async () => {});
  it("es idempotente por idempotency_key: llamarlo dos veces no duplica el evento ni el job", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Migración**

```sql
-- ============================================================
-- Task 6: apply_publication_diagnosis
-- ============================================================

create function public.apply_publication_diagnosis(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid,
  p_quality_level text, p_findings jsonb, p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target public.publication_targets%rowtype;
  item public.content_items%rowtype;
  is_safe boolean;
  prior_run public.automation_runs%rowtype;
begin
  if p_quality_level not in ('blocked', 'needs_review', 'promising') then
    raise exception using errcode = '22023', message = 'DIAGNOSIS_INVALID_QUALITY_LEVEL';
  end if;
  if jsonb_typeof(p_findings) <> 'array' then
    raise exception using errcode = '22023', message = 'DIAGNOSIS_INVALID_FINDINGS';
  end if;

  select * into prior_run from public.automation_runs
  where kind = 'PUBLISH_DIAGNOSIS' and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('created', false); end if;

  select * into target from public.publication_targets
  where id = p_publication_target_id and content_item_id = p_content_item_id
    and organization_id = p_organization_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'DIAGNOSIS_TARGET_NOT_FOUND'; end if;
  if target.status <> 'PENDING_REVIEW' then
    return jsonb_build_object('created', false, 'reason', 'TARGET_NOT_PENDING');
  end if;

  select * into item from public.content_items
  where id = p_content_item_id and organization_id = p_organization_id for update;

  -- La regla vive acá, no en TypeScript: "promising" y ningún finding con
  -- severity distinto de "info" es lo único que cuenta como seguro.
  is_safe := p_quality_level = 'promising' and not exists (
    select 1 from jsonb_array_elements(p_findings) as finding
    where finding->>'severity' in ('warning', 'error')
  );

  insert into public.automation_runs (organization_id, owner_id, content_item_id, publication_target_id, kind, idempotency_key, status, response_payload)
  values (p_organization_id, item.owner_id, p_content_item_id, p_publication_target_id, 'PUBLISH_DIAGNOSIS', p_idempotency_key, 'COMPLETED',
    jsonb_build_object('qualityLevel', p_quality_level, 'isSafe', is_safe))
  on conflict (kind, idempotency_key) do nothing;

  if is_safe then
    update public.publication_targets set status = 'APPROVED'::public.publication_status where id = target.id;
    insert into public.audit_events (organization_id, owner_id, content_item_id, publication_target_id, event_type, metadata)
    values (p_organization_id, item.owner_id, p_content_item_id, target.id, 'TARGET_AUTO_APPROVED', jsonb_build_object('qualityLevel', p_quality_level));
    perform public.enqueue_publish_automation_job(p_organization_id, p_content_item_id, target.id);
  else
    insert into public.audit_events (organization_id, owner_id, content_item_id, publication_target_id, event_type, metadata)
    values (p_organization_id, item.owner_id, p_content_item_id, target.id, 'TARGET_HELD_FOR_REVIEW', jsonb_build_object('qualityLevel', p_quality_level, 'findings', p_findings));
  end if;

  return jsonb_build_object('created', true, 'isSafe', is_safe);
end;
$$;

revoke all on function public.apply_publication_diagnosis(uuid, uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.apply_publication_diagnosis(uuid, uuid, uuid, text, jsonb, uuid) to service_role;
```

**Antes de escribir esta función**, verifica que `automation_runs.kind` no
tenga un `check` cerrado de valores permitidos que excluya
`'PUBLISH_DIAGNOSIS'` (revisa `0001_content_os.sql` y donde se declaró esa
columna) — si lo tiene, esta tarea necesita extender ese `check` también,
mismo patrón que el de `automation_jobs.kind` en la Tarea 4.

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "feat: add apply_publication_diagnosis RPC for ADR-008 auto-approve gate"
```

---

## Task 7: `approve_publication_target` (correcciones) + `retry_publish_target`

**Files:**
- Modify: `supabase/migrations/0018_meta_publisher.sql`
- Modify: `tests/content/meta-publisher-migration.test.ts`

- [ ] **Step 1: Tests**

```typescript
describe("approve_publication_target fixes", () => {
  it("aprobar manualmente un target PENDING_REVIEW encola un job PUBLISH", async () => {});
  it("llamarlo de nuevo sobre un target ya APPROVED no crea un segundo job (idempotencia por target)", async () => {});
  it("el content_item llega a state=APPROVED aunque otro target del mismo item ya esté PUBLISHED", async () => {
    // Regresión directa del bug encontrado en revisión: crear 2 targets,
    // llevar uno a PUBLISHED (vía complete_publish_automation_job),
    // aprobar el segundo manualmente, verificar que content_items.state pasa a APPROVED.
  });
});

describe("retry_publish_target", () => {
  it("un target en ERROR vuelve a APPROVED y encola un job nuevo con idempotency key distinta", async () => {});
  it("rechaza reintentar un target que no está en ERROR", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Migración**

```sql
-- ============================================================
-- Task 7: approve_publication_target (fix) + retry_publish_target
-- ============================================================

create or replace function public.approve_publication_target(
  p_organization_id uuid, p_owner_id uuid, p_content_item_id uuid, p_publication_target_id uuid
)
returns public.publication_targets
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  item public.content_items;
  target public.publication_targets;
  approved_target public.publication_targets;
  remaining_pending integer;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_owner_id, array['owner', 'reviewer']::public.organization_role[]
  );
  select * into item from public.content_items as content
  where content.id = p_content_item_id and content.organization_id = p_organization_id for update;
  if not found or item.state <> 'REVIEW' then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_REVIEWABLE';
  end if;
  select * into target from public.publication_targets as publication_target
  where publication_target.id = p_publication_target_id
    and publication_target.content_item_id = p_content_item_id
    and publication_target.organization_id = p_organization_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'TARGET_NOT_FOUND'; end if;
  if target.status not in ('PENDING_REVIEW', 'APPROVED') then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_REVIEWABLE';
  end if;

  if target.status = 'APPROVED' then
    -- Corrección: antes retornaba aquí sin encolar nada. Ahora se apoya en
    -- la idempotencia de enqueue_publish_automation_job — si ya hay un job
    -- para este target, esta llamada no crea uno nuevo.
    perform public.enqueue_publish_automation_job(p_organization_id, p_content_item_id, target.id);
    return target;
  end if;

  update public.publication_targets set status = 'APPROVED'::public.publication_status
  where id = target.id and organization_id = p_organization_id returning * into approved_target;
  insert into public.audit_events (organization_id, owner_id, actor_id, content_item_id, publication_target_id, event_type, metadata)
  values (p_organization_id, item.owner_id, p_owner_id, p_content_item_id, target.id, 'TARGET_APPROVED', jsonb_build_object('platform', target.platform));

  perform public.enqueue_publish_automation_job(p_organization_id, p_content_item_id, target.id);

  -- Corrección: status <> 'APPROVED' no contaba un target ya PUBLISHED como
  -- también-aprobado, dejando el content item atorado en REVIEW.
  select count(*) into remaining_pending from public.publication_targets as publication_target
  where publication_target.content_item_id = p_content_item_id
    and publication_target.organization_id = p_organization_id
    and publication_target.status not in ('APPROVED', 'PUBLISHED');
  if remaining_pending = 0 then
    update public.content_items set state = 'APPROVED'::public.content_state
    where id = p_content_item_id and organization_id = p_organization_id and state = 'REVIEW';
  end if;

  return approved_target;
end;
$$;

create function public.retry_publish_target(
  p_organization_id uuid, p_actor_id uuid, p_publication_target_id uuid
)
returns public.publication_targets
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target public.publication_targets%rowtype;
  updated_target public.publication_targets%rowtype;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_actor_id, array['owner', 'editor']::public.organization_role[]
  );
  select * into target from public.publication_targets
  where id = p_publication_target_id and organization_id = p_organization_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'RETRY_TARGET_NOT_FOUND'; end if;
  if target.status <> 'ERROR' then
    raise exception using errcode = 'P0001', message = 'RETRY_TARGET_NOT_IN_ERROR';
  end if;

  update public.publication_targets set status = 'APPROVED'::public.publication_status, last_error = null
  where id = target.id returning * into updated_target;

  -- A diferencia del encolado automático (idempotency key determinística
  -- por target), un reintento explícito de un humano SÍ debe poder crear un
  -- job nuevo cada vez -- el anterior ya terminó en FAILED/DEAD_LETTER.
  insert into public.automation_jobs (organization_id, content_item_id, publication_target_id, kind, status, idempotency_key)
  values (p_organization_id, target.content_item_id, target.id, 'PUBLISH', 'QUEUED', gen_random_uuid());

  return updated_target;
end;
$$;

revoke all on function public.approve_publication_target(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.retry_publish_target(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_publication_target(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.retry_publish_target(uuid, uuid, uuid) to service_role;
```

- [ ] **Step 4: Correr TODOS los tests de la migración, confirmar que pasan**

Run: `npm test -- --run tests/content/meta-publisher-migration.test.ts`
Expected: PASS (todos los tests de las Tareas 1-7)

- [ ] **Step 5: Aplicar la migración completa contra Supabase de staging**

```bash
npx supabase@2.117.0 db push --db-url <staging-url>
npx supabase@2.117.0 migration list --db-url <staging-url>
```
Confirma coincidencia exacta `0001`-`0018`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0018_meta_publisher.sql tests/content/meta-publisher-migration.test.ts
git commit -m "fix: correct approve_publication_target aggregate count and add retry_publish_target"
```

Con esto termina la parte de base de datos. Las tareas siguientes son
TypeScript y no vuelven a tocar `0018`.

---

## Task 8: Intake multi-asset

**Files:**
- Modify: `app/api/content/route.ts`
- Modify: `lib/content/repository.ts` (firma de `createContentItemWithAsset` o el método equivalente — revisa el nombre exacto antes de tocarlo)
- Modify: `lib/supabase/repository.ts`
- Test: `tests/api/content-create.test.ts` (ya existe — extiéndelo)

- [ ] **Step 1: Escribir los tests que fallan**

Agrega a `tests/api/content-create.test.ts`:
```typescript
it("acepta 3 archivos en el campo assets y crea 3 filas en content_item_assets ordenadas", async () => {
  // formData.append("assets", file0); formData.append("assets", file1); formData.append("assets", file2);
  // POST /api/content
  // verificar que el content creado tiene 3 assets en orden 0,1,2 (vía el repositorio, no SQL directo)
});

it("si el archivo del medio falla validación, no sube ninguno de los otros", async () => {
  // 3 archivos, el segundo con dimensiones inválidas
  // esperar 400/422, y verificar (vía el repositorio de test) que no se creó ningún asset
});

it("rechaza más de 10 archivos", async () => {});
it("rechaza 0 archivos", async () => {});
```

- [ ] **Step 2: Correr, confirmar que fallan**

Run: `npm test -- --run tests/api/content-create.test.ts`

- [ ] **Step 3: Implementar**

En `app/api/content/route.ts`: cambia `formData.get("asset")` por
`formData.getAll("assets")`. Valida `1 <= assets.length <= 10`. Valida
**todos** con `validateAsset()` antes de llamar a cualquier método que
suba a Storage — si cualquiera lanza `AssetValidationError`, responde 400
sin haber tocado Storage. Sube el resultado en orden a la operación que
crea el `content_item` + assets (revisa si `createContentItemWithAsset`
necesita convertirse en `createContentItemWithAssets` aceptando un array,
o si conviene un método nuevo — sigue el patrón existente del repositorio,
no inventes uno paralelo).

Actualiza también:
```typescript
const MAX_MULTIPART_BYTES = MAX_ASSET_BYTES * 10 + 640_000;
```

En `lib/supabase/repository.ts`: la inserción de `content_item_assets`
ocurre en la misma transacción/llamada RPC que crea el `content_item` — si
`create_content_item_with_asset_in_organization` (RPC existente) no soporta
múltiples assets, esta tarea necesita una nueva RPC
`create_content_item_with_assets_in_organization` en una migración
**posterior** (no reabras `0018`; si esto surge, es una migración `0019`
separada — avísale al humano antes de crearla, no está en el spec original
como una migración aparte y merece confirmarse).

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Actualizar el formulario de intake** (componente cliente que arma el `FormData`) para mandar `assets` (múltiple) en vez de `asset`.
- [ ] **Step 6: Commit**

```bash
git add app/api/content/route.ts lib/supabase/repository.ts lib/content/repository.ts tests/api/content-create.test.ts
git commit -m "feat: accept 1-10 assets per content item for carousel support"
```

---

## Task 9: `lib/integrations/meta-publisher.ts` — split de preflight

**Files:**
- Modify: `lib/integrations/meta-publisher.ts`
- Modify: `tests/content/meta-publisher.test.ts` (o el path real del test existente — búscalo primero)
- Modify: `.env.example`

- [ ] **Step 1: Tests**

```typescript
describe("preflightApp", () => {
  it("READY cuando META_APP_ID y META_APP_SECRET están presentes", async () => {});
  it("NOT_CONFIGURED listando solo las variables de app faltantes (no META_PAGE_ID/META_PAGE_ACCESS_TOKEN, esas ya no existen)", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla** (el test viejo que esperaba las 4 variables debe actualizarse o eliminarse en este mismo paso — no lo dejes esperando un comportamiento que ya no existe)

- [ ] **Step 3: Implementar**

```typescript
const REQUIRED_APP_VARIABLES = ["META_APP_ID", "META_APP_SECRET"] as const;

export type MetaAppPreflight =
  | { status: "READY" }
  | { status: "NOT_CONFIGURED"; missing: Array<(typeof REQUIRED_APP_VARIABLES)[number]> };

export function createMetaPublisher(environment: MetaEnvironment = process.env) {
  return {
    async preflightApp(): Promise<MetaAppPreflight> {
      const missing = REQUIRED_APP_VARIABLES.filter((key) => !environment[key]?.trim());
      return missing.length > 0 ? { status: "NOT_CONFIGURED", missing } : { status: "READY" };
    },
  };
}
```

`getConnectionStatus(organizationId)` se agrega en la Tarea 17 (junto con
las rutas OAuth que la necesitan) — no la escribas aquí todavía si eso te
hace tocar código de rutas que no existen aún.

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Actualizar `.env.example`** — quitar `META_PAGE_ID`/`META_PAGE_ACCESS_TOKEN`, dejar solo `META_APP_ID`/`META_APP_SECRET`.
- [ ] **Step 6: Commit**

```bash
git add lib/integrations/meta-publisher.ts tests/content/meta-publisher.test.ts .env.example
git commit -m "refactor: split Meta preflight into app-level and per-org connection checks"
```

---

## Task 10: `MetaPublishError`

**Files:**
- Create: `lib/integrations/meta-publish-error.ts`
- Test: `tests/integrations/meta-publish-error.test.ts`

Mismo patrón que `worker/providers/copy-guardrail-error.ts` — léelo primero.

- [ ] **Step 1-4: TDD estándar**

```typescript
export class MetaPublishError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly requiresReconnect: boolean = false,
  ) {
    super(message);
    this.name = "MetaPublishError";
  }
}
```

Tests: constructor asigna los tres campos; `instanceof Error` sigue
funcionando; default de `requiresReconnect` es `false`.

- [ ] **Step 5: Commit**

```bash
git add lib/integrations/meta-publish-error.ts tests/integrations/meta-publish-error.test.ts
git commit -m "feat: add MetaPublishError with retryable/requiresReconnect classification"
```

---

## Task 11: Adaptador Facebook

**Files:**
- Modify: `lib/integrations/meta-publisher.ts`
- Modify: `tests/content/meta-publisher.test.ts`

- [ ] **Step 1: Tests** (fetch mockeado — sigue el patrón de inyección de dependencias de `worker/providers/copy-processor.ts` para el `fetchFn`)

```typescript
describe("publishToFacebook", () => {
  it("imagen única: POST a /{pageId}/photos con url/caption/published=true, luego GET permalink_url", async () => {});
  it("carrusel: sube cada foto published=false, junta media_fbid, POST /{pageId}/feed con attached_media en orden de position", async () => {});
  it("rate limit (5xx o código de error transitorio de Meta) -> MetaPublishError retryable=true", async () => {});
  it("token inválido -> MetaPublishError retryable=false requiresReconnect=true", async () => {});
  it("contenido rechazado por política -> MetaPublishError retryable=false requiresReconnect=false", async () => {});
  it("timeout de red sin respuesta HTTP -> MetaPublishError retryable=false requiresReconnect=false (caso ambiguo)", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Implementar**

```typescript
const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type FacebookPublishInput = {
  pageId: string;
  pageAccessToken: string;
  caption: string;
  assets: Array<{ signedUrl: string; position: number }>; // ya ordenados
};

export type MetaPublishResult = { remotePostId: string; remoteUrl: string };

async function publishToFacebook(
  input: FacebookPublishInput,
  fetchFn: typeof fetch = fetch,
): Promise<MetaPublishResult> {
  const sorted = [...input.assets].sort((a, b) => a.position - b.position);
  let postId: string;

  if (sorted.length === 1) {
    const response = await callGraphApi(fetchFn, `${input.pageId}/photos`, {
      url: sorted[0]!.signedUrl,
      caption: input.caption,
      published: "true",
      access_token: input.pageAccessToken,
    });
    postId = (response.post_id as string) ?? (response.id as string);
  } else {
    const mediaFbids: string[] = [];
    for (const asset of sorted) {
      const photo = await callGraphApi(fetchFn, `${input.pageId}/photos`, {
        url: asset.signedUrl,
        published: "false",
        access_token: input.pageAccessToken,
      });
      mediaFbids.push(photo.id as string);
    }
    const post = await callGraphApi(fetchFn, `${input.pageId}/feed`, {
      message: input.caption,
      attached_media: JSON.stringify(mediaFbids.map((id) => ({ media_fbid: id }))),
      access_token: input.pageAccessToken,
    });
    postId = post.id as string;
  }

  const permalink = await callGraphApi(
    fetchFn, `${postId}?fields=permalink_url&access_token=${encodeURIComponent(input.pageAccessToken)}`,
    null, "GET",
  );
  return { remotePostId: postId, remoteUrl: permalink.permalink_url as string };
}
```

**Implementa `callGraphApi`** como un helper compartido (lo va a reusar
Instagram en la Tarea 12): hace el `fetch` con `AbortController`/timeout,
parsea la respuesta JSON, y si `response.error` existe, clasifica el error
según la tabla de la Tarea 13 (`MetaPublishError`). Un `fetch` que lanza
(network error/timeout) sin respuesta HTTP se traduce a
`MetaPublishError(..., retryable: false, requiresReconnect: false)` — el
caso ambiguo del spec.

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add lib/integrations/meta-publisher.ts tests/content/meta-publisher.test.ts
git commit -m "feat: implement real Facebook publish adapter (single image + carousel)"
```

---

## Task 12: Adaptador Instagram

**Files:**
- Modify: `lib/integrations/meta-publisher.ts`
- Modify: `tests/content/meta-publisher.test.ts`

- [ ] **Step 1: Tests**

```typescript
describe("publishToInstagram", () => {
  it("imagen única: crea contenedor, hace poll hasta listo, publica, obtiene permalink", async () => {});
  it("carrusel: crea contenedores hijo is_carousel_item=true en orden, contenedor padre CAROUSEL, poll, publish", async () => {});
  it("poll que nunca llega a listo en 60s -> MetaPublishError retryable=true (timeout de contenedor, no de red)", async () => {});
  it("mismos casos de error de la tabla de clasificación que Facebook", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Implementar**

```typescript
async function pollContainerUntilReady(
  fetchFn: typeof fetch, containerId: string, accessToken: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await callGraphApi(
      fetchFn, `${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      null, "GET",
    );
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") {
      throw new MetaPublishError("Instagram no pudo procesar el contenedor de medios.", false, false);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new MetaPublishError("Timeout esperando que Instagram procese el contenedor.", true, false);
}

async function publishToInstagram(
  input: FacebookPublishInput & { igUserId: string },
  fetchFn: typeof fetch = fetch,
): Promise<MetaPublishResult> {
  const sorted = [...input.assets].sort((a, b) => a.position - b.position);
  let creationId: string;

  if (sorted.length === 1) {
    const container = await callGraphApi(fetchFn, `${input.igUserId}/media`, {
      image_url: sorted[0]!.signedUrl, caption: input.caption, access_token: input.pageAccessToken,
    });
    creationId = container.id as string;
  } else {
    const childIds: string[] = [];
    for (const asset of sorted) {
      const child = await callGraphApi(fetchFn, `${input.igUserId}/media`, {
        image_url: asset.signedUrl, is_carousel_item: "true", access_token: input.pageAccessToken,
      });
      childIds.push(child.id as string);
    }
    const parent = await callGraphApi(fetchFn, `${input.igUserId}/media`, {
      media_type: "CAROUSEL", children: childIds.join(","), caption: input.caption, access_token: input.pageAccessToken,
    });
    creationId = parent.id as string;
  }

  await pollContainerUntilReady(fetchFn, creationId, input.pageAccessToken);
  const published = await callGraphApi(fetchFn, `${input.igUserId}/media_publish`, {
    creation_id: creationId, access_token: input.pageAccessToken,
  });
  const mediaId = published.id as string;
  const permalink = await callGraphApi(
    fetchFn, `${mediaId}?fields=permalink&access_token=${encodeURIComponent(input.pageAccessToken)}`,
    null, "GET",
  );
  return { remotePostId: mediaId, remoteUrl: permalink.permalink as string };
}
```

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add lib/integrations/meta-publisher.ts tests/content/meta-publisher.test.ts
git commit -m "feat: implement real Instagram publish adapter (single image + carousel)"
```

---

## Task 13: Puerta de diagnóstico en el API route de copy final

**Files:**
- Modify: la ruta que llama `submit_final_copy_for_review` hoy (búscala — es la que expone `POST` para someter el copy final; revisa `lib/supabase/repository.ts:submitFinalCopyForReview` para encontrar su caller HTTP)
- Test: el test existente de esa ruta, extendido

- [ ] **Step 1: Tests**

```typescript
it("tras someter copy final, corre diagnosePublication por cada target y llama apply_publication_diagnosis", async () => {});
it("la señal del diagnóstico se construye del copy final (headline+body+cta+hashtags), no de la descripción original del intake", async () => {});
it("si validateFinalCopy falla, no llega a llamar submit_final_copy_for_review ni el diagnóstico (regresión del guardrail existente)", async () => {});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Implementar**

Después de que `submitFinalCopyForReview` resuelve con éxito, para cada
`publication_target` del content item (`FACEBOOK`, `INSTAGRAM`):
```typescript
const signal = [finalCopy.headline, finalCopy.body, finalCopy.cta, ...finalCopy.hashtags].join(" ");
const diagnosis = diagnosePublication({ profile: organizationProfile, signal, channel: target.platform });
await repository.applyPublicationDiagnosis({
  contentItemId, publicationTargetId: target.id,
  qualityLevel: diagnosis.qualityLevel, findings: diagnosis.findings,
  idempotencyKey: createId(),
});
```
Agrega `applyPublicationDiagnosis` al `ContentRepository` (interfaz +
implementación Supabase, llamando la RPC de la Tarea 6) y a su equivalente
demo (`lib/demo/repository.ts` — revisa cómo el demo simula
`submitFinalCopyForReview` hoy y sigue el mismo estilo, sin llamar Supabase
de verdad).

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add <archivos tocados>
git commit -m "feat: wire ADR-008 diagnosis gate after final copy submission"
```

---

## Task 14: `SupabasePublishWorkerStore`

**Files:**
- Create: `lib/automation/supabase-publish-worker-store.ts`
- Test: `tests/worker/supabase-publish-worker-store.test.ts`

**Mirror exacto** de `lib/automation/supabase-copy-worker-store.ts` — léelo
completo antes de empezar. Sustituye cada RPC `*_copy_automation_job` por
su equivalente `*_publish_automation_job` de la Tarea 5. Diferencias reales
(no mecánicas):
- El payload del job claimed incluye `assets` (array ordenado, cada uno
  necesita su propia signed URL — no una sola, como en COPY), `copy`
  (headline/body/cta/hashtags), `platform`, y `meta`
  (`facebookPageId`/`pageAccessToken`/`instagramBusinessAccountId`) en vez
  de `storagePath`/`brief`.
- `claimNext` genera una signed URL **por cada asset** (loop sobre el
  array), no una sola.
- El tipo de payload es `SupabasePublishJobPayload`, no
  `SupabaseCopyJobPayload`.

- [ ] **Step 1-4: TDD** — mismos casos que
  `tests/worker/supabase-copy-worker-store.test.ts` (si existe con ese
  nombre — búscalo; si no, créalo con el mismo espíritu: claim exitoso,
  claim NOT_CLAIMABLE, renew, complete, fail, cancel, recoverExpired,
  health), adaptados a la forma del payload de PUBLISH.

- [ ] **Step 5: Commit**

```bash
git add lib/automation/supabase-publish-worker-store.ts tests/worker/supabase-publish-worker-store.test.ts
git commit -m "feat: add Supabase-backed durable store for PUBLISH jobs"
```

---

## Task 15: `worker/providers/meta-publish-processor.ts`

**Files:**
- Create: `worker/providers/meta-publish-processor.ts`
- Test: `tests/worker/meta-publish-processor.test.ts`

Mismo patrón de inyección de dependencias que
`worker/providers/copy-processor.ts` — léelo primero.

- [ ] **Step 1: Tests**

```typescript
describe("createMetaPublishProcessor", () => {
  it("job de 1 asset con platform=FACEBOOK llama publishToFacebook y regresa el resultado", async () => {});
  it("job de 1 asset con platform=INSTAGRAM llama publishToInstagram", async () => {});
  it("job de 3 assets llama la variante carrusel correspondiente", async () => {});
  it("MetaPublishError con requiresReconnect=true llama mark_meta_connection_error ANTES de relanzar el error", async () => {});
  it("MetaPublishError con requiresReconnect=false no llama mark_meta_connection_error", async () => {});
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Implementar**

```typescript
export function createMetaPublishProcessor(dependencies: {
  fetchFn?: typeof fetch;
  markConnectionError: (organizationId: string) => Promise<void>;
}) {
  return async function processPublishJob(job: DurableJob<SupabasePublishJobPayload, MetaPublishResult>) {
    try {
      const publishFn = job.payload.platform === "INSTAGRAM" ? publishToInstagram : publishToFacebook;
      return await publishFn(
        {
          pageId: job.payload.meta.facebookPageId,
          igUserId: job.payload.meta.instagramBusinessAccountId ?? "",
          pageAccessToken: job.payload.meta.pageAccessToken,
          caption: buildCaption(job.payload.copy),
          assets: job.payload.assets,
        },
        dependencies.fetchFn,
      );
    } catch (error) {
      if (error instanceof MetaPublishError && error.requiresReconnect) {
        await dependencies.markConnectionError(job.organizationId);
      }
      throw error;
    }
  };
}
```

`buildCaption` es un helper puro nuevo: `headline + "\n\n" + body + "\n\n" +
cta + "\n\n" + hashtags.join(" ")` — escríbelo con su propio test breve.

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add worker/providers/meta-publish-processor.ts tests/worker/meta-publish-processor.test.ts
git commit -m "feat: add meta publish processor with reconnect-on-error handling"
```

---

## Task 16: `worker/entrypoint.ts` — despacho dual COPY/PUBLISH

**Files:**
- Modify: `worker/entrypoint.ts`
- Modify: el test existente de `worker/entrypoint.ts`

- [ ] **Step 1: Tests**

```typescript
it("isPublishJobRetryable regresa false para MetaPublishError con retryable=false", async () => {});
it("isPublishJobRetryable regresa true para un error genérico (no MetaPublishError)", async () => {});
it("main() construye dos DurableJobRunner (uno COPY, uno PUBLISH) y los corre con Promise.all", async () => {
  // mockear ambos runners/stores, verificar que runUntilStopped se llama en ambos
});
```

- [ ] **Step 2: Correr, confirmar que falla**

- [ ] **Step 3: Implementar**

```typescript
export function isPublishJobRetryable(error: unknown): boolean {
  return !(error instanceof MetaPublishError) || error.retryable;
}
```

Extiende `main()` para construir `SupabasePublishWorkerStore` +
`createMetaPublishProcessor` + un segundo `DurableJobRunner`, y correr
ambos:
```typescript
await Promise.all([
  copyRunner.runUntilStopped(),
  publishRunner.runUntilStopped(),
]);
```
El `shutdown` (`SIGTERM`/`SIGINT`) debe detener ambos (`copyRunner.stop()`
y `publishRunner.stop()`).

- [ ] **Step 4: Correr, confirmar que pasan**
- [ ] **Step 5: Commit**

```bash
git add worker/entrypoint.ts tests/worker/entrypoint.test.ts
git commit -m "feat: dispatch COPY and PUBLISH jobs from a single worker process"
```

---

## Task 17: OAuth — `connect` (inicio + cookie)

**Files:**
- Create: `app/api/integrations/meta/connect/route.ts`
- Test: `tests/api/meta-oauth-connect.test.ts`

- [ ] **Step 1: Tests**

```typescript
it("genera un nonce, lo pone en una cookie httpOnly de 10 minutos, y redirige a facebook.com/.../dialog/oauth con el state firmado", async () => {});
it("rechaza si el actor no tiene rol owner/editor en la organización", async () => {});
it("el state incluye organization_id, el mismo nonce de la cookie, y una expiración de 10 min", async () => {});
```

- [ ] **Step 2-4: TDD estándar**

Implementa el `state` como JWT firmado o HMAC simple (usa lo que ya use
este repo para firmar payloads server-side — revisa si hay un helper
existente antes de traer una librería nueva). Cookie: `httpOnly`,
`secure` (en producción), `sameSite: "lax"`, `maxAge: 600`.

- [ ] **Step 5: Commit**

```bash
git add app/api/integrations/meta/connect/route.ts tests/api/meta-oauth-connect.test.ts
git commit -m "feat: add Meta OAuth connect route with CSRF-bound nonce cookie"
```

---

## Task 18: OAuth — `callback`

**Files:**
- Create: `app/api/integrations/meta/callback/route.ts`
- Test: `tests/api/meta-oauth-callback.test.ts`

- [ ] **Step 1: Tests**

```typescript
it("rechaza si el nonce del state no coincide con el de la cookie", async () => {});
it("rechaza si no hay sesión autenticada con rol owner/editor en la organización del state", async () => {});
it("con una sola página: intercambia code, extiende el token, llama /me/accounts, y persiste la conexión directo", async () => {});
it("con varias páginas: crea una fila en organization_meta_oauth_sessions y redirige al selector, sin persistir ninguna conexión todavía", async () => {});
it("nunca incluye ningún token en la respuesta al navegador", async () => {});
```

- [ ] **Step 2-4: TDD estándar**

Llama Graph API real vía `fetch` inyectado (mismo patrón de
dependency-injection de siempre). Para cada página descubierta, resuelve
`instagram_business_account` con una llamada adicional
`GET /{page-id}?fields=instagram_business_account`.

- [ ] **Step 5: Commit**

```bash
git add app/api/integrations/meta/callback/route.ts tests/api/meta-oauth-callback.test.ts
git commit -m "feat: add Meta OAuth callback with session-bound nonce verification"
```

---

## Task 19: OAuth — `connect/select`

**Files:**
- Create: `app/api/integrations/meta/connect/select/route.ts`
- Test: `tests/api/meta-oauth-select.test.ts`

- [ ] **Step 1: Tests**

```typescript
it("con nonce y pageId válidos, vuelve a llamar /me/accounts con el token guardado, extrae el access_token de la página elegida, y persiste la conexión", async () => {});
it("rechaza si la sesión temporal expiró", async () => {});
it("rechaza si el pageId no está en discovered_pages de esa sesión", async () => {});
it("borra la fila de organization_meta_oauth_sessions tras persistir", async () => {});
```

- [ ] **Step 2-5: TDD estándar + commit**

```bash
git add app/api/integrations/meta/connect/select/route.ts tests/api/meta-oauth-select.test.ts
git commit -m "feat: add Meta OAuth multi-page selection endpoint"
```

---

## Task 20: OAuth — desconexión + estado de conexión en Settings

**Files:**
- Create: `app/api/integrations/meta/disconnect/route.ts`
- Modify: `app/(app)/settings/organizations/page.tsx`
- Test: correspondiente para la ruta + un test de componente para la UI

- [ ] **Step 1-4: TDD estándar**

La ruta de disconnect llama `revoke_meta_connection`. La UI de Settings
muestra el estado vía `get_meta_connection_status` (Tarea 2): "No
conectado" / "Conectado como {pageName}" con un indicador separado para
Instagram (`hasInstagram`) / "Reconectar" cuando `status = 'ERROR'`.
Botones "Conectar Facebook" (link a `/api/integrations/meta/connect?organizationId=...`)
y "Desconectar".

- [ ] **Step 5: Commit**

```bash
git add app/api/integrations/meta/disconnect/route.ts "app/(app)/settings/organizations/page.tsx" <tests>
git commit -m "feat: add Meta connection status and disconnect UI in Settings"
```

---

## Task 21: Verificación final

- [ ] **Step 1:** `npm test -- --run` (suite completa) — todo verde.
- [ ] **Step 2:** `npx tsc --noEmit` — sin errores.
- [ ] **Step 3:** `npm run lint` (o el comando equivalente del repo) — sin errores.
- [ ] **Step 4:** `npm run build` — build exitoso.
- [ ] **Step 5:** Revisar manualmente que ningún archivo tocado dejó un `console.log` de depuración o un token/secreto hardcodeado (`git diff feat/personal-pilot-hardening...HEAD -- '*.ts' '*.tsx'`).
- [ ] **Step 6:** Commit final si quedó algo suelto, luego avisar que el plan terminó y está listo para la revisión de código holística antes del PR.

---

## Nota para quien despache esto a Codex CLI

Cada tarea (1-21) es una unidad de trabajo independiente para un `codex
exec` — no dispaches dos tareas en paralelo si una depende del archivo que
la otra está tocando (las Tareas 1-7 son secuenciales sobre el mismo
archivo de migración; 8-13 pueden dispacharse con más libertad una vez que
1-7 estén mergeadas; 14-16 dependen de 11-12; 17-20 dependen de 9). Incluye
en cada prompt de Codex la regla de seguridad de git (no `reset --hard`,
no `checkout --`, no `clean`) y pide que verifique con `tasklist`/`ps` que
no quede un proceso de Codex anterior corriendo antes de asumir que uno
"se colgó" — ya tuvimos un incidente real de esto en la feature anterior.
