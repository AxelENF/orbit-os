-- Orbit OS MVP consolidation
-- Applies the final schema delta from the verified remote baseline 0001-0017.
-- Source fragments are archived after this file is generated; do not apply them separately.

-- BEGIN 0018_meta_publisher.sql
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

-- ============================================================
-- Task 2: organization_meta_connections
-- ============================================================

create table public.organization_meta_connections (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  facebook_page_id text not null check (length(btrim(facebook_page_id)) > 0),
  facebook_page_name text not null check (length(btrim(facebook_page_name)) > 0),
  instagram_business_account_id text,
  -- El token nunca vive en una columna public. Solo se guarda una referencia
  -- opaca al secreto cifrado por Supabase Vault.
  page_access_token_vault_secret_id uuid,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED', 'ERROR')),
  constraint organization_meta_connections_active_token_reference
    check (status <> 'ACTIVE' or page_access_token_vault_secret_id is not null),
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

-- Invalida el valor cifrado y deja de referenciarlo. Vault no expone una
-- operación de borrado documentada, por lo que sobreescribirlo evita dejar un
-- token Meta recuperable incluso si queda una fila de Vault para auditoría.
create function public.invalidate_meta_vault_secret(
  p_secret_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_secret_id is null then
    return;
  end if;

  perform vault.update_secret(
    p_secret_id,
    'REVOKED:' || gen_random_uuid()::text,
    null::text,
    left(coalesce(nullif(btrim(p_reason), ''), 'Meta credential invalidated'), 500),
    null::uuid
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
declare
  previous_secret_id uuid;
  new_secret_id uuid;
begin
  if nullif(btrim(p_facebook_page_id), '') is null
     or nullif(btrim(p_facebook_page_name), '') is null
     or nullif(btrim(p_page_access_token), '') is null then
    raise exception using errcode = '22023', message = 'META_CONNECTION_INVALID_INPUT';
  end if;

  -- Las rutas de OAuth ya verifican esto, pero la función privilegiada también
  -- lo aplica para que un uso accidental de service_role no cruce tenants.
  perform public.assert_organization_actor(
    p_organization_id,
    p_connected_by,
    array['owner']::public.organization_role[]
  );

  select page_access_token_vault_secret_id into previous_secret_id
  from public.organization_meta_connections
  where organization_id = p_organization_id
  for update;

  new_secret_id := vault.create_secret(
    btrim(p_page_access_token),
    format('orbit-meta-page-token:%s:%s', p_organization_id, gen_random_uuid()),
    'Orbit OS Meta page access token (service role only)',
    null::uuid
  );

  insert into public.organization_meta_connections (
    organization_id, facebook_page_id, facebook_page_name,
    instagram_business_account_id, page_access_token_vault_secret_id, status,
    connected_by, connected_at, updated_at
  ) values (
    p_organization_id, btrim(p_facebook_page_id), btrim(p_facebook_page_name),
    nullif(btrim(p_instagram_business_account_id), ''), new_secret_id, 'ACTIVE',
    p_connected_by, now(), now()
  )
  on conflict (organization_id) do update set
    facebook_page_id = excluded.facebook_page_id,
    facebook_page_name = excluded.facebook_page_name,
    instagram_business_account_id = excluded.instagram_business_account_id,
    page_access_token_vault_secret_id = excluded.page_access_token_vault_secret_id,
    status = 'ACTIVE',
    connected_by = excluded.connected_by,
    updated_at = now();

  perform public.invalidate_meta_vault_secret(
    previous_secret_id,
    'Meta page access token replaced'
  );

  return jsonb_build_object('connected', true);
end;
$$;

create function public.revoke_meta_connection(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  previous_secret_id uuid;
  was_revoked boolean;
begin
  select page_access_token_vault_secret_id into previous_secret_id
  from public.organization_meta_connections
  where organization_id = p_organization_id
  for update;

  update public.organization_meta_connections
  set status = 'REVOKED', page_access_token_vault_secret_id = null, updated_at = now()
  where organization_id = p_organization_id;
  was_revoked := found;
  perform public.invalidate_meta_vault_secret(previous_secret_id, 'Meta connection revoked');
  return jsonb_build_object('revoked', was_revoked);
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

-- Resuelve un token solo dentro del worker con service_role. Esta es la única
-- ruta SQL que puede incluir el token descifrado en una respuesta RPC.
create function public.resolve_meta_connection_for_publish(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  connection public.organization_meta_connections%rowtype;
  page_access_token text;
begin
  select * into connection
  from public.organization_meta_connections
  where organization_id = p_organization_id and status = 'ACTIVE';
  if not found or connection.page_access_token_vault_secret_id is null then
    return jsonb_build_object('state', 'NOT_CONNECTED');
  end if;

  select decrypted_secret into page_access_token
  from vault.decrypted_secrets
  where id = connection.page_access_token_vault_secret_id;
  if page_access_token is null
     or length(btrim(page_access_token)) = 0
     or page_access_token like 'REVOKED:%' then
    return jsonb_build_object('state', 'SECRET_UNAVAILABLE');
  end if;

  return jsonb_build_object(
    'state', 'RESOLVED',
    'facebookPageId', connection.facebook_page_id,
    'facebookPageName', connection.facebook_page_name,
    'instagramBusinessAccountId', connection.instagram_business_account_id,
    'pageAccessToken', page_access_token
  );
end;
$$;

revoke all on function public.get_meta_connection_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.upsert_meta_connection(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.revoke_meta_connection(uuid) from public, anon, authenticated;
revoke all on function public.mark_meta_connection_error(uuid) from public, anon, authenticated;
revoke all on function public.invalidate_meta_vault_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.resolve_meta_connection_for_publish(uuid) from public, anon, authenticated;
grant execute on function public.get_meta_connection_status(uuid, uuid) to authenticated;
grant execute on function public.upsert_meta_connection(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.revoke_meta_connection(uuid) to service_role;
grant execute on function public.mark_meta_connection_error(uuid) to service_role;
grant execute on function public.resolve_meta_connection_for_publish(uuid) to service_role;

-- ============================================================
-- Task 3: organization_meta_oauth_sessions
-- ============================================================

create table public.organization_meta_oauth_sessions (
  nonce uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  discovered_pages jsonb not null check (jsonb_typeof(discovered_pages) = 'array'),
  user_long_lived_token_vault_secret_id uuid not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz not null
);
alter table public.organization_meta_oauth_sessions enable row level security;
revoke all on public.organization_meta_oauth_sessions from public, anon, authenticated;

create function public.create_meta_oauth_session(
  p_nonce uuid,
  p_organization_id uuid,
  p_discovered_pages jsonb,
  p_user_long_lived_token text,
  p_created_by uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare secret_id uuid;
begin
  if jsonb_typeof(p_discovered_pages) <> 'array'
     or nullif(btrim(p_user_long_lived_token), '') is null
     or p_expires_at <= now() then
    raise exception using errcode = '22023', message = 'META_OAUTH_SESSION_INVALID_INPUT';
  end if;
  perform public.assert_organization_actor(
    p_organization_id,
    p_created_by,
    array['owner']::public.organization_role[]
  );

  secret_id := vault.create_secret(
    btrim(p_user_long_lived_token),
    format('orbit-meta-oauth-token:%s:%s', p_organization_id, p_nonce),
    'Orbit OS temporary Meta OAuth token (service role only)',
    null::uuid
  );

  insert into public.organization_meta_oauth_sessions (
    nonce, organization_id, discovered_pages, user_long_lived_token_vault_secret_id,
    created_by, expires_at
  ) values (
    p_nonce, p_organization_id, p_discovered_pages, secret_id, p_created_by, p_expires_at
  );

  return jsonb_build_object('created', true);
exception
  when unique_violation then
    perform public.invalidate_meta_vault_secret(secret_id, 'Duplicate Meta OAuth session');
    raise exception using errcode = '23505', message = 'META_OAUTH_SESSION_ALREADY_EXISTS';
end;
$$;

-- La ruta servidor valida primero la sesión del usuario y su organización;
-- solo después invoca este resolver con service_role para obtener el token
-- temporal. No existe una policy/RPC para que el navegador lo lea.
create function public.resolve_meta_oauth_session(
  p_organization_id uuid,
  p_nonce uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  session_row public.organization_meta_oauth_sessions%rowtype;
  user_long_lived_token text;
begin
  select * into session_row
  from public.organization_meta_oauth_sessions
  where organization_id = p_organization_id
    and nonce = p_nonce
    and expires_at > now();
  if not found then
    return null;
  end if;

  select decrypted_secret into user_long_lived_token
  from vault.decrypted_secrets
  where id = session_row.user_long_lived_token_vault_secret_id;
  if user_long_lived_token is null
     or length(btrim(user_long_lived_token)) = 0
     or user_long_lived_token like 'REVOKED:%' then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_SECRET_UNAVAILABLE';
  end if;

  return jsonb_build_object(
    'organizationId', session_row.organization_id,
    'discoveredPages', session_row.discovered_pages,
    'createdBy', session_row.created_by,
    'expiresAt', session_row.expires_at,
    'userLongLivedToken', user_long_lived_token
  );
end;
$$;

revoke all on function public.create_meta_oauth_session(uuid, uuid, jsonb, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.resolve_meta_oauth_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_meta_oauth_session(uuid, uuid, jsonb, text, uuid, timestamptz) to service_role;
grant execute on function public.resolve_meta_oauth_session(uuid, uuid) to service_role;

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
  -- Solo pgcrypto está habilitado en este proyecto (no uuid-ossp), así que
  -- se deriva con md5 en vez de uuid_generate_v5 — md5(...)::uuid es SQL
  -- válido en Postgres (el hash hex de 32 caracteres se parsea como UUID).
  derived_key uuid := md5(p_publication_target_id::text)::uuid;
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

-- Marca el job FAILED y, a diferencia de claim_next_copy_automation_job
-- (que no tiene un "target" que actualizar), también pone el
-- publication_target en ERROR con el mismo motivo. Sin esto,
-- retry_publish_target nunca encuentra nada que reintentar: el job queda
-- muerto pero el target sigue APPROVED para siempre.
create function public.fail_claim_publish_job(
  p_job_id uuid, p_target_id uuid, p_organization_id uuid, p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.automation_jobs set status = 'FAILED', sanitized_error = p_reason, updated_at = now()
  where id = p_job_id;
  update public.publication_targets set status = 'ERROR'::public.publication_status, last_error = p_reason
  where id = p_target_id and organization_id = p_organization_id;
end;
$$;
revoke all on function public.fail_claim_publish_job(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_claim_publish_job(uuid, uuid, uuid, text) to service_role;

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
  meta_connection jsonb;
  assets_json jsonb;
  token uuid := gen_random_uuid();
begin
  -- No se usa un advisory lock por target (la ronda 2 de revisión de Codex
  -- encontró que la versión anterior con pg_advisory_xact_lock era en sí
  -- misma vulnerable a una carrera: la subconsulta que elegía "el target a
  -- lockear" podía evaluar distinto al SELECT real de abajo bajo commits
  -- concurrentes). En vez de eso, se usa el lock de fila estándar de
  -- Postgres: se bloquea la fila de publication_targets con `for update`
  -- (ver abajo), y solo DESPUÉS de tener ese lock se revisa si ya hay otro
  -- job PROCESSING para el mismo target. Una segunda transacción que
  -- intente lockear la MISMA fila de target se bloquea hasta que la
  -- primera termine — ahí es donde ocurre la serialización real, no antes.
  select queued.* into job
  from public.automation_jobs as queued
  where queued.kind = 'PUBLISH'
    and (p_provider is null or queued.provider = p_provider)
    and (p_organization_id is null or queued.organization_id = p_organization_id)
    and queued.status in ('QUEUED', 'RETRY_WAIT')
    and queued.run_at <= now()
    and queued.next_attempt_at <= now()
  order by queued.next_attempt_at asc, queued.created_at asc
  limit 1
  for update skip locked;

  if not found then
    return jsonb_build_object('state', 'NOT_CLAIMABLE');
  end if;

  -- El lock de esta fila es lo que serializa dos claims concurrentes sobre
  -- el mismo target: la segunda transacción bloquea aquí hasta que la
  -- primera libere (commit/rollback), y para entonces la re-verificación
  -- de abajo ya ve el job de la primera como PROCESSING.
  select * into target
  from public.publication_targets
  where id = job.publication_target_id and organization_id = job.organization_id
  for update;
  if not found then
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_TARGET_NOT_APPROVED');
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;
  if target.status = 'PUBLISHED' then
    -- Job duplicado obsoleto: otro job ya publicó este target con éxito
    -- (p. ej. dos jobs QUEUED para el mismo target por una carrera previa
    -- a la Tarea 5, o un reintento manual que llegó tarde). No es un
    -- error -- NO se debe llamar fail_claim_publish_job aquí, porque eso
    -- sobrescribiría un target PUBLISHED (un estado bueno) con ERROR
    -- (hallazgo de revisión Codex ronda 3). Se cierra el job sin tocar el
    -- target.
    update public.automation_jobs set status = 'CANCELLED', cancelled_at = now(),
      sanitized_error = 'PUBLISH_JOB_TARGET_ALREADY_PUBLISHED', updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'CANCELLED', 'jobId', job.id);
  end if;
  if target.status <> 'APPROVED' then
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_TARGET_NOT_APPROVED');
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  if exists (
    select 1 from public.automation_jobs as active
    where active.publication_target_id = target.id
      and active.kind = 'PUBLISH'
      and active.status = 'PROCESSING'
      and active.lease_expires_at > now()
      and active.id <> job.id
  ) then
    -- Otro job para el mismo target ya está en curso (típicamente: este
    -- job fue el candidato de una transacción que perdió la carrera de
    -- arriba). No es un fallo del job -- simplemente no es su turno
    -- todavía; el próximo poll del worker lo vuelve a intentar.
    return jsonb_build_object('state', 'NOT_CLAIMABLE');
  end if;

  meta_connection := public.resolve_meta_connection_for_publish(job.organization_id);
  if coalesce(meta_connection->>'state', '') <> 'RESOLVED' then
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_CONNECTION_NOT_FOUND');
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;
  if target.platform = 'INSTAGRAM'
     and nullif(meta_connection->>'instagramBusinessAccountId', '') is null then
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_INSTAGRAM_NOT_CONNECTED');
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  select * into final_copy
  from public.final_copy_versions
  where content_item_id = job.content_item_id and organization_id = job.organization_id
  order by version desc limit 1;
  if not found then
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_FINAL_COPY_NOT_FOUND');
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
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_ASSETS_NOT_FOUND');
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
        'facebookPageId', meta_connection->>'facebookPageId',
        'pageAccessToken', meta_connection->>'pageAccessToken',
        'instagramBusinessAccountId', nullif(meta_connection->>'instagramBusinessAccountId', '')
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
declare
  recovered_count integer := 0;
  job_row record;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_RECOVERY_LIMIT_INVALID';
  end if;

  -- FOR ... IN <update ... returning> es un loop válido en PL/pgSQL sobre
  -- las filas devueltas por un UPDATE. Se usa (en vez de una segunda
  -- sentencia aparte) para poder, por cada job recién recuperado, decidir
  -- si también hay que tocar su publication_target — a diferencia de COPY,
  -- un PUBLISH que cae en DEAD_LETTER por recuperación de lease (no por
  -- fail_publish_automation_job) también debe dejar el target en ERROR, o
  -- retry_publish_target nunca tiene nada que reintentar.
  for job_row in
    update public.automation_jobs as job
    set status = case when expired.attempt_count >= expired.max_attempts
                    then 'DEAD_LETTER'::public.automation_job_status
                    else 'RETRY_WAIT'::public.automation_job_status end,
        next_attempt_at = now(),
        sanitized_error = coalesce(job.sanitized_error, 'Lease expired before completion'),
        lease_token = null, lease_expires_at = null, updated_at = now()
    from (
      select id, attempt_count, max_attempts
      from public.automation_jobs
      where kind = 'PUBLISH' and status = 'PROCESSING' and lease_expires_at <= now()
      order by lease_expires_at asc
      for update skip locked
      limit p_limit
    ) as expired
    where job.id = expired.id
    returning job.id, job.status, job.publication_target_id, job.organization_id
  loop
    recovered_count := recovered_count + 1;
    if job_row.status = 'DEAD_LETTER' then
      update public.publication_targets
      set status = 'ERROR'::public.publication_status,
          last_error = coalesce(last_error, 'Lease expired before completion')
      where id = job_row.publication_target_id and organization_id = job_row.organization_id;
    end if;
  end loop;

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

-- ============================================================
-- Task 6: apply_publication_diagnosis
-- ============================================================

-- automation_runs.kind (0001_content_os.sql) declaró un check inline
-- cerrado a 4 valores, sin PUBLISH_DIAGNOSIS. Mismo patrón que la Tarea 4:
-- dropear por el nombre auto-generado antes de agregar el nuevo.
alter table public.automation_runs drop constraint if exists automation_runs_kind_check;
alter table public.automation_runs add constraint automation_runs_kind_check
  check (kind in ('COPY_REQUEST', 'COPY_CALLBACK', 'PUBLISH_REQUEST', 'PUBLISH_CALLBACK', 'PUBLISH_DIAGNOSIS'));

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
  item public.content_items%rowtype;
  target public.publication_targets%rowtype;
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

  -- Orden de locks: content_items primero, publication_targets después —
  -- mismo orden que approve_publication_target y
  -- complete_publish_automation_job, para no crear un deadlock si alguna de
  -- las tres corre al mismo tiempo sobre el mismo content item.
  select * into item from public.content_items
  where id = p_content_item_id and organization_id = p_organization_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'DIAGNOSIS_CONTENT_NOT_FOUND'; end if;

  select * into target from public.publication_targets
  where id = p_publication_target_id and content_item_id = p_content_item_id
    and organization_id = p_organization_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'DIAGNOSIS_TARGET_NOT_FOUND'; end if;
  if target.status <> 'PENDING_REVIEW' then
    return jsonb_build_object('created', false, 'reason', 'TARGET_NOT_PENDING');
  end if;

  -- La regla vive acá, no en TypeScript: "promising" y CADA finding con
  -- severity EXACTAMENTE "info" es lo único que cuenta como seguro. coalesce
  -- a '' hace esto fail-closed: un finding con severity nula, ausente, o un
  -- valor no reconocido NUNCA pasa como seguro, solo 'info' explícito.
  is_safe := p_quality_level = 'promising' and not exists (
    select 1 from jsonb_array_elements(p_findings) as finding
    where coalesce(finding->>'severity', '') <> 'info'
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
-- END 0018_meta_publisher.sql

-- BEGIN 0019_content_item_assets_write.sql
-- Register additional content item assets after the existing single-cover RPC.
-- The table from 0018 intentionally has no direct authenticated write policy.

create function public.add_content_item_asset_in_organization(
  p_organization_id uuid,
  p_actor_id uuid,
  p_content_item_id uuid,
  p_asset_id uuid,
  p_position smallint
)
returns public.content_item_assets
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_asset public.content_item_assets;
begin
  perform public.assert_organization_actor(
    p_organization_id,
    p_actor_id,
    array['owner', 'editor']::public.organization_role[]
  );

  insert into public.content_item_assets (
    organization_id, content_item_id, asset_id, position
  ) values (
    p_organization_id, p_content_item_id, p_asset_id, p_position
  )
  returning * into created_asset;

  return created_asset;
end;
$$;

revoke all on function public.add_content_item_asset_in_organization(
  uuid, uuid, uuid, uuid, smallint
) from public, anon, authenticated;
grant execute on function public.add_content_item_asset_in_organization(
  uuid, uuid, uuid, uuid, smallint
) to service_role;
-- END 0019_content_item_assets_write.sql

-- BEGIN 0020_publish_job_provider_fix.sql
-- Ensure Meta publish jobs are visible to the Meta worker.

drop function if exists public.get_meta_connection_status(uuid, uuid);

create or replace function public.get_meta_connection_status(
  p_organization_id uuid
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
    p_organization_id, auth.uid(),
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

revoke all on function public.get_meta_connection_status(uuid) from public, anon, authenticated;
grant execute on function public.get_meta_connection_status(uuid) to authenticated;

create or replace function public.enqueue_publish_automation_job(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  derived_key uuid := md5(p_publication_target_id::text)::uuid;
  existing_job public.automation_jobs%rowtype;
  created_job public.automation_jobs%rowtype;
begin
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
    organization_id, content_item_id, publication_target_id, kind, status, idempotency_key, provider
  ) values (
    p_organization_id, p_content_item_id, p_publication_target_id, 'PUBLISH', 'QUEUED', derived_key, 'meta'
  ) returning * into created_job;

  return jsonb_build_object('created', true, 'jobId', created_job.id);
end;
$$;

drop function if exists public.retry_publish_target(uuid, uuid, uuid);

create or replace function public.retry_publish_target(
  p_organization_id uuid, p_actor_id uuid, p_publication_target_id uuid, p_content_item_id uuid
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
  where id = p_publication_target_id
    and organization_id = p_organization_id
    and content_item_id = p_content_item_id
  for update;
  if not found then raise exception using errcode = 'P0001', message = 'RETRY_TARGET_NOT_FOUND'; end if;
  if target.status <> 'ERROR' then
    raise exception using errcode = 'P0001', message = 'RETRY_TARGET_NOT_IN_ERROR';
  end if;

  update public.publication_targets set status = 'APPROVED'::public.publication_status, last_error = null
  where id = target.id returning * into updated_target;

  insert into public.automation_jobs (
    organization_id, content_item_id, publication_target_id, kind, status, idempotency_key, provider
  ) values (
    p_organization_id, target.content_item_id, target.id, 'PUBLISH', 'QUEUED', gen_random_uuid(), 'meta'
  );

  return updated_target;
end;
$$;

revoke all on function public.retry_publish_target(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.retry_publish_target(uuid, uuid, uuid, uuid) to service_role;
-- END 0020_publish_job_provider_fix.sql

-- BEGIN 0021_meta_oauth_session_cleanup.sql
-- ============================================================
-- Meta OAuth session cleanup and atomic page selection
-- ============================================================

create function public.complete_meta_oauth_selection(
  p_organization_id uuid,
  p_nonce uuid,
  p_facebook_page_id text,
  p_facebook_page_name text,
  p_instagram_business_account_id text,
  p_page_access_token text,
  p_connected_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  session_secret_id uuid;
  session_created_by uuid;
begin
  -- Bloquea y verifica la sesión ANTES de persistir la página. Así un nonce
  -- vencido, de otra organización o de otro actor nunca puede enlazar una
  -- página mediante una RPC privilegiada.
  select user_long_lived_token_vault_secret_id, created_by
  into session_secret_id, session_created_by
  from public.organization_meta_oauth_sessions
  where nonce = p_nonce
    and organization_id = p_organization_id
    and expires_at > now()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_NOT_FOUND';
  end if;
  if session_created_by <> p_connected_by then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_ACTOR_MISMATCH';
  end if;

  perform public.upsert_meta_connection(
    p_organization_id,
    p_connected_by,
    p_facebook_page_id,
    p_facebook_page_name,
    p_instagram_business_account_id,
    p_page_access_token
  );

  -- No se borra directamente desde Vault: se invalida el cifrado y después
  -- se remueve la referencia temporal. La API/cliente nunca ve este valor.
  perform public.invalidate_meta_vault_secret(
    session_secret_id,
    'Meta OAuth session completed'
  );

  delete from public.organization_meta_oauth_sessions
  where nonce = p_nonce and organization_id = p_organization_id;

  return jsonb_build_object('connected', true);
end;
$$;

-- Mantenimiento: invocar esta función periódicamente desde el mismo mecanismo
-- operativo que usa el repositorio para tareas de mantenimiento del worker
-- (por ejemplo, junto con la recuperación de leases expirados). Esta migración
-- no registra un cron por sí sola.
create function public.delete_expired_meta_oauth_sessions(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  deleted_count integer := 0;
  expired_session record;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_CLEANUP_LIMIT_INVALID';
  end if;

  for expired_session in
    select nonce, user_long_lived_token_vault_secret_id
    from public.organization_meta_oauth_sessions
    where expires_at <= now()
    order by expires_at asc
    for update skip locked
    limit p_limit
  loop
    perform public.invalidate_meta_vault_secret(
      expired_session.user_long_lived_token_vault_secret_id,
      'Meta OAuth session expired'
    );
    delete from public.organization_meta_oauth_sessions
    where nonce = expired_session.nonce;
    deleted_count := deleted_count + 1;
  end loop;

  return jsonb_build_object('deleted', deleted_count);
end;
$$;

revoke all on function public.complete_meta_oauth_selection(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_expired_meta_oauth_sessions(integer) from public, anon, authenticated;
grant execute on function public.complete_meta_oauth_selection(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.delete_expired_meta_oauth_sessions(integer) to service_role;
-- END 0021_meta_oauth_session_cleanup.sql

-- BEGIN 0022_publish_manual_race_guard.sql
-- Guard the last step of automated publication from overwriting manual evidence.
-- The target remains the source of truth: a manual PUBLISHED state wins, and
-- an automatic completion only writes while the target is still APPROVED.

create or replace function public.complete_publish_automation_job(
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
  target public.publication_targets%rowtype;
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

  -- Keep the established lock order job -> content_items -> publication_targets.
  -- record_manual_publication_delivery already locks item -> target, so this
  -- order prevents the completion path from introducing a reverse cycle.
  select * into item from public.content_items
  where id = job.content_item_id and organization_id = job.organization_id for update;
  select * into target from public.publication_targets
  where id = job.publication_target_id and organization_id = job.organization_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PUBLISH_JOB_TARGET_NOT_FOUND';
  end if;

  if target.status = 'PUBLISHED' then
    -- Manual evidence (or another completed path) owns the result now. Close
    -- the stale worker job without replacing the recorded URL or provenance.
    update public.automation_jobs
    set status = 'CANCELLED', cancelled_at = now(),
        sanitized_error = 'PUBLISH_JOB_TARGET_ALREADY_PUBLISHED',
        lease_token = null, lease_expires_at = null, updated_at = now()
    where id = job.id;
    return jsonb_build_object(
      'created', false, 'state', 'CANCELLED', 'jobId', job.id,
      'reason', 'PUBLISH_JOB_TARGET_ALREADY_PUBLISHED'
    );
  end if;

  -- Do not let an automatic completion overwrite any state change made after
  -- claim. Only APPROVED is the expected pre-publication state.
  if target.status <> 'APPROVED' then
    update public.automation_jobs
    set status = 'CANCELLED', cancelled_at = now(),
        sanitized_error = 'PUBLISH_JOB_TARGET_STATUS_CHANGED',
        lease_token = null, lease_expires_at = null, updated_at = now()
    where id = job.id;
    return jsonb_build_object(
      'created', false, 'state', 'CANCELLED', 'jobId', job.id,
      'reason', 'PUBLISH_JOB_TARGET_STATUS_CHANGED'
    );
  end if;

  update public.publication_targets
  set status = 'PUBLISHED'::public.publication_status,
      remote_post_id = p_result->>'remotePostId',
      remote_url = p_result->>'remoteUrl',
      published_at = (p_result->>'publishedAt')::timestamptz,
      last_error = null
  where id = target.id and organization_id = job.organization_id;

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

-- A manual delivery is evidence of a post already made outside Orbit OS. If
-- an automatic worker is PROCESSING, reject the manual write instead of
-- recording two competing outcomes; the operator can retry after the worker
-- reaches a terminal state. QUEUED/RETRY_WAIT jobs are harmless because the
-- existing claim function rechecks PUBLISHED and cancels them.
create or replace function public.guard_manual_publication_delivery_race()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.status <> 'APPROVED'::public.publication_status
     or new.status <> 'PUBLISHED'::public.publication_status
     or new.remote_post_id is not null then
    return new;
  end if;

  if exists (
    select 1
    from public.automation_jobs
    where publication_target_id = old.id
      and kind = 'PUBLISH'
      and status = 'PROCESSING'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'MANUAL_DELIVERY_PUBLISH_IN_PROGRESS';
  end if;

  return new;
end;
$$;

drop trigger if exists publication_targets_manual_publication_delivery_race_guard
  on public.publication_targets;
create trigger publication_targets_manual_publication_delivery_race_guard
before update on public.publication_targets
for each row execute function public.guard_manual_publication_delivery_race();

revoke all on function public.guard_manual_publication_delivery_race() from public, anon, authenticated;
-- END 0022_publish_manual_race_guard.sql

-- BEGIN 0023_content_item_assets_atomic.sql
-- Create a multi-asset content item and all of its asset metadata/links in
-- one database transaction. Storage uploads happen before this RPC and are
-- removed best-effort by the repository if the RPC fails.

create function public.create_content_item_with_assets_in_organization(
  p_organization_id uuid,
  p_owner_id uuid,
  p_assets jsonb,
  p_business_line text,
  p_service text,
  p_niche text,
  p_content_type text,
  p_objective text,
  p_format text,
  p_cta text,
  p_human_description text,
  p_allowed_facts jsonb,
  p_campaign_name text,
  p_offer text,
  p_funnel_stage text,
  p_destination text,
  p_destination_value text,
  p_campaign_code text
)
returns public.content_items
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_item public.content_items;
  asset_entry jsonb;
  asset_id uuid;
  asset_position smallint;
  asset_count integer;
begin
  if jsonb_typeof(p_assets) <> 'array' then
    raise exception using errcode = '22023', message = 'CONTENT_ASSETS_INVALID';
  end if;

  asset_count := jsonb_array_length(p_assets);
  if asset_count < 1 or asset_count > 10 then
    raise exception using errcode = '22023', message = 'CONTENT_ASSETS_COUNT_INVALID';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );

  -- Validate the complete input before the first insert. Any constraint or
  -- cast failure in the statements below still aborts this whole RPC.
  for asset_entry in
    select value
    from jsonb_array_elements(p_assets)
  loop
    if jsonb_typeof(asset_entry) <> 'object'
       or nullif(btrim(asset_entry->>'assetId'), '') is null
       or nullif(btrim(asset_entry->>'storagePath'), '') is null
       or nullif(btrim(asset_entry->>'filename'), '') is null
       or nullif(btrim(asset_entry->>'mimeType'), '') is null
       or nullif(btrim(asset_entry->>'checksum'), '') is null
       or nullif(btrim(asset_entry->>'width'), '') is null
       or nullif(btrim(asset_entry->>'height'), '') is null
       or nullif(btrim(asset_entry->>'position'), '') is null then
      raise exception using errcode = '22023', message = 'CONTENT_ASSET_INVALID';
    end if;

    asset_id := (asset_entry->>'assetId')::uuid;
    asset_position := (asset_entry->>'position')::smallint;
    if asset_position < 0 or asset_position > 9 then
      raise exception using errcode = '22023', message = 'CONTENT_ASSET_POSITION_INVALID';
    end if;
  end loop;

  for asset_entry in
    select value
    from jsonb_array_elements(p_assets)
  loop
    insert into public.assets (
      id, organization_id, owner_id, bucket_id, storage_path, filename,
      mime_type, width, height, checksum
    ) values (
      (asset_entry->>'assetId')::uuid,
      p_organization_id,
      p_owner_id,
      'content-assets',
      btrim(asset_entry->>'storagePath'),
      btrim(asset_entry->>'filename'),
      btrim(asset_entry->>'mimeType'),
      (asset_entry->>'width')::integer,
      (asset_entry->>'height')::integer,
      btrim(asset_entry->>'checksum')
    );
  end loop;

  asset_id := (p_assets->0->>'assetId')::uuid;
  insert into public.content_items (
    organization_id, owner_id, asset_id, business_line, service, niche,
    content_type, objective, format, cta, human_description, allowed_facts,
    state, campaign_name, offer, funnel_stage, destination, destination_value,
    campaign_code
  ) values (
    p_organization_id, p_owner_id, asset_id, p_business_line, p_service,
    p_niche, p_content_type, p_objective, p_format, p_cta,
    p_human_description, p_allowed_facts, 'UPLOADED', p_campaign_name, p_offer,
    p_funnel_stage, p_destination, p_destination_value, p_campaign_code
  ) returning * into created_item;

  insert into public.publication_targets (
    organization_id, owner_id, content_item_id, platform, status
  ) values
    (p_organization_id, p_owner_id, created_item.id, 'FACEBOOK', 'PENDING_REVIEW'),
    (p_organization_id, p_owner_id, created_item.id, 'INSTAGRAM', 'PENDING_REVIEW');

  insert into public.content_item_assets (
    organization_id, content_item_id, asset_id, position
  )
  select
    p_organization_id,
    created_item.id,
    (entries.value->>'assetId')::uuid,
    (entries.value->>'position')::smallint
  from jsonb_array_elements(p_assets) as entries(value);

  insert into public.audit_events (
    organization_id, owner_id, actor_id, content_item_id, event_type, metadata
  ) values (
    p_organization_id, p_owner_id, p_owner_id, created_item.id, 'CONTENT_CREATED',
    jsonb_build_object('assetId', asset_id, 'assetCount', asset_count, 'campaignCode', p_campaign_code)
  );

  return created_item;
end;
$$;

revoke all on function public.create_content_item_with_assets_in_organization(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_content_item_with_assets_in_organization(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text
) to service_role;
-- END 0023_content_item_assets_atomic.sql

-- BEGIN 0024_publish_hardening.sql
-- Publish hardening: remove the unnecessary automation_jobs lock from the
-- idempotency read. The existing row is not modified in that branch; the
-- unique (organization_id, kind, idempotency_key) constraint protects the
-- insert when no row is found.

create or replace function public.enqueue_publish_automation_job(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  derived_key uuid := md5(p_publication_target_id::text)::uuid;
  existing_job public.automation_jobs%rowtype;
  created_job public.automation_jobs%rowtype;
begin
  select * into existing_job
  from public.automation_jobs
  where organization_id = p_organization_id
    and kind = 'PUBLISH'
    and idempotency_key = derived_key;
  if found then
    return jsonb_build_object('created', false, 'jobId', existing_job.id);
  end if;

  insert into public.automation_jobs (
    organization_id, content_item_id, publication_target_id, kind, status, idempotency_key, provider
  ) values (
    p_organization_id, p_content_item_id, p_publication_target_id, 'PUBLISH', 'QUEUED', derived_key, 'meta'
  ) returning * into created_job;

  return jsonb_build_object('created', true, 'jobId', created_job.id);
end;
$$;

-- Defense in depth for a future n8n path that records request/callback rows
-- in automation_runs. Today preparePublishRequest/requestN8nPublish only
-- validate the approved target and deliver HTTP; they do not insert
-- PUBLISH_REQUEST, so this check offers no production protection yet. Keep
-- the guard ready for the day that instrumentation is added, so manual
-- evidence cannot race a real n8n delivery.
create or replace function public.guard_manual_publication_delivery_race()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.status <> 'APPROVED'::public.publication_status
     or new.status <> 'PUBLISHED'::public.publication_status
     or new.remote_post_id is not null then
    return new;
  end if;

  if exists (
    select 1
    from public.automation_jobs
    where publication_target_id = old.id
      and kind = 'PUBLISH'
      and status = 'PROCESSING'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'MANUAL_DELIVERY_PUBLISH_IN_PROGRESS';
  end if;

  if exists (
    select 1
    from public.automation_runs as publish_request
    where publish_request.organization_id = old.organization_id
      and publish_request.publication_target_id = old.id
      and publish_request.kind = 'PUBLISH_REQUEST'
      and not exists (
        select 1
        from public.automation_runs as publish_callback
        where publish_callback.organization_id = publish_request.organization_id
          and publish_callback.publication_target_id = publish_request.publication_target_id
          and publish_callback.kind = 'PUBLISH_CALLBACK'
          and publish_callback.idempotency_key = publish_request.idempotency_key
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'MANUAL_DELIVERY_PUBLISH_IN_PROGRESS';
  end if;

  return new;
end;
$$;
-- END 0024_publish_hardening.sql

-- BEGIN 0025_publication_targets_status_index.sql
-- 0025_publication_targets_status_index.sql
create index if not exists publication_targets_organization_status_idx
  on public.publication_targets (organization_id, status);
-- END 0025_publication_targets_status_index.sql

-- BEGIN 0026_intake_interactive_ai_usage.sql
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

revoke all on function public.record_interactive_ai_usage(uuid, text, text, integer, integer, numeric) from public, anon, authenticated;
grant execute on function public.record_interactive_ai_usage(uuid, text, text, integer, integer, numeric) to service_role;
-- END 0026_intake_interactive_ai_usage.sql

-- BEGIN 0027_organization_logos_bucket.sql
-- 0018_organization_logos_bucket.sql
insert into storage.buckets (id, name, public)
values ('organization-logos', 'organization-logos', false)
on conflict (id) do nothing;

create policy "Organization members read organization logos" on storage.objects
  for select to authenticated using (
    bucket_id = 'organization-logos'
    and public.is_organization_member((storage.foldername(name))[1]::uuid)
  );

create policy "Organization owners upload organization logos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
    and name = (storage.foldername(name))[1] || '/logo.png'
  );

create policy "Organization owners replace organization logos" on storage.objects
  for update to authenticated using (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
  ) with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
    and name = (storage.foldername(name))[1] || '/logo.png'
  );
-- END 0027_organization_logos_bucket.sql

-- BEGIN 0028_organization_api_keys.sql
-- 0028_organization_api_keys.sql
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

create policy "Owners read their api keys" on public.organization_api_keys for select to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));

-- Sin policy de insert/update/delete: solo las RPCs de abajo escriben esta
-- tabla, corriendo con privilegios de servicio (security definer), no con
-- los del caller. Evita que una policy amplia permita a un owner reescribir
-- created_by de una clave para atribuirla a otro usuario.

create function public.create_organization_api_key(p_organization_id uuid, p_label text)
returns table (id uuid, key_prefix text, secret text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_secret text := 'sk_live_' || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_hash text := pg_catalog.encode(extensions.digest(v_secret, 'sha256'), 'hex');
  v_prefix text := pg_catalog.left(v_secret, 12);
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
set search_path = pg_catalog
as $$
declare
  v_organization_id uuid;
begin
  select organization_id into v_organization_id
  from public.organization_api_keys where id = p_key_id;
  -- Corrección ronda 3: mismo bug de NULL que create_organization_api_key.
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
-- END 0028_organization_api_keys.sql

-- BEGIN 0029_actor_metadata_for_api_keys.sql
-- 0020_actor_metadata_for_api_keys.sql
-- Agrega p_actor_metadata a las RPCs que insertan audit_events y que la API
-- v1 puede disparar, para atribuir la acción a una clave de API cuando
-- corresponda. drop+create evita un overload ambiguo — mismo patrón que
-- 0014_copy_hashtags_and_ai_usage.sql:348-356.

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
  -- Serialize a key even before its row exists, preventing a concurrent retry
  -- from changing another content item before the unique constraint fires.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || p_idempotency_key::text));
  select * into existing_job
  from public.automation_jobs
  where organization_id = p_organization_id
    and kind = 'COPY'
    and idempotency_key = p_idempotency_key
  for update;
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
  -- Keep the callback RPC's request ledger in the same transaction. The
  -- worker never writes this table; it only completes the portal-owned job.
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

revoke all on function public.enqueue_copy_automation_job(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_copy_automation_job(uuid, uuid, uuid, uuid, jsonb) to service_role;
-- END 0029_actor_metadata_for_api_keys.sql

-- BEGIN 0030_actor_metadata_for_multi_asset_rpc.sql
-- 0030_actor_metadata_for_multi_asset_rpc.sql
-- 0029_actor_metadata_for_api_keys.sql agregó p_actor_metadata a
-- create_content_item_with_asset_in_organization (singular), pero esa
-- rama se escribió antes de que existiera
-- create_content_item_with_assets_in_organization (plural, migración
-- 0023) — la RPC multi-asset que SupabaseRepository realmente llama hoy
-- (createContentItemWithAsset ahora es un wrapper delgado sobre
-- createContentItemWithAssets). Sin este parámetro, la API v1 no puede
-- atribuir un CONTENT_CREATED a la clave que lo generó. drop+create evita
-- un overload ambiguo — mismo patrón que 0014_copy_hashtags_and_ai_usage.sql:348-356.

drop function if exists public.create_content_item_with_assets_in_organization(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text
);

create function public.create_content_item_with_assets_in_organization(
  p_organization_id uuid,
  p_owner_id uuid,
  p_assets jsonb,
  p_business_line text,
  p_service text,
  p_niche text,
  p_content_type text,
  p_objective text,
  p_format text,
  p_cta text,
  p_human_description text,
  p_allowed_facts jsonb,
  p_campaign_name text,
  p_offer text,
  p_funnel_stage text,
  p_destination text,
  p_destination_value text,
  p_campaign_code text,
  p_actor_metadata jsonb default '{}'::jsonb
)
returns public.content_items
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created_item public.content_items;
  asset_entry jsonb;
  asset_id uuid;
  asset_position smallint;
  asset_count integer;
begin
  if jsonb_typeof(p_assets) <> 'array' then
    raise exception using errcode = '22023', message = 'CONTENT_ASSETS_INVALID';
  end if;

  asset_count := jsonb_array_length(p_assets);
  if asset_count < 1 or asset_count > 10 then
    raise exception using errcode = '22023', message = 'CONTENT_ASSETS_COUNT_INVALID';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );

  -- Validate the complete input before the first insert. Any constraint or
  -- cast failure in the statements below still aborts this whole RPC.
  for asset_entry in
    select value
    from jsonb_array_elements(p_assets)
  loop
    if jsonb_typeof(asset_entry) <> 'object'
       or nullif(btrim(asset_entry->>'assetId'), '') is null
       or nullif(btrim(asset_entry->>'storagePath'), '') is null
       or nullif(btrim(asset_entry->>'filename'), '') is null
       or nullif(btrim(asset_entry->>'mimeType'), '') is null
       or nullif(btrim(asset_entry->>'checksum'), '') is null
       or nullif(btrim(asset_entry->>'width'), '') is null
       or nullif(btrim(asset_entry->>'height'), '') is null
       or nullif(btrim(asset_entry->>'position'), '') is null then
      raise exception using errcode = '22023', message = 'CONTENT_ASSET_INVALID';
    end if;

    asset_id := (asset_entry->>'assetId')::uuid;
    asset_position := (asset_entry->>'position')::smallint;
    if asset_position < 0 or asset_position > 9 then
      raise exception using errcode = '22023', message = 'CONTENT_ASSET_POSITION_INVALID';
    end if;
  end loop;

  for asset_entry in
    select value
    from jsonb_array_elements(p_assets)
  loop
    insert into public.assets (
      id, organization_id, owner_id, bucket_id, storage_path, filename,
      mime_type, width, height, checksum
    ) values (
      (asset_entry->>'assetId')::uuid,
      p_organization_id,
      p_owner_id,
      'content-assets',
      btrim(asset_entry->>'storagePath'),
      btrim(asset_entry->>'filename'),
      btrim(asset_entry->>'mimeType'),
      (asset_entry->>'width')::integer,
      (asset_entry->>'height')::integer,
      btrim(asset_entry->>'checksum')
    );
  end loop;

  asset_id := (p_assets->0->>'assetId')::uuid;
  insert into public.content_items (
    organization_id, owner_id, asset_id, business_line, service, niche,
    content_type, objective, format, cta, human_description, allowed_facts,
    state, campaign_name, offer, funnel_stage, destination, destination_value,
    campaign_code
  ) values (
    p_organization_id, p_owner_id, asset_id, p_business_line, p_service,
    p_niche, p_content_type, p_objective, p_format, p_cta,
    p_human_description, p_allowed_facts, 'UPLOADED', p_campaign_name, p_offer,
    p_funnel_stage, p_destination, p_destination_value, p_campaign_code
  ) returning * into created_item;

  insert into public.publication_targets (
    organization_id, owner_id, content_item_id, platform, status
  ) values
    (p_organization_id, p_owner_id, created_item.id, 'FACEBOOK', 'PENDING_REVIEW'),
    (p_organization_id, p_owner_id, created_item.id, 'INSTAGRAM', 'PENDING_REVIEW');

  insert into public.content_item_assets (
    organization_id, content_item_id, asset_id, position
  )
  select
    p_organization_id,
    created_item.id,
    (entries.value->>'assetId')::uuid,
    (entries.value->>'position')::smallint
  from jsonb_array_elements(p_assets) as entries(value);

  insert into public.audit_events (
    organization_id, owner_id, actor_id, content_item_id, event_type, metadata
  ) values (
    p_organization_id, p_owner_id, p_owner_id, created_item.id, 'CONTENT_CREATED',
    jsonb_build_object('assetId', asset_id, 'assetCount', asset_count, 'campaignCode', p_campaign_code)
      || p_actor_metadata
  );

  return created_item;
end;
$$;

revoke all on function public.create_content_item_with_assets_in_organization(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_content_item_with_assets_in_organization(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text, jsonb,
  text, text, text, text, text, text, jsonb
) to service_role;
-- END 0030_actor_metadata_for_multi_asset_rpc.sql

-- BEGIN 0031_organization_openrouter_byok_credentials.sql
-- ============================================================
-- Organization-owned OpenRouter (BYOK) credentials
-- ============================================================
--
-- Security invariants:
--   * The plaintext API key exists only as an RPC input and in Supabase Vault.
--   * No public table, audit event, job payload, or authenticated RPC response
--     contains the API key or the Vault secret identifier.
--   * Only the service_role can resolve the decrypted key for a trusted server
--     or worker. Browser code must use the sanitized status RPC below instead.
--   * Credential changes are owner-only because the key controls a customer's
--     external AI billing account. Editors can inspect non-sensitive status.
--
-- Vault does not expose a documented deletion API used by this repository.
-- Revocation therefore fail-closes the application resolver immediately; the
-- customer must also revoke the key at OpenRouter. Rotation updates the same
-- encrypted Vault secret in place, avoiding an orphaned historical secret.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists public.organization_ai_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider = 'OPENROUTER'),
  model text not null check (length(btrim(model)) between 1 and 200),
  input_cost_per_million_usd numeric(14, 6)
    check (input_cost_per_million_usd is null or input_cost_per_million_usd >= 0),
  output_cost_per_million_usd numeric(14, 6)
    check (output_cost_per_million_usd is null or output_cost_per_million_usd >= 0),
  monthly_budget_usd numeric(10, 2)
    check (monthly_budget_usd is null or monthly_budget_usd >= 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'REVOKED', 'ERROR')),
  last_error_code text,
  configured_by uuid not null references auth.users(id) on delete restrict,
  configured_at timestamptz not null default now(),
  last_rotated_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider),
  constraint organization_ai_provider_credentials_revocation_state_check
    check (
      (status = 'REVOKED' and revoked_at is not null)
      or (status <> 'REVOKED' and revoked_at is null)
    )
);

create index if not exists organization_ai_provider_credentials_org_status_idx
  on public.organization_ai_provider_credentials (organization_id, status);

-- This link is deliberately private: a Vault UUID is not a secret by itself,
-- but disclosing it broadens the set of objects a compromised client can probe.
create table if not exists private.organization_ai_provider_secret_links (
  credential_id uuid primary key
    references public.organization_ai_provider_credentials(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organization_ai_provider_credentials enable row level security;
alter table private.organization_ai_provider_secret_links enable row level security;

-- All credential writes and reads use narrowly scoped RPCs. This prevents a
-- future broad table grant from exposing non-sensitive configuration by mistake.
revoke all on table public.organization_ai_provider_credentials from public, anon, authenticated;
revoke all on table private.organization_ai_provider_secret_links from public, anon, authenticated;

drop trigger if exists organization_ai_provider_credentials_set_updated_at
  on public.organization_ai_provider_credentials;
create trigger organization_ai_provider_credentials_set_updated_at
  before update on public.organization_ai_provider_credentials
  for each row execute function public.set_updated_at();

-- Service-only write path. The application server must authenticate its caller
-- before invoking it, and this function independently confirms that the actor
-- is a current organization owner. It intentionally returns no secret data.
create or replace function public.configure_organization_openrouter_credential(
  p_organization_id uuid,
  p_configured_by uuid,
  p_api_key text,
  p_model text,
  p_input_cost_per_million_usd numeric default null,
  p_output_cost_per_million_usd numeric default null,
  p_monthly_budget_usd numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, vault
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
  v_vault_secret_id uuid;
  v_vault_name text;
begin
  if p_organization_id is null
     or p_configured_by is null
     or p_api_key is null
     or length(btrim(p_api_key)) < 8
     or p_api_key <> btrim(p_api_key)
     or p_model is null
     or length(btrim(p_model)) > 200
     or nullif(btrim(p_model), '') is null
     or p_input_cost_per_million_usd < 0
     or p_output_cost_per_million_usd < 0
     or p_monthly_budget_usd < 0 then
    raise exception using errcode = '22023', message = 'OPENROUTER_CREDENTIAL_INVALID_INPUT';
  end if;

  -- The function may be called under service_role (where auth.uid() is null),
  -- so authorize the claimed actor against the durable membership relation.
  if not exists (
    select 1
    from public.organization_members as member
    where member.organization_id = p_organization_id
      and member.user_id = p_configured_by
      and member.role = 'owner'::public.organization_role
  ) then
    raise exception using errcode = '42501', message = 'OPENROUTER_CREDENTIAL_OWNER_REQUIRED';
  end if;

  -- Serialize first configuration and rotations for one organization/provider.
  perform pg_advisory_xact_lock(
    hashtext('organization-openrouter-credential:' || p_organization_id::text)
  );

  select credential.* into v_credential
  from public.organization_ai_provider_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.provider = 'OPENROUTER'
  for update;

  if found then
    select link.vault_secret_id into v_vault_secret_id
    from private.organization_ai_provider_secret_links as link
    where link.credential_id = v_credential.id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'OPENROUTER_CREDENTIAL_SECRET_LINK_MISSING';
    end if;
  end if;

  v_vault_name := 'orbit-openrouter-' || p_organization_id::text;
  if v_vault_secret_id is null then
    v_vault_secret_id := vault.create_secret(
      p_api_key,
      v_vault_name,
      'Orbit OS organization-owned OpenRouter credential'
    );
  else
    perform vault.update_secret(
      v_vault_secret_id,
      p_api_key,
      v_vault_name,
      'Orbit OS organization-owned OpenRouter credential',
      null
    );
  end if;

  insert into public.organization_ai_provider_credentials (
    organization_id, provider, model,
    input_cost_per_million_usd, output_cost_per_million_usd, monthly_budget_usd,
    status, last_error_code, configured_by, configured_at, last_rotated_at, revoked_at
  ) values (
    p_organization_id, 'OPENROUTER', btrim(p_model),
    p_input_cost_per_million_usd, p_output_cost_per_million_usd, p_monthly_budget_usd,
    'ACTIVE', null, p_configured_by, now(), now(), null
  )
  on conflict (organization_id, provider) do update
  set model = excluded.model,
      input_cost_per_million_usd = excluded.input_cost_per_million_usd,
      output_cost_per_million_usd = excluded.output_cost_per_million_usd,
      monthly_budget_usd = excluded.monthly_budget_usd,
      status = 'ACTIVE',
      last_error_code = null,
      configured_by = excluded.configured_by,
      configured_at = now(),
      last_rotated_at = now(),
      revoked_at = null,
      updated_at = now()
  returning * into v_credential;

  insert into private.organization_ai_provider_secret_links (
    credential_id, vault_secret_id, updated_at
  ) values (
    v_credential.id, v_vault_secret_id, now()
  )
  on conflict (credential_id) do update
  set vault_secret_id = excluded.vault_secret_id,
      updated_at = now();

  return jsonb_build_object(
    'credentialId', v_credential.id,
    'provider', v_credential.provider,
    'model', v_credential.model,
    'status', v_credential.status,
    'configuredAt', v_credential.configured_at,
    'lastRotatedAt', v_credential.last_rotated_at
  );
end;
$$;

-- Service-only resolver. Keep it private and never forward its result to a
-- browser, job payload, database audit row, or public API response.
create or replace function private.resolve_organization_openrouter_credential(
  p_organization_id uuid
)
returns table (
  credential_id uuid,
  api_key text,
  model text,
  input_cost_per_million_usd numeric,
  output_cost_per_million_usd numeric,
  monthly_budget_usd numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public, private, vault
as $$
begin
  return query
  select
    credential.id,
    secret.decrypted_secret,
    credential.model,
    credential.input_cost_per_million_usd,
    credential.output_cost_per_million_usd,
    credential.monthly_budget_usd
  from public.organization_ai_provider_credentials as credential
  join private.organization_ai_provider_secret_links as link
    on link.credential_id = credential.id
  join vault.decrypted_secrets as secret
    on secret.id = link.vault_secret_id
  where credential.organization_id = p_organization_id
    and credential.provider = 'OPENROUTER'
    and credential.status = 'ACTIVE';
end;
$$;

-- PostgREST only exposes configured API schemas (normally `public`), while
-- the Node worker deliberately talks to Supabase through PostgREST RPC. This
-- narrow wrapper preserves that execution path without exposing the private
-- resolver or decrypted key to browser roles: it is executable by service_role
-- only and must never be proxied to a client response.
create or replace function public.resolve_organization_openrouter_credential_for_worker(
  p_organization_id uuid
)
returns table (
  credential_id uuid,
  api_key text,
  model text,
  input_cost_per_million_usd numeric,
  output_cost_per_million_usd numeric,
  monthly_budget_usd numeric
)
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select *
  from private.resolve_organization_openrouter_credential(p_organization_id);
$$;

-- Authenticated clients only receive sanitized configuration. The explicit
-- auth.uid() comparison closes the actor-parameter spoofing gap that applies
-- to service-role-oriented helper functions elsewhere in the schema.
create or replace function public.get_organization_openrouter_credential_status(
  p_organization_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
begin
  if auth.uid() is null or auth.uid() <> p_actor_id then
    raise exception using errcode = '42501', message = 'OPENROUTER_CREDENTIAL_ACTOR_FORBIDDEN';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_actor_id,
    array['owner', 'editor']::public.organization_role[]
  );

  select * into v_credential
  from public.organization_ai_provider_credentials
  where organization_id = p_organization_id
    and provider = 'OPENROUTER';

  if not found then
    return jsonb_build_object('configured', false, 'provider', 'OPENROUTER');
  end if;

  return jsonb_build_object(
    'configured', true,
    'provider', v_credential.provider,
    'model', v_credential.model,
    'status', v_credential.status,
    'inputCostPerMillionUsd', v_credential.input_cost_per_million_usd,
    'outputCostPerMillionUsd', v_credential.output_cost_per_million_usd,
    'monthlyBudgetUsd', v_credential.monthly_budget_usd,
    'configuredAt', v_credential.configured_at,
    'lastRotatedAt', v_credential.last_rotated_at,
    'revokedAt', v_credential.revoked_at
  );
end;
$$;

-- Service-only error/revocation transitions. Error values are intentionally
-- bounded codes, not provider response bodies, because responses can contain
-- customer data or credential-adjacent diagnostics.
create or replace function public.mark_organization_openrouter_credential_error(
  p_organization_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
begin
  if p_error_code is null
     or length(btrim(p_error_code)) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'OPENROUTER_CREDENTIAL_ERROR_CODE_INVALID';
  end if;

  update public.organization_ai_provider_credentials
  set status = 'ERROR', last_error_code = btrim(p_error_code), updated_at = now()
  where organization_id = p_organization_id
    and provider = 'OPENROUTER'
    and status <> 'REVOKED'
  returning * into v_credential;

  return jsonb_build_object('marked', found);
end;
$$;

create or replace function public.revoke_organization_openrouter_credential(
  p_organization_id uuid,
  p_revoked_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
begin
  if p_organization_id is null or p_revoked_by is null then
    raise exception using errcode = '22023', message = 'OPENROUTER_CREDENTIAL_REVOKE_INVALID_INPUT';
  end if;

  if not exists (
    select 1
    from public.organization_members as member
    where member.organization_id = p_organization_id
      and member.user_id = p_revoked_by
      and member.role = 'owner'::public.organization_role
  ) then
    raise exception using errcode = '42501', message = 'OPENROUTER_CREDENTIAL_OWNER_REQUIRED';
  end if;

  update public.organization_ai_provider_credentials
  set status = 'REVOKED',
      last_error_code = null,
      revoked_at = now(),
      updated_at = now()
  where organization_id = p_organization_id
    and provider = 'OPENROUTER'
    and status <> 'REVOKED'
  returning * into v_credential;

  return jsonb_build_object(
    'revoked', found,
    'provider', 'OPENROUTER',
    'revokedAt', v_credential.revoked_at
  );
end;
$$;

revoke all on function public.configure_organization_openrouter_credential(uuid, uuid, text, text, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function private.resolve_organization_openrouter_credential(uuid)
  from public, anon, authenticated;
revoke all on function public.resolve_organization_openrouter_credential_for_worker(uuid)
  from public, anon, authenticated;
revoke all on function public.get_organization_openrouter_credential_status(uuid, uuid)
  from public, anon;
revoke all on function public.mark_organization_openrouter_credential_error(uuid, text)
  from public, anon, authenticated;
revoke all on function public.revoke_organization_openrouter_credential(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.configure_organization_openrouter_credential(uuid, uuid, text, text, numeric, numeric, numeric)
  to service_role;
grant execute on function private.resolve_organization_openrouter_credential(uuid)
  to service_role;
grant execute on function public.resolve_organization_openrouter_credential_for_worker(uuid)
  to service_role;
grant execute on function public.get_organization_openrouter_credential_status(uuid, uuid)
  to authenticated;
grant execute on function public.mark_organization_openrouter_credential_error(uuid, text)
  to service_role;
grant execute on function public.revoke_organization_openrouter_credential(uuid, uuid)
  to service_role;

comment on table public.organization_ai_provider_credentials is
  'Sanitized per-organization AI provider configuration. The raw OpenRouter key is only in Supabase Vault.';
comment on table private.organization_ai_provider_secret_links is
  'Private linkage from AI provider configuration to encrypted Vault secrets. Never expose through client APIs.';
comment on function private.resolve_organization_openrouter_credential(uuid) is
  'Service-role-only resolver. Its decrypted API key result must never cross a browser or public API boundary.';
comment on function public.resolve_organization_openrouter_credential_for_worker(uuid) is
  'PostgREST-compatible service-role-only wrapper for the private resolver. Never proxy its decrypted API key result to a client.';
-- END 0031_organization_openrouter_byok_credentials.sql

-- BEGIN 0032_security_definer_grants.sql
-- 0032_security_definer_grants.sql
--
-- Trigger functions run because the trigger is attached to a table; they do
-- not need to be callable over PostgREST. Explicitly revoke the default
-- PUBLIC grants that otherwise make these SECURITY DEFINER functions RPCs.
-- Keep the organization membership helpers untouched: current RLS policies
-- deliberately depend on their authenticated execution grants.

revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function public.assign_organization_from_legacy_owner() from public, anon, authenticated;
revoke all on function public.prevent_last_organization_owner_removal() from public, anon, authenticated;
revoke all on function public.prevent_legacy_owner_id_mutation() from public, anon, authenticated;

-- This function was created by an earlier remote bootstrap and is absent
-- from the repository migrations. Guard the revoke so fresh installations
-- and already-provisioned projects share the same migration history.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

-- `is_owner_profile` is a legacy read helper. It remains executable for
-- authenticated compatibility paths, but is not an anonymous RPC.
revoke all on function public.is_owner_profile(uuid) from public, anon;
grant execute on function public.is_owner_profile(uuid) to authenticated, service_role;

-- Avoid per-row auth.uid() re-evaluation in the only profile policy.
drop policy if exists "Users read their profile" on public.profiles;
create policy "Users read their profile" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

-- The ALL policy already implies SELECT for owners, so this duplicate
-- permissive SELECT policy only adds planner work and linter noise.
drop policy if exists "Owners read organization integrations" on public.organization_integrations;
-- END 0032_security_definer_grants.sql
-- Canonical-only corrections from the production baseline audit (2026-10-05).
-- These functions are invoked only as triggers or internal schema helpers; they
-- must never be callable through PostgREST by anon or authenticated callers.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
revoke all on function public.assign_organization_from_legacy_owner() from public, anon, authenticated;
revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function public.prevent_last_organization_owner_removal() from public, anon, authenticated;
revoke all on function public.prevent_legacy_owner_id_mutation() from public, anon, authenticated;
revoke all on function public.is_owner_profile(uuid) from public, anon;
grant execute on function public.is_owner_profile(uuid) to authenticated, service_role;
