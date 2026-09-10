-- Atomically ingest an HMAC-authenticated n8n copy callback.
-- The caller never supplies owner_id; it is derived from content_items.
create function public.ingest_copy_result_callback(
  p_content_item_id uuid,
  p_idempotency_key uuid,
  p_visual_analysis jsonb,
  p_drafts jsonb,
  p_warnings jsonb,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  callback_run_id uuid;
  content_owner_id uuid;
  current_state public.content_state;
  request_content_item_id uuid;
begin
  if jsonb_typeof(p_visual_analysis) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_VISUAL_ANALYSIS';
  end if;
  if jsonb_typeof(p_warnings) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_WARNINGS';
  end if;
  if jsonb_typeof(p_drafts) is distinct from 'array' or jsonb_array_length(p_drafts) <> 2 then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_DRAFTS';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_drafts) as item(draft)
    where jsonb_typeof(item.draft) <> 'object'
      or nullif(btrim(item.draft ->> 'headline'), '') is null
      or nullif(btrim(item.draft ->> 'body'), '') is null
      or nullif(btrim(item.draft ->> 'cta'), '') is null
  ) then
    raise exception using errcode = '22023', message = 'COPY_RESULT_INVALID_DRAFTS';
  end if;

  select owner_id, state
  into content_owner_id, current_state
  from public.content_items
  where id = p_content_item_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_RESULT_CONTENT_NOT_FOUND';
  end if;

  select content_item_id
  into request_content_item_id
  from public.automation_runs
  where kind = 'COPY_REQUEST'
    and idempotency_key = p_idempotency_key;

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_REQUEST_NOT_FOUND';
  end if;
  if request_content_item_id <> p_content_item_id then
    raise exception using errcode = 'P0001', message = 'COPY_REQUEST_IDEMPOTENCY_KEY_REUSED';
  end if;

  insert into public.automation_runs (
    owner_id,
    content_item_id,
    kind,
    idempotency_key,
    status,
    response_payload
  ) values (
    content_owner_id,
    p_content_item_id,
    'COPY_CALLBACK',
    p_idempotency_key,
    'RECEIVED',
    jsonb_build_object(
      'visualAnalysis', p_visual_analysis,
      'drafts', p_drafts,
      'warnings', p_warnings,
      'provider', p_provider,
      'model', p_model
    )
  )
  on conflict (kind, idempotency_key) do nothing
  returning id into callback_run_id;

  if callback_run_id is null then
    return jsonb_build_object('created', false);
  end if;

  if current_state <> 'GENERATING' then
    raise exception using errcode = 'P0001', message = 'COPY_RESULT_INVALID_STATE';
  end if;

  insert into public.copy_drafts (
    owner_id,
    content_item_id,
    visual_analysis,
    headline,
    body,
    cta,
    provider,
    model,
    revision
  )
  select
    content_owner_id,
    p_content_item_id,
    p_visual_analysis,
    item.draft ->> 'headline',
    item.draft ->> 'body',
    item.draft ->> 'cta',
    p_provider,
    p_model,
    item.ordinality::integer
  from jsonb_array_elements(p_drafts) with ordinality as item(draft, ordinality)
  order by item.ordinality;

  insert into public.audit_events (
    owner_id,
    content_item_id,
    event_type,
    metadata
  ) values (
    content_owner_id,
    p_content_item_id,
    'COPY_CALLBACK_RECEIVED',
    jsonb_build_object(
      'draftCount', jsonb_array_length(p_drafts),
      'warningCount', jsonb_array_length(p_warnings)
    )
  );

  update public.content_items
  set state = 'DRAFT'
  where id = p_content_item_id
    and state = 'GENERATING';

  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_RESULT_INVALID_STATE';
  end if;

  update public.automation_runs
  set status = 'COMPLETED', completed_at = now()
  where id = callback_run_id;

  return jsonb_build_object('created', true);
end;
$$;

revoke all on function public.ingest_copy_result_callback(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.ingest_copy_result_callback(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) to service_role;
