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
  text, text, text, text, text, jsonb, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_content_item_with_asset_in_organization(
  uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, text,
  text, text, text, text, text, jsonb, text, text, text, text, text, jsonb
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
