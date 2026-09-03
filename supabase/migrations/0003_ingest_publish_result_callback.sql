-- Atomically ingest one signed n8n publish callback for one approved target.
-- owner_id is always derived from the locked target; n8n cannot supply it.
create function public.ingest_publish_result_callback(
  p_content_item_id uuid,
  p_publication_target_id uuid,
  p_platform public.publication_platform,
  p_idempotency_key uuid,
  p_remote_post_id text,
  p_remote_url text,
  p_published_at timestamptz,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  callback_run_id uuid;
  content_owner_id uuid;
  current_status public.publication_status;
  prior_target_id uuid;
  callback_succeeded boolean;
begin
  callback_succeeded := p_error_code is null and p_error_message is null;
  if callback_succeeded <> (
    p_remote_post_id is not null
    and p_remote_url is not null
    and p_published_at is not null
  ) then
    raise exception using errcode = '22023', message = 'PUBLISH_RESULT_INVALID_OUTCOME';
  end if;
  if not callback_succeeded and (p_error_code is null or p_error_message is null) then
    raise exception using errcode = '22023', message = 'PUBLISH_RESULT_INVALID_ERROR';
  end if;

  select publication_target_id
  into prior_target_id
  from public.automation_runs
  where kind = 'PUBLISH_CALLBACK'
    and idempotency_key = p_idempotency_key;

  if found then
    if prior_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'PUBLISH_IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('created', false);
  end if;

  select owner_id, status
  into content_owner_id, current_status
  from public.publication_targets
  where id = p_publication_target_id
    and content_item_id = p_content_item_id
    and platform = p_platform
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'PUBLISH_TARGET_NOT_FOUND';
  end if;

  -- Recheck after acquiring the target lock so concurrent retries are idempotent.
  select publication_target_id
  into prior_target_id
  from public.automation_runs
  where kind = 'PUBLISH_CALLBACK'
    and idempotency_key = p_idempotency_key;

  if found then
    if prior_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'PUBLISH_IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('created', false);
  end if;

  if current_status <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = 'PUBLISH_TARGET_NOT_APPROVED';
  end if;

  insert into public.automation_runs (
    owner_id,
    content_item_id,
    publication_target_id,
    kind,
    idempotency_key,
    status,
    response_payload,
    sanitized_error,
    completed_at
  ) values (
    content_owner_id,
    p_content_item_id,
    p_publication_target_id,
    'PUBLISH_CALLBACK',
    p_idempotency_key,
    case when callback_succeeded then 'COMPLETED' else 'ERROR' end,
    case
      when callback_succeeded then jsonb_build_object(
        'remotePostId', p_remote_post_id,
        'remoteUrl', p_remote_url,
        'publishedAt', p_published_at
      )
      else jsonb_build_object('errorCode', p_error_code)
    end,
    p_error_message,
    now()
  )
  on conflict (kind, idempotency_key) do nothing
  returning id into callback_run_id;

  if callback_run_id is null then
    select publication_target_id
    into prior_target_id
    from public.automation_runs
    where kind = 'PUBLISH_CALLBACK'
      and idempotency_key = p_idempotency_key;
    if prior_target_id <> p_publication_target_id then
      raise exception using errcode = 'P0001', message = 'PUBLISH_IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('created', false);
  end if;

  update public.publication_targets
  set
    status = case
      when callback_succeeded then 'PUBLISHED'::public.publication_status
      else 'ERROR'::public.publication_status
    end,
    remote_post_id = case when callback_succeeded then p_remote_post_id else null end,
    remote_url = case when callback_succeeded then p_remote_url else null end,
    published_at = case when callback_succeeded then p_published_at else null end,
    last_error = case when callback_succeeded then null else p_error_message end
  where id = p_publication_target_id;

  insert into public.audit_events (
    owner_id,
    content_item_id,
    publication_target_id,
    event_type,
    metadata
  ) values (
    content_owner_id,
    p_content_item_id,
    p_publication_target_id,
    'PUBLISH_CALLBACK_RECEIVED',
    jsonb_build_object(
      'platform', p_platform,
      'outcome', case when callback_succeeded then 'PUBLISHED' else 'ERROR' end,
      'errorCode', p_error_code
    )
  );

  return jsonb_build_object('created', true);
end;
$$;

revoke all on function public.ingest_publish_result_callback(
  uuid, uuid, public.publication_platform, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.ingest_publish_result_callback(
  uuid, uuid, public.publication_platform, uuid, text, text, timestamptz, text, text
) to service_role;
