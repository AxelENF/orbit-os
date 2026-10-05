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
