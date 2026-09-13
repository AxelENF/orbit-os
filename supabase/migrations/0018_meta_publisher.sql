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
  page_access_token text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED', 'ERROR')),
  constraint organization_meta_connections_token_nonempty_when_active
    check (status <> 'ACTIVE' or length(btrim(page_access_token)) > 0),
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
  connection public.organization_meta_connections%rowtype;
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

  select * into connection
  from public.organization_meta_connections
  where organization_id = job.organization_id and status = 'ACTIVE';
  if not found then
    perform public.fail_claim_publish_job(job.id, job.publication_target_id, job.organization_id, 'PUBLISH_JOB_CONNECTION_NOT_FOUND');
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;
  if target.platform = 'INSTAGRAM' and connection.instagram_business_account_id is null then
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
