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
