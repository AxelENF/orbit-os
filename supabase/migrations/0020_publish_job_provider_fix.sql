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
