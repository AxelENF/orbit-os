-- Approve one destination after human review. The owner is supplied only by
-- the authenticated server route; the database still enforces the ownership
-- and REVIEW-state checks inside one locked transaction.
create function public.approve_publication_target(
  p_owner_id uuid,
  p_content_item_id uuid,
  p_publication_target_id uuid
)
returns public.publication_targets
language plpgsql
security definer
set search_path = public
as $$
declare
  item_state public.content_state;
  target public.publication_targets;
  approved_target public.publication_targets;
  remaining_pending integer;
begin
  select state
  into item_state
  from public.content_items
  where id = p_content_item_id
    and owner_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_REVIEWABLE';
  end if;
  if item_state <> 'REVIEW' then
    raise exception using errcode = 'P0001', message = 'CONTENT_NOT_REVIEWABLE';
  end if;

  select *
  into target
  from public.publication_targets
  where id = p_publication_target_id
    and content_item_id = p_content_item_id
    and owner_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_FOUND';
  end if;
  if target.status not in ('PENDING_REVIEW', 'APPROVED') then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_REVIEWABLE';
  end if;

  if target.status = 'APPROVED' then
    return target;
  end if;

  update public.publication_targets
  set status = 'APPROVED'::public.publication_status
  where id = target.id
  returning * into approved_target;

  insert into public.audit_events (
    owner_id,
    actor_id,
    content_item_id,
    publication_target_id,
    event_type,
    metadata
  ) values (
    p_owner_id,
    p_owner_id,
    p_content_item_id,
    target.id,
    'TARGET_APPROVED',
    jsonb_build_object('platform', target.platform)
  );

  select count(*)
  into remaining_pending
  from public.publication_targets
  where content_item_id = p_content_item_id
    and owner_id = p_owner_id
    and status <> 'APPROVED';

  if remaining_pending = 0 then
    update public.content_items
    set state = 'APPROVED'::public.content_state
    where id = p_content_item_id
      and owner_id = p_owner_id
      and state = 'REVIEW';
  end if;

  return approved_target;
end;
$$;

revoke all on function public.approve_publication_target(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.approve_publication_target(uuid, uuid, uuid)
to service_role;
