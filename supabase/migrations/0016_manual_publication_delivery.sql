-- Human-entered evidence for publications made directly in Facebook or Instagram.
-- This does not call Meta or imply that a provider action occurred.

create table public.manual_publication_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  content_item_id uuid not null references public.content_items(id) on delete restrict,
  publication_target_id uuid not null unique references public.publication_targets(id) on delete restrict,
  idempotency_key uuid not null,
  remote_url text not null check (remote_url ~ '^https?://'),
  published_at timestamptz not null,
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index manual_publication_deliveries_organization_content_idx
  on public.manual_publication_deliveries (organization_id, content_item_id, created_at desc);

alter table public.manual_publication_deliveries enable row level security;
create policy "Organization members read manual publication deliveries"
  on public.manual_publication_deliveries
  for select to authenticated
  using (public.is_organization_member(organization_id));

create function public.record_manual_publication_delivery(
  p_organization_id uuid,
  p_owner_id uuid,
  p_content_item_id uuid,
  p_publication_target_id uuid,
  p_remote_url text,
  p_published_at timestamptz,
  p_note text,
  p_idempotency_key uuid
)
returns public.publication_targets
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.content_items;
  target public.publication_targets;
  delivered_target public.publication_targets;
  prior_delivery public.manual_publication_deliveries;
  target_count integer;
  published_count integer;
begin
  if nullif(btrim(p_remote_url), '') is null
     or length(p_remote_url) > 2048
     or p_remote_url !~ '^https?://' then
    raise exception using errcode = '22023', message = 'MANUAL_DELIVERY_INVALID_REMOTE_URL';
  end if;
  if p_published_at is null then
    raise exception using errcode = '22023', message = 'MANUAL_DELIVERY_INVALID_PUBLISHED_AT';
  end if;
  if p_note is not null and (length(p_note) > 1000 or nullif(btrim(p_note), '') is null) then
    raise exception using errcode = '22023', message = 'MANUAL_DELIVERY_INVALID_NOTE';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );

  select * into prior_delivery
  from public.manual_publication_deliveries
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;

  if found then
    if prior_delivery.content_item_id <> p_content_item_id
       or prior_delivery.publication_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_IDEMPOTENCY_KEY_REUSED';
    end if;
    select * into delivered_target
    from public.publication_targets
    where id = p_publication_target_id
      and organization_id = p_organization_id;
    if not found or delivered_target.status <> 'PUBLISHED' then
      raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_ALREADY_RECORDED';
    end if;
    return delivered_target;
  end if;

  -- Lock the content item first so two manual delivery submissions cannot
  -- race each other into an inconsistent aggregate content state.
  select * into item
  from public.content_items
  where id = p_content_item_id
    and organization_id = p_organization_id
  for update;
  if not found or item.state <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_CONTENT_NOT_APPROVED';
  end if;

  -- The first lookup occurred before this transaction acquired the item
  -- lock. Check again now so a repeated request with the same key is truly
  -- idempotent even when its first response was lost in transit.
  select * into prior_delivery
  from public.manual_publication_deliveries
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;
  if found then
    if prior_delivery.content_item_id <> p_content_item_id
       or prior_delivery.publication_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_IDEMPOTENCY_KEY_REUSED';
    end if;
    select * into delivered_target
    from public.publication_targets
    where id = p_publication_target_id
      and organization_id = p_organization_id;
    if not found or delivered_target.status <> 'PUBLISHED' then
      raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_ALREADY_RECORDED';
    end if;
    return delivered_target;
  end if;

  select * into target
  from public.publication_targets
  where id = p_publication_target_id
    and content_item_id = p_content_item_id
    and organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_TARGET_NOT_FOUND';
  end if;
  if target.status <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = 'MANUAL_DELIVERY_TARGET_NOT_APPROVED';
  end if;

  insert into public.manual_publication_deliveries (
    organization_id, owner_id, actor_id, content_item_id,
    publication_target_id, idempotency_key, remote_url, published_at, note
  ) values (
    p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    p_publication_target_id, p_idempotency_key, btrim(p_remote_url),
    p_published_at, nullif(btrim(p_note), '')
  );

  update public.publication_targets
  set status = 'PUBLISHED'::public.publication_status,
      remote_url = btrim(p_remote_url),
      published_at = p_published_at,
      remote_post_id = null,
      last_error = null
  where id = target.id
    and organization_id = p_organization_id
  returning * into delivered_target;

  insert into public.audit_events (
    organization_id, owner_id, actor_id, content_item_id,
    publication_target_id, event_type, metadata
  ) values (
    p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    target.id, 'MANUAL_PUBLICATION_RECORDED',
    jsonb_build_object(
      'platform', target.platform,
      'source', 'manual',
      'publishedAt', p_published_at
    )
  );

  select count(*), count(*) filter (where status = 'PUBLISHED')
  into target_count, published_count
  from public.publication_targets
  where content_item_id = p_content_item_id
    and organization_id = p_organization_id;

  if target_count > 0 and target_count = published_count then
    update public.content_items
    set state = 'PUBLISHED'::public.content_state
    where id = p_content_item_id
      and organization_id = p_organization_id
      and state = 'APPROVED';
  end if;

  return delivered_target;
end;
$$;

revoke all on function public.record_manual_publication_delivery(
  uuid, uuid, uuid, uuid, text, timestamptz, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_manual_publication_delivery(
  uuid, uuid, uuid, uuid, text, timestamptz, text, uuid
) to service_role;
