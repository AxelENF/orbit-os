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

-- A legacy n8n request is still an in-flight publication until its callback
-- with the same target and idempotency key has been recorded. Keep the same
-- trigger name installed by 0022 and extend its guard in this additive
-- migration so manual evidence cannot race a real n8n delivery.
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
