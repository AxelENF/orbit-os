-- Tenantize existing Content OS data after 0008. This migration is not a claim
-- that it has been applied to any live Supabase project.

alter table public.assets add column if not exists organization_id uuid references public.organizations(id);
alter table public.content_items add column if not exists organization_id uuid references public.organizations(id);
alter table public.copy_drafts add column if not exists organization_id uuid references public.organizations(id);
alter table public.final_copy_versions add column if not exists organization_id uuid references public.organizations(id);
alter table public.publication_targets add column if not exists organization_id uuid references public.organizations(id);
alter table public.automation_runs add column if not exists organization_id uuid references public.organizations(id);
alter table public.audit_events add column if not exists organization_id uuid references public.organizations(id);

-- The 0008 backfill gives each historic owner a stable organization id equal to
-- its owner id. Keep owner_id as creator/audit history; do not rename or drop it.
update public.assets as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;
update public.content_items as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;
update public.copy_drafts as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;
update public.final_copy_versions as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;
update public.publication_targets as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;
update public.automation_runs as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;
update public.audit_events as item set organization_id = organization.id
from public.organizations as organization
where item.organization_id is null and item.owner_id = organization.legacy_owner_id;

alter table public.assets alter column organization_id set not null;
alter table public.content_items alter column organization_id set not null;
alter table public.copy_drafts alter column organization_id set not null;
alter table public.final_copy_versions alter column organization_id set not null;
alter table public.publication_targets alter column organization_id set not null;
alter table public.automation_runs alter column organization_id set not null;
alter table public.audit_events alter column organization_id set not null;

create index if not exists assets_organization_id_idx on public.assets (organization_id, id);
create index if not exists content_items_organization_created_at_idx on public.content_items (organization_id, created_at desc);
create index if not exists copy_drafts_organization_content_item_id_idx on public.copy_drafts (organization_id, content_item_id, revision);
create index if not exists final_copy_versions_organization_content_item_id_idx on public.final_copy_versions (organization_id, content_item_id, version desc);
create index if not exists publication_targets_organization_content_item_id_idx on public.publication_targets (organization_id, content_item_id, platform);
create index if not exists automation_runs_organization_content_item_id_idx on public.automation_runs (organization_id, content_item_id, created_at desc);
create index if not exists audit_events_organization_content_item_id_idx on public.audit_events (organization_id, content_item_id, created_at);

-- Retains compatibility for prior service-only RPCs while ensuring every future
-- row receives the organization associated with its immutable legacy owner.
create or replace function public.assign_organization_from_legacy_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.organization_id is null then
    select organization.id into new.organization_id
    from public.organizations as organization
    where organization.legacy_owner_id = new.owner_id;
  end if;
  if new.organization_id is null then
    raise exception using errcode = '23514', message = 'ORGANIZATION_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists assets_assign_organization on public.assets;
create trigger assets_assign_organization before insert on public.assets
  for each row execute function public.assign_organization_from_legacy_owner();
drop trigger if exists content_items_assign_organization on public.content_items;
create trigger content_items_assign_organization before insert on public.content_items
  for each row execute function public.assign_organization_from_legacy_owner();
drop trigger if exists copy_drafts_assign_organization on public.copy_drafts;
create trigger copy_drafts_assign_organization before insert on public.copy_drafts
  for each row execute function public.assign_organization_from_legacy_owner();
drop trigger if exists final_copy_versions_assign_organization on public.final_copy_versions;
create trigger final_copy_versions_assign_organization before insert on public.final_copy_versions
  for each row execute function public.assign_organization_from_legacy_owner();
drop trigger if exists publication_targets_assign_organization on public.publication_targets;
create trigger publication_targets_assign_organization before insert on public.publication_targets
  for each row execute function public.assign_organization_from_legacy_owner();
drop trigger if exists automation_runs_assign_organization on public.automation_runs;
create trigger automation_runs_assign_organization before insert on public.automation_runs
  for each row execute function public.assign_organization_from_legacy_owner();
drop trigger if exists audit_events_assign_organization on public.audit_events;
create trigger audit_events_assign_organization before insert on public.audit_events
  for each row execute function public.assign_organization_from_legacy_owner();

create or replace function public.assert_organization_actor(
  p_organization_id uuid,
  p_user_id uuid,
  p_roles public.organization_role[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if not exists (
    select 1 from public.organization_members as member
    where member.organization_id = p_organization_id
      and member.user_id = p_user_id
      and member.role = any(p_roles)
  ) then
    raise exception using errcode = '42501', message = 'ORGANIZATION_ACTOR_FORBIDDEN';
  end if;
end;
$$;

-- New overload used by the portal repository. The supplied actor is derived by
-- the server from its session/membership context, never from a request body.
create or replace function public.create_content_item_with_targets(
  p_organization_id uuid,
  p_owner_id uuid,
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
set search_path = pg_catalog
as $$
declare
  created_item public.content_items;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );
  insert into public.content_items (
    organization_id, owner_id, business_line, service, niche, content_type,
    objective, format, cta, human_description, allowed_facts, state
  ) values (
    p_organization_id, p_owner_id, p_business_line, p_service, p_niche,
    p_content_type, p_objective, p_format, p_cta, p_human_description,
    p_allowed_facts, 'DRAFT'
  ) returning * into created_item;
  insert into public.publication_targets (organization_id, owner_id, content_item_id, platform, status)
  values
    (p_organization_id, p_owner_id, created_item.id, 'FACEBOOK', 'PENDING_REVIEW'),
    (p_organization_id, p_owner_id, created_item.id, 'INSTAGRAM', 'PENDING_REVIEW');
  insert into public.audit_events (organization_id, owner_id, actor_id, content_item_id, event_type, metadata)
  values (p_organization_id, p_owner_id, p_owner_id, created_item.id, 'CONTENT_CREATED', '{}'::jsonb);
  return created_item;
end;
$$;

-- One asset RPC covers both ordinary and campaign content. Campaign parameters
-- are either all null or all present, matching the existing table constraint.
create or replace function public.create_content_item_with_asset_in_organization(
  p_organization_id uuid, p_owner_id uuid, p_asset_id uuid, p_storage_path text,
  p_filename text, p_mime_type text, p_width integer, p_height integer,
  p_checksum text, p_business_line text, p_service text, p_niche text,
  p_content_type text, p_objective text, p_format text, p_cta text,
  p_human_description text, p_allowed_facts jsonb, p_campaign_name text,
  p_offer text, p_funnel_stage text, p_destination text,
  p_destination_value text, p_campaign_code text
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
    jsonb_build_object('assetId', p_asset_id, 'campaignCode', p_campaign_code)
  );
  return created_item;
end;
$$;

create or replace function public.submit_final_copy_for_review(
  p_organization_id uuid, p_owner_id uuid, p_content_item_id uuid,
  p_selected_copy_draft_id uuid, p_headline text, p_body text, p_cta text,
  p_checksum text
)
returns public.final_copy_versions
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  item public.content_items;
  created_copy public.final_copy_versions;
  next_version integer;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );
  select * into item from public.content_items as content
  where content.id = p_content_item_id and content.organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0001', message = 'FINAL_COPY_CONTENT_NOT_FOUND'; end if;
  if item.state <> 'DRAFT' then raise exception using errcode = 'P0001', message = 'FINAL_COPY_SUBMISSION_INVALID_STATE'; end if;
  if item.campaign_code is null then raise exception using errcode = 'P0001', message = 'FINAL_COPY_CAMPAIGN_REQUIRED'; end if;
  if p_selected_copy_draft_id is not null and not exists (
    select 1 from public.copy_drafts as draft
    where draft.id = p_selected_copy_draft_id
      and draft.content_item_id = p_content_item_id
      and draft.organization_id = p_organization_id
  ) then raise exception using errcode = 'P0001', message = 'FINAL_COPY_DRAFT_MISMATCH'; end if;
  select coalesce(max(version), 0) + 1 into next_version
  from public.final_copy_versions as copy where copy.content_item_id = p_content_item_id;
  insert into public.final_copy_versions (
    organization_id, owner_id, content_item_id, selected_copy_draft_id, headline,
    body, cta, checksum, version
  ) values (
    p_organization_id, item.owner_id, p_content_item_id, p_selected_copy_draft_id,
    p_headline, p_body, p_cta, p_checksum, next_version
  ) returning * into created_copy;
  update public.content_items set selected_final_copy_id = created_copy.id, state = 'REVIEW'
  where id = p_content_item_id and organization_id = p_organization_id;
  insert into public.audit_events (organization_id, owner_id, actor_id, content_item_id, event_type, metadata)
  values (p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    'FINAL_COPY_SUBMITTED', jsonb_build_object('finalCopyId', created_copy.id, 'version', next_version));
  return created_copy;
end;
$$;

create or replace function public.approve_publication_target(
  p_organization_id uuid, p_owner_id uuid, p_content_item_id uuid,
  p_publication_target_id uuid
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
    p_organization_id, p_owner_id,
    array['owner', 'reviewer']::public.organization_role[]
  );
  select * into item from public.content_items as content
  where content.id = p_content_item_id and content.organization_id = p_organization_id
  for update;
  if not found or item.state <> 'REVIEW' then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_REVIEWABLE';
  end if;
  select * into target from public.publication_targets as publication_target
  where publication_target.id = p_publication_target_id
    and publication_target.content_item_id = p_content_item_id
    and publication_target.organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0001', message = 'TARGET_NOT_FOUND'; end if;
  if target.status not in ('PENDING_REVIEW', 'APPROVED') then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_REVIEWABLE';
  end if;
  if target.status = 'APPROVED' then return target; end if;
  update public.publication_targets set status = 'APPROVED'::public.publication_status
  where id = target.id and organization_id = p_organization_id returning * into approved_target;
  insert into public.audit_events (
    organization_id, owner_id, actor_id, content_item_id, publication_target_id,
    event_type, metadata
  ) values (
    p_organization_id, item.owner_id, p_owner_id, p_content_item_id, target.id,
    'TARGET_APPROVED', jsonb_build_object('platform', target.platform)
  );
  select count(*) into remaining_pending from public.publication_targets as publication_target
  where publication_target.content_item_id = p_content_item_id
    and publication_target.organization_id = p_organization_id
    and publication_target.status <> 'APPROVED';
  if remaining_pending = 0 then
    update public.content_items set state = 'APPROVED'::public.content_state
    where id = p_content_item_id and organization_id = p_organization_id and state = 'REVIEW';
  end if;
  return approved_target;
end;
$$;

revoke all on function public.assert_organization_actor(uuid, uuid, public.organization_role[]) from public, anon, authenticated;
revoke all on function public.create_content_item_with_targets(uuid, uuid, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.create_content_item_with_asset_in_organization(uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.submit_final_copy_for_review(uuid, uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.approve_publication_target(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_content_item_with_targets(uuid, uuid, text, text, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.create_content_item_with_asset_in_organization(uuid, uuid, uuid, text, text, text, integer, integer, text, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, text) to service_role;
grant execute on function public.submit_final_copy_for_review(uuid, uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.approve_publication_target(uuid, uuid, uuid, uuid) to service_role;

drop policy if exists "Users read their assets" on public.assets;
drop policy if exists "Users upload their assets" on public.assets;
drop policy if exists "Users read their content" on public.content_items;
drop policy if exists "Users create uploaded content" on public.content_items;
drop policy if exists "Users read their copy drafts" on public.copy_drafts;
drop policy if exists "Users read their final copy versions" on public.final_copy_versions;
drop policy if exists "Users read their publication targets" on public.publication_targets;
drop policy if exists "Users read their automation runs" on public.automation_runs;
drop policy if exists "Users read their audit events" on public.audit_events;
create policy "Organization members read assets" on public.assets
  for select to authenticated using (public.is_organization_member(organization_id));
create policy "Organization members read content" on public.content_items
  for select to authenticated using (public.is_organization_member(organization_id));
create policy "Organization members read copy drafts" on public.copy_drafts
  for select to authenticated using (public.is_organization_member(organization_id));
create policy "Organization members read final copies" on public.final_copy_versions
  for select to authenticated using (public.is_organization_member(organization_id));
create policy "Organization members read publication targets" on public.publication_targets
  for select to authenticated using (public.is_organization_member(organization_id));
create policy "Organization members read automation runs" on public.automation_runs
  for select to authenticated using (public.is_organization_member(organization_id));
create policy "Organization members read audit events" on public.audit_events
  for select to authenticated using (public.is_organization_member(organization_id));

drop policy if exists "Authenticated owners read content assets" on storage.objects;
drop policy if exists "Authenticated owners upload content assets" on storage.objects;
create policy "Organization members read content assets" on storage.objects
  for select to authenticated using (
    bucket_id = 'content-assets'
    and public.is_organization_member((storage.foldername(name))[1]::uuid)
    and exists (
      select 1 from public.assets as asset
      where asset.organization_id = (storage.foldername(name))[1]::uuid
        and asset.id = (storage.foldername(name))[2]::uuid
    )
  );
create policy "Organization owners upload content assets" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'content-assets'
    and public.has_organization_role(
      (storage.foldername(name))[1]::uuid,
      array['owner', 'editor']::public.organization_role[]
    )
    and (storage.foldername(name))[2]::uuid is not null
  );
