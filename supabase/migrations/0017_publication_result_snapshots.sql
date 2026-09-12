-- Append-only human-entered outcomes for a delivered social post. The portal
-- records observed figures; it does not infer attribution or spend.

create table public.publication_result_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  content_item_id uuid not null references public.content_items(id) on delete restrict,
  publication_target_id uuid not null references public.publication_targets(id) on delete restrict,
  idempotency_key uuid not null,
  observed_at timestamptz not null,
  reach integer not null default 0 check (reach >= 0),
  impressions integer not null default 0 check (impressions >= 0),
  conversations integer not null default 0 check (conversations >= 0),
  qualified_leads integer not null default 0 check (qualified_leads >= 0),
  appointments integer not null default 0 check (appointments >= 0),
  spend_mxn numeric(12,2) not null default 0 check (spend_mxn >= 0),
  revenue_mxn numeric(12,2) check (revenue_mxn is null or revenue_mxn >= 0),
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index publication_result_snapshots_organization_content_observed_idx
  on public.publication_result_snapshots (organization_id, content_item_id, observed_at desc);
create index publication_result_snapshots_target_observed_idx
  on public.publication_result_snapshots (publication_target_id, observed_at desc);

alter table public.publication_result_snapshots enable row level security;
create policy "Organization members read publication result snapshots"
  on public.publication_result_snapshots
  for select to authenticated
  using (public.is_organization_member(organization_id));

create function public.record_publication_result(
  p_organization_id uuid,
  p_owner_id uuid,
  p_content_item_id uuid,
  p_publication_target_id uuid,
  p_observed_at timestamptz,
  p_reach integer,
  p_impressions integer,
  p_conversations integer,
  p_qualified_leads integer,
  p_appointments integer,
  p_spend_mxn numeric,
  p_revenue_mxn numeric,
  p_note text,
  p_idempotency_key uuid
)
returns public.publication_result_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.content_items;
  target public.publication_targets;
  prior_result public.publication_result_snapshots;
  created_result public.publication_result_snapshots;
begin
  if p_observed_at is null
     or p_reach is null or p_reach < 0
     or p_impressions is null or p_impressions < 0
     or p_conversations is null or p_conversations < 0
     or p_qualified_leads is null or p_qualified_leads < 0
     or p_appointments is null or p_appointments < 0
     or p_spend_mxn is null or p_spend_mxn < 0
     or p_revenue_mxn is not null and p_revenue_mxn < 0
     or p_note is not null and (length(p_note) > 1000 or nullif(btrim(p_note), '') is null) then
    raise exception using errcode = '22023', message = 'PUBLICATION_RESULT_INVALID_INPUT';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_owner_id,
    array['owner', 'editor']::public.organization_role[]
  );

  select * into prior_result
  from public.publication_result_snapshots
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;
  if found then
    if prior_result.content_item_id <> p_content_item_id
       or prior_result.publication_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'PUBLICATION_RESULT_IDEMPOTENCY_KEY_REUSED';
    end if;
    return prior_result;
  end if;

  select * into item
  from public.content_items
  where id = p_content_item_id
    and organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PUBLICATION_RESULT_CONTENT_NOT_FOUND';
  end if;

  -- Repeat the idempotency lookup after the content lock for uncertain
  -- responses that race another submission of the same snapshot.
  select * into prior_result
  from public.publication_result_snapshots
  where organization_id = p_organization_id
    and idempotency_key = p_idempotency_key;
  if found then
    if prior_result.content_item_id <> p_content_item_id
       or prior_result.publication_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'PUBLICATION_RESULT_IDEMPOTENCY_KEY_REUSED';
    end if;
    return prior_result;
  end if;

  select * into target
  from public.publication_targets
  where id = p_publication_target_id
    and content_item_id = p_content_item_id
    and organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PUBLICATION_RESULT_TARGET_NOT_FOUND';
  end if;
  if target.status <> 'PUBLISHED' then
    raise exception using errcode = 'P0001', message = 'PUBLICATION_RESULT_TARGET_NOT_PUBLISHED';
  end if;

  insert into public.publication_result_snapshots (
    organization_id, owner_id, actor_id, content_item_id, publication_target_id,
    idempotency_key, observed_at, reach, impressions, conversations,
    qualified_leads, appointments, spend_mxn, revenue_mxn, note
  ) values (
    p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    p_publication_target_id, p_idempotency_key, p_observed_at, p_reach,
    p_impressions, p_conversations, p_qualified_leads, p_appointments,
    p_spend_mxn, p_revenue_mxn, nullif(btrim(p_note), '')
  ) returning * into created_result;

  insert into public.audit_events (
    organization_id, owner_id, actor_id, content_item_id,
    publication_target_id, event_type, metadata
  ) values (
    p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    target.id, 'PUBLICATION_RESULT_RECORDED',
    jsonb_build_object(
      'platform', target.platform,
      'source', 'manual',
      'snapshotId', created_result.id,
      'observedAt', p_observed_at
    )
  );

  return created_result;
end;
$$;

revoke all on function public.record_publication_result(
  uuid, uuid, uuid, uuid, timestamptz, integer, integer, integer, integer,
  integer, numeric, numeric, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_publication_result(
  uuid, uuid, uuid, uuid, timestamptz, integer, integer, integer, integer,
  integer, numeric, numeric, text, uuid
) to service_role;
