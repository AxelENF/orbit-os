-- Campaign context and immutable copy selection are required before a human
-- can move an asset into review. Legacy items intentionally remain readable.
alter table public.content_items
  add column if not exists campaign_name text,
  add column if not exists offer text,
  add column if not exists funnel_stage text,
  add column if not exists destination text,
  add column if not exists destination_value text,
  add column if not exists campaign_code text;

alter table public.content_items
  add constraint content_items_campaign_fields_complete
  check (
    (campaign_name is null and offer is null and funnel_stage is null
      and destination is null and destination_value is null and campaign_code is null)
    or
    (length(trim(campaign_name)) > 0 and length(trim(offer)) > 0
      and funnel_stage in ('descubrimiento', 'consideracion', 'captacion', 'reactivacion')
      and destination in ('whatsapp', 'landing_page', 'lead_form')
      and length(trim(destination_value)) > 0 and length(trim(campaign_code)) > 0)
  );

create unique index if not exists content_items_campaign_code_unique
  on public.content_items (campaign_code)
  where campaign_code is not null;

create table public.final_copy_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  content_item_id uuid not null references public.content_items(id) on delete restrict,
  selected_copy_draft_id uuid references public.copy_drafts(id) on delete set null,
  headline text not null check (length(trim(headline)) > 0),
  body text not null check (length(trim(body)) > 0),
  cta text not null check (length(trim(cta)) > 0),
  checksum text not null unique,
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  unique (content_item_id, version)
);

alter table public.content_items
  add column if not exists selected_final_copy_id uuid
  references public.final_copy_versions(id) on delete restrict;

create function public.assert_final_copy_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.content_items item
    where item.id = new.content_item_id and item.owner_id = new.owner_id
  ) then
    raise exception 'Final copy owner must match content item owner';
  end if;
  return new;
end;
$$;

create function public.reject_final_copy_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Final copy versions are immutable: % is not allowed', tg_op;
end;
$$;

create trigger assert_final_copy_owner
  before insert on public.final_copy_versions
  for each row execute function public.assert_final_copy_owner();
create trigger prevent_final_copy_mutation
  before update or delete on public.final_copy_versions
  for each row execute function public.reject_final_copy_mutation();

alter table public.final_copy_versions enable row level security;
create policy "Users read their final copy versions" on public.final_copy_versions
  for select to authenticated using (auth.uid() = owner_id);

create function public.submit_final_copy_for_review(
  p_owner_id uuid,
  p_content_item_id uuid,
  p_selected_copy_draft_id uuid,
  p_headline text,
  p_body text,
  p_cta text,
  p_checksum text
)
returns public.final_copy_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.content_items;
  created_copy public.final_copy_versions;
  next_version integer;
begin
  if not public.is_owner_profile(p_owner_id) then
    raise exception using errcode = 'P0001', message = 'FINAL_COPY_SUBMISSION_NOT_OWNER';
  end if;

  select * into item
  from public.content_items
  where id = p_content_item_id and owner_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'FINAL_COPY_CONTENT_NOT_FOUND';
  end if;
  if item.state <> 'DRAFT' then
    raise exception using errcode = 'P0001', message = 'FINAL_COPY_SUBMISSION_INVALID_STATE';
  end if;
  if item.campaign_code is null then
    raise exception using errcode = 'P0001', message = 'FINAL_COPY_CAMPAIGN_REQUIRED';
  end if;
  if p_selected_copy_draft_id is not null and not exists (
    select 1 from public.copy_drafts draft
    where draft.id = p_selected_copy_draft_id
      and draft.content_item_id = p_content_item_id
      and draft.owner_id = p_owner_id
  ) then
    raise exception using errcode = 'P0001', message = 'FINAL_COPY_DRAFT_MISMATCH';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.final_copy_versions
  where content_item_id = p_content_item_id;

  insert into public.final_copy_versions (
    owner_id, content_item_id, selected_copy_draft_id, headline, body, cta,
    checksum, version
  ) values (
    p_owner_id, p_content_item_id, p_selected_copy_draft_id, p_headline,
    p_body, p_cta, p_checksum, next_version
  ) returning * into created_copy;

  update public.content_items
  set selected_final_copy_id = created_copy.id, state = 'REVIEW'
  where id = p_content_item_id and owner_id = p_owner_id;

  insert into public.audit_events (
    owner_id, actor_id, content_item_id, event_type, metadata
  ) values (
    p_owner_id, p_owner_id, p_content_item_id, 'FINAL_COPY_SUBMITTED',
    jsonb_build_object('finalCopyId', created_copy.id, 'version', next_version)
  );

  return created_copy;
end;
$$;

create function public.create_campaign_item_with_asset(
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
  p_allowed_facts jsonb,
  p_campaign_name text,
  p_offer text,
  p_funnel_stage text,
  p_destination text,
  p_destination_value text,
  p_campaign_code text
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
    id, owner_id, bucket_id, storage_path, filename, mime_type, width, height, checksum
  ) values (
    p_asset_id, p_owner_id, 'content-assets', p_storage_path, p_filename,
    p_mime_type, p_width, p_height, p_checksum
  );

  insert into public.content_items (
    owner_id, asset_id, business_line, service, niche, content_type, objective,
    format, cta, human_description, allowed_facts, state, campaign_name, offer,
    funnel_stage, destination, destination_value, campaign_code
  ) values (
    p_owner_id, p_asset_id, p_business_line, p_service, p_niche, p_content_type,
    p_objective, p_format, p_cta, p_human_description, p_allowed_facts, 'UPLOADED',
    p_campaign_name, p_offer, p_funnel_stage, p_destination, p_destination_value,
    p_campaign_code
  ) returning * into created_item;

  insert into public.publication_targets (owner_id, content_item_id, platform, status)
  values
    (p_owner_id, created_item.id, 'FACEBOOK', 'PENDING_REVIEW'),
    (p_owner_id, created_item.id, 'INSTAGRAM', 'PENDING_REVIEW');

  insert into public.audit_events (owner_id, actor_id, content_item_id, event_type, metadata)
  values (
    p_owner_id, p_owner_id, created_item.id, 'CONTENT_CREATED',
    jsonb_build_object('assetId', p_asset_id, 'campaignCode', p_campaign_code)
  );

  return created_item;
end;
$$;

revoke all on function public.submit_final_copy_for_review(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_final_copy_for_review(uuid, uuid, uuid, text, text, text, text)
  to service_role;
revoke all on function public.create_campaign_item_with_asset(
  uuid, uuid, text, text, text, integer, integer, text, text, text, text, text,
  text, text, text, text, jsonb, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_campaign_item_with_asset(
  uuid, uuid, text, text, text, integer, integer, text, text, text, text, text,
  text, text, text, text, jsonb, text, text, text, text, text, text
) to service_role;
