-- Durable portal-owned worker jobs. This migration has not been applied to a live project.
create type public.automation_job_status as enum ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  content_item_id uuid not null references public.content_items(id) on delete restrict,
  kind text not null check (kind = 'COPY'),
  status public.automation_job_status not null default 'QUEUED',
  idempotency_key uuid not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  payload_version integer not null default 1,
  result_payload jsonb,
  sanitized_error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, kind, idempotency_key)
);
create index automation_jobs_organization_status_created_idx on public.automation_jobs (organization_id, status, created_at);
alter table public.automation_jobs enable row level security;
create policy "Members read organization automation jobs" on public.automation_jobs for select to authenticated using (public.is_organization_member(organization_id));

-- The portal calls this with an organization and actor resolved from its own
-- authenticated session. It creates the durable job and state transition in
-- one transaction, before any n8n delivery attempt.
create function public.enqueue_copy_automation_job(
  p_organization_id uuid,
  p_actor_id uuid,
  p_content_item_id uuid,
  p_idempotency_key uuid
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
    jsonb_build_object('jobId', created_job.id, 'idempotencyKey', p_idempotency_key)
  );
  return jsonb_build_object(
    'created', true,
    'jobId', created_job.id,
    'idempotencyKey', created_job.idempotency_key
  );
end;
$$;

-- Only a service boundary executes these RPCs; the worker never receives org, owner, asset path, or brief from its webhook.
create function public.claim_copy_automation_job(p_job_id uuid, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare job public.automation_jobs%rowtype; item public.content_items%rowtype; asset public.assets%rowtype; token uuid := gen_random_uuid();
begin
  select * into job from public.automation_jobs where id = p_job_id and kind = 'COPY' and idempotency_key = p_idempotency_key for update;
  if not found then return jsonb_build_object('state','NOT_CLAIMABLE'); end if;
  if job.status = 'PROCESSING' and job.lease_expires_at > now() then return jsonb_build_object('state','NOT_CLAIMABLE'); end if;
  if job.status not in ('QUEUED','PROCESSING'::public.automation_job_status) then return jsonb_build_object('state','NOT_CLAIMABLE'); end if;
  select * into item from public.content_items where id = job.content_item_id and organization_id = job.organization_id;
  select * into asset from public.assets where id = item.asset_id and organization_id = job.organization_id;
  if not found then raise exception using errcode='P0001', message='COPY_JOB_ASSET_NOT_FOUND'; end if;
  update public.automation_jobs set status='PROCESSING', lease_token=token, lease_expires_at=now() + interval '10 minutes', claimed_at=now(), attempt_count=attempt_count+1, updated_at=now() where id=job.id;
  return jsonb_build_object('state','CLAIMED','job',jsonb_build_object('id',job.id,'idempotencyKey',job.idempotency_key,'leaseToken',token,'leaseExpiresAt',now() + interval '10 minutes','contentItemId',item.id,'storagePath',asset.storage_path,'brief',jsonb_build_object('businessLine',item.business_line,'service',item.service,'niche',item.niche,'contentType',item.content_type,'objective',item.objective,'format',item.format,'cta',item.cta,'humanDescription',item.human_description,'allowedFacts',item.allowed_facts)));
end; $$;

create function public.complete_copy_automation_job(p_job_id uuid, p_idempotency_key uuid, p_lease_token uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare job public.automation_jobs%rowtype; callback_result jsonb;
begin
  select * into job from public.automation_jobs where id=p_job_id and kind='COPY' and idempotency_key=p_idempotency_key for update;
  if not found then raise exception using errcode='P0001', message='COPY_JOB_NOT_FOUND'; end if;
  if job.status='COMPLETED' then return jsonb_build_object('created',false); end if;
  if job.status <> 'PROCESSING' or job.lease_token <> p_lease_token or job.lease_expires_at <= now() then raise exception using errcode='P0001', message='COPY_JOB_LEASE_INVALID'; end if;
  select public.ingest_copy_result_callback(job.content_item_id, job.idempotency_key, p_result->'visualAnalysis', p_result->'drafts', coalesce(p_result->'warnings','[]'::jsonb), p_result->>'provider', p_result->>'model') into callback_result;
  update public.automation_jobs set status='COMPLETED', result_payload=p_result, completed_at=now(), lease_token=null, lease_expires_at=null, updated_at=now() where id=job.id;
  return jsonb_build_object('created',coalesce((callback_result->>'created')::boolean,false));
end; $$;

revoke all on function public.claim_copy_automation_job(uuid,uuid) from public, anon, authenticated;
revoke all on function public.complete_copy_automation_job(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.enqueue_copy_automation_job(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_copy_automation_job(uuid,uuid) to service_role;
grant execute on function public.complete_copy_automation_job(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.enqueue_copy_automation_job(uuid,uuid,uuid,uuid) to service_role;
