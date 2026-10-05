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
