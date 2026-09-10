-- Atomically create one copy request and move the item into GENERATING.
-- The owner is derived from the locked content item; it is never accepted from n8n.
create function public.prepare_copy_request(
  p_content_item_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.content_items;
  prior_content_item_id uuid;
  request_run_id uuid;
  prepared_item public.content_items;
begin
  select *
  into item
  from public.content_items
  where id = p_content_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_REQUEST_CONTENT_NOT_FOUND';
  end if;

  select content_item_id
  into prior_content_item_id
  from public.automation_runs
  where kind = 'COPY_REQUEST'
    and idempotency_key = p_idempotency_key;

  if found then
    if prior_content_item_id <> p_content_item_id then
      raise exception using errcode = 'P0001', message = 'COPY_REQUEST_IDEMPOTENCY_KEY_REUSED';
    end if;

    return jsonb_build_object(
      'created', false,
      'ownerId', item.owner_id,
      'contentItem', to_jsonb(item)
    );
  end if;

  if item.state not in ('DRAFT', 'UPLOADED', 'ERROR') then
    raise exception using errcode = 'P0001', message = 'COPY_REQUEST_INVALID_STATE';
  end if;

  update public.content_items
  set state = 'GENERATING'::public.content_state
  where id = p_content_item_id
  returning * into prepared_item;

  insert into public.automation_runs (
    owner_id,
    content_item_id,
    kind,
    idempotency_key,
    status,
    response_payload
  ) values (
    item.owner_id,
    p_content_item_id,
    'COPY_REQUEST',
    p_idempotency_key,
    'RECEIVED',
    jsonb_build_object('state', 'GENERATING')
  )
  returning id into request_run_id;

  insert into public.audit_events (
    owner_id,
    actor_id,
    content_item_id,
    event_type,
    metadata
  ) values (
    item.owner_id,
    item.owner_id,
    p_content_item_id,
    'COPY_REQUEST_QUEUED',
    jsonb_build_object('idempotencyKey', p_idempotency_key)
  );

  return jsonb_build_object(
    'created', request_run_id is not null,
    'ownerId', item.owner_id,
    'contentItem', to_jsonb(prepared_item)
  );
end;
$$;

revoke all on function public.prepare_copy_request(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.prepare_copy_request(uuid, uuid)
to service_role;
