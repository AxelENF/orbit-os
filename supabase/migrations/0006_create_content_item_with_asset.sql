-- Atomically register an already-uploaded private asset and its content item.
-- Storage upload is compensated by the server if this RPC fails.
create function public.create_content_item_with_asset(
  p_owner_id uuid,
  p_asset_id uuid,
  p_storage_path text,
  p_filename text,
  p_mime_type text,
  p_width integer,
  p_height integer,
  p_checksum text,
  p_business_line text,
  p_service text,
  p_niche text,
  p_content_type text,
  p_objective text,
  p_format text,
  p_cta text,
  p_human_description text,
  p_allowed_facts jsonb
)
returns public.content_items
language plpgsql
security definer
set search_path = public
as $$
declare
  created_item public.content_items;
begin
  if not public.is_owner_profile(p_owner_id) then
    raise exception using errcode = 'P0001', message = 'Only an owner profile can create content';
  end if;
  if exists (select 1 from public.assets where id = p_asset_id) then
    raise exception using errcode = 'P0001', message = 'ASSET_ID_ALREADY_EXISTS';
  end if;

  insert into public.assets (
    id, owner_id, bucket_id, storage_path, filename, mime_type,
    width, height, checksum
  ) values (
    p_asset_id, p_owner_id, 'content-assets', p_storage_path, p_filename,
    p_mime_type, p_width, p_height, p_checksum
  );

  insert into public.content_items (
    owner_id, asset_id, business_line, service, niche, content_type, objective,
    format, cta, human_description, allowed_facts, state
  ) values (
    p_owner_id, p_asset_id, p_business_line, p_service, p_niche, p_content_type,
    p_objective, p_format, p_cta, p_human_description, p_allowed_facts, 'UPLOADED'
  ) returning * into created_item;

  insert into public.publication_targets (
    owner_id, content_item_id, platform, status
  ) values
    (p_owner_id, created_item.id, 'FACEBOOK', 'PENDING_REVIEW'),
    (p_owner_id, created_item.id, 'INSTAGRAM', 'PENDING_REVIEW');

  insert into public.audit_events (
    owner_id, actor_id, content_item_id, event_type, metadata
  ) values (
    p_owner_id, p_owner_id, created_item.id, 'CONTENT_CREATED',
    jsonb_build_object('assetId', p_asset_id, 'mimeType', p_mime_type)
  );

  return created_item;
end;
$$;

revoke all on function public.create_content_item_with_asset(
  uuid, uuid, text, text, text, integer, integer, text, text, text, text, text,
  text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_content_item_with_asset(
  uuid, uuid, text, text, text, integer, integer, text, text, text, text, text,
  text, text, text, text, jsonb
) to service_role;
