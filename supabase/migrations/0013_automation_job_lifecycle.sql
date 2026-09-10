-- Durable job lifecycle preparation only.
--
-- This migration has NOT been applied to a live Supabase project. It is an
-- additive schema step for a future portal-owned worker adapter and must be
-- applied only after staging has been verified against migrations 0001-0011.
-- The storage-neutral operation contract lives in
-- lib/automation/durable-job-contract.ts. No browser code or Meta publisher
-- calls this migration directly.

alter table public.automation_jobs
  add column if not exists provider text not null default 'local',
  add column if not exists run_at timestamptz not null default now(),
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists max_attempts integer not null default 3,
  add column if not exists last_error text,
  add column if not exists cancelled_at timestamptz;

-- Preserve any already-counted attempts before enforcing the new upper bound.
-- This is deterministic and does not create extra retries for existing rows.
update public.automation_jobs
set max_attempts = greatest(max_attempts, attempt_count)
where max_attempts < attempt_count;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automation_jobs'::regclass
      and conname = 'automation_jobs_provider_nonempty_check'
  ) then
    alter table public.automation_jobs
      add constraint automation_jobs_provider_nonempty_check
      check (length(btrim(provider)) > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automation_jobs'::regclass
      and conname = 'automation_jobs_attempts_bounds_check'
  ) then
    alter table public.automation_jobs
      add constraint automation_jobs_attempts_bounds_check
      check (attempt_count >= 0 and max_attempts > 0 and attempt_count <= max_attempts);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automation_jobs'::regclass
      and conname = 'automation_jobs_next_attempt_after_run_check'
  ) then
    alter table public.automation_jobs
      add constraint automation_jobs_next_attempt_after_run_check
      check (next_attempt_at >= run_at);
  end if;
end;
$$;

create index if not exists automation_jobs_organization_due_idx
  on public.automation_jobs (organization_id, status, next_attempt_at, created_at);

create index if not exists automation_jobs_organization_provider_due_idx
  on public.automation_jobs (organization_id, provider, status, next_attempt_at);

comment on table public.automation_jobs is
  'Portal-owned durable jobs. Lifecycle RPC adapter is staged separately; this migration is not live-applied.';
comment on column public.automation_jobs.provider is
  'Explicit server-side adapter key; never a URL or credential.';
comment on column public.automation_jobs.run_at is
  'Original schedule lower bound; retries use next_attempt_at.';
comment on column public.automation_jobs.next_attempt_at is
  'Mutable retry due time; must not precede run_at.';

-- The following RPCs are the durable-worker boundary. They are deliberately
-- service-only: tenant-facing requests enqueue work, while the worker owns
-- claim/lease mutations and never receives a caller-selected organization.
create function public.claim_next_copy_automation_job(
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
  item public.content_items%rowtype;
  asset public.assets%rowtype;
  token uuid := gen_random_uuid();
begin
  select queued.* into job
  from public.automation_jobs as queued
  where queued.kind = 'COPY'
    and (p_provider is null or queued.provider = p_provider)
    and (p_organization_id is null or queued.organization_id = p_organization_id)
    and queued.status in ('QUEUED', 'RETRY_WAIT')
    and queued.run_at <= now()
    and queued.next_attempt_at <= now()
    and not exists (
      select 1
      from public.automation_jobs as active
      where active.organization_id = queued.organization_id
        and active.kind = 'COPY'
        and active.status = 'PROCESSING'
        and active.lease_expires_at > now()
    )
  order by queued.next_attempt_at asc, queued.created_at asc
  limit 1
  for update skip locked;

  if not found then
    return jsonb_build_object('state', 'NOT_CLAIMABLE');
  end if;

  select * into item
  from public.content_items
  where id = job.content_item_id
    and organization_id = job.organization_id
  for update;
  if not found then
    update public.automation_jobs
    set status = 'FAILED',
        sanitized_error = 'COPY_JOB_CONTENT_NOT_FOUND',
        updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  select * into asset
  from public.assets
  where id = item.asset_id
    and organization_id = job.organization_id;
  if not found then
    update public.automation_jobs
    set status = 'FAILED',
        sanitized_error = 'COPY_JOB_ASSET_NOT_FOUND',
        updated_at = now()
    where id = job.id;
    return jsonb_build_object('state', 'FAILED', 'jobId', job.id);
  end if;

  update public.automation_jobs
  set status = 'PROCESSING',
      lease_token = token,
      lease_expires_at = now() + interval '10 minutes',
      claimed_at = coalesce(claimed_at, now()),
      attempt_count = attempt_count + 1,
      updated_at = now()
  where id = job.id;

  return jsonb_build_object(
    'state', 'CLAIMED',
    'job', jsonb_build_object(
      'id', job.id,
      'organizationId', job.organization_id,
      'kind', job.kind,
      'provider', job.provider,
      'idempotencyKey', job.idempotency_key,
      'leaseToken', token,
      'leaseExpiresAt', now() + interval '10 minutes',
      'contentItemId', item.id,
      'storagePath', asset.storage_path,
      'brief', jsonb_build_object(
        'businessLine', item.business_line,
        'service', item.service,
        'niche', item.niche,
        'contentType', item.content_type,
        'objective', item.objective,
        'format', item.format,
        'cta', item.cta,
        'humanDescription', item.human_description,
        'allowedFacts', item.allowed_facts
      ),
      'attempts', job.attempt_count + 1,
      'maxAttempts', job.max_attempts,
      'runAt', job.run_at,
      'nextAttemptAt', job.next_attempt_at,
      'createdAt', job.created_at,
      'updatedAt', now(),
      'startedAt', coalesce(job.claimed_at, now())
    )
  );
end;
$$;

create function public.renew_copy_automation_job(
  p_job_id uuid,
  p_idempotency_key uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 600
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
    raise exception using errcode = 'P0001', message = 'COPY_JOB_LEASE_DURATION_INVALID';
  end if;

  renewed_expires_at := now() + make_interval(secs => p_lease_seconds);
  update public.automation_jobs
  set lease_expires_at = renewed_expires_at,
      updated_at = now()
  where id = p_job_id
    and kind = 'COPY'
    and idempotency_key = p_idempotency_key
    and status = 'PROCESSING'
    and lease_token = p_lease_token
    and lease_expires_at > now();

  if not found then
    return jsonb_build_object('state', 'NOT_RENEWED');
  end if;
  return jsonb_build_object('state', 'RENEWED', 'leaseExpiresAt', renewed_expires_at);
end;
$$;

create function public.fail_copy_automation_job(
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

  return jsonb_build_object(
    'state', next_status,
    'jobId', job.id,
    'attempts', job.attempt_count,
    'nextAttemptAt', next_due
  );
end;
$$;

create function public.cancel_copy_automation_job(
  p_job_id uuid,
  p_idempotency_key uuid,
  p_lease_token uuid default null,
  p_reason text default 'Cancelled by operator'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  job public.automation_jobs%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_CANCEL_REASON_INVALID';
  end if;

  select * into job
  from public.automation_jobs
  where id = p_job_id
    and kind = 'COPY'
    and idempotency_key = p_idempotency_key
  for update;
  if not found then
    return jsonb_build_object('state', 'NOT_FOUND');
  end if;
  if job.status in ('COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTER') then
    return jsonb_build_object('state', 'NOT_CANCELLABLE', 'status', job.status);
  end if;
  if job.status = 'PROCESSING'
     and (p_lease_token is null or job.lease_token <> p_lease_token) then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_LEASE_INVALID';
  end if;

  update public.automation_jobs
  set status = 'CANCELLED',
      cancelled_at = now(),
      sanitized_error = left(btrim(p_reason), 500),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = job.id;
  return jsonb_build_object('state', 'CANCELLED', 'jobId', job.id);
end;
$$;

create function public.recover_expired_copy_automation_jobs(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  recovered_count integer := 0;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_RECOVERY_LIMIT_INVALID';
  end if;

  with expired as (
    select id, attempt_count, max_attempts
    from public.automation_jobs
    where kind = 'COPY'
      and status = 'PROCESSING'
      and lease_expires_at <= now()
    order by lease_expires_at asc
    for update skip locked
    limit p_limit
  )
  update public.automation_jobs as job
  set status = case
        when expired.attempt_count >= expired.max_attempts then 'DEAD_LETTER'::public.automation_job_status
        else 'RETRY_WAIT'::public.automation_job_status
      end,
      next_attempt_at = now(),
      sanitized_error = coalesce(job.sanitized_error, 'Lease expired before completion'),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  from expired
  where job.id = expired.id;

  get diagnostics recovered_count = row_count;
  return jsonb_build_object('recovered', recovered_count);
end;
$$;

create function public.summarize_copy_automation_jobs()
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
    'queueLagMs', coalesce(
      greatest(
        0,
        extract(epoch from (
          now() - (min(next_attempt_at) filter (
            where status in ('QUEUED', 'RETRY_WAIT') and next_attempt_at <= now()
          ))
        )) * 1000
      ),
      0
    ),
    'lastSuccessfulRun', max(completed_at) filter (where status = 'COMPLETED')
  )
  from public.automation_jobs
  where kind = 'COPY';
$$;

revoke all on function public.claim_next_copy_automation_job(text, uuid) from public, anon, authenticated;
revoke all on function public.renew_copy_automation_job(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.fail_copy_automation_job(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.cancel_copy_automation_job(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.recover_expired_copy_automation_jobs(integer) from public, anon, authenticated;
revoke all on function public.summarize_copy_automation_jobs() from public, anon, authenticated;
grant execute on function public.claim_next_copy_automation_job(text, uuid) to service_role;
grant execute on function public.renew_copy_automation_job(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.fail_copy_automation_job(uuid, uuid, uuid, text, boolean) to service_role;
grant execute on function public.cancel_copy_automation_job(uuid, uuid, uuid, text) to service_role;
grant execute on function public.recover_expired_copy_automation_jobs(integer) to service_role;
grant execute on function public.summarize_copy_automation_jobs() to service_role;
