-- Additive migration. Not yet applied to a live project by this repository.

-- 1. Hashtags on stored copy drafts. Deliberately looser (0-8) than the
--    processor's own 5-8 guardrail, so an inactive n8n path that never
--    sends hashtags keeps working unchanged.
--    Postgres CHECK constraints cannot contain subqueries, so the reusable
--    immutable function below owns both structure and item format.
create function public.are_valid_hashtags(p_hashtags jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_typeof(p_hashtags) = 'array'
    and jsonb_array_length(p_hashtags) <= 8
    and not exists (
      select 1
      from jsonb_array_elements_text(p_hashtags) as tag
      where tag !~ '^#[[:alnum:]_]+$'
    );
$$;

alter table public.copy_drafts
  add column hashtags jsonb not null default '[]'::jsonb
  check (public.are_valid_hashtags(hashtags));

-- 2. ingest_copy_result_callback: same name and signature, now also reads
--    and validates an optional `hashtags` array per draft.
create or replace function public.ingest_copy_result_callback(
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
      or not public.are_valid_hashtags(coalesce(item.draft -> 'hashtags', '[]'::jsonb))
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
    hashtags,
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
    coalesce(item.draft -> 'hashtags', '[]'::jsonb),
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

-- 3. Append-only AI usage ledger. Same spirit as audit_events: only the
--    worker (service_role) writes it; organization members can read it.
create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  job_id uuid references public.automation_jobs(id) on delete restrict,
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  estimated_cost_usd numeric(10, 4) not null check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);
create index ai_usage_events_organization_created_idx
  on public.ai_usage_events (organization_id, created_at);
alter table public.ai_usage_events enable row level security;
create policy "Members read organization ai usage" on public.ai_usage_events
  for select to authenticated using (public.is_organization_member(organization_id));

-- 4. Optional monthly AI spend cap per organization. NULL = no cap, so
--    existing organizations are unaffected until Axel sets one explicitly.
alter table public.organizations
  add column ai_monthly_budget_usd numeric(10, 2)
  check (ai_monthly_budget_usd is null or ai_monthly_budget_usd >= 0);

-- 5. fail_copy_automation_job: same name and signature. A terminal failure
--    (FAILED or DEAD_LETTER — it will not be retried) now also moves the
--    stuck content_item out of GENERATING and leaves an audit trail, so
--    /drafts stops polling and /history shows what happened. A RETRY_WAIT
--    outcome leaves content_items untouched; the worker will try again.
create or replace function public.fail_copy_automation_job(
  p_job_id uuid,
  p_idempotency_key uuid,
  p_lease_token uuid,
  p_error text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  job public.automation_jobs%rowtype;
  next_status public.automation_job_status;
  next_due timestamptz;
  item_owner_id uuid;
begin
  if p_error is null or length(btrim(p_error)) = 0 or length(p_error) > 2000 then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_ERROR_INVALID';
  end if;

  select * into job
  from public.automation_jobs
  where id = p_job_id
    and kind = 'COPY'
    and idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_NOT_FOUND';
  end if;
  if job.status <> 'PROCESSING'
     or job.lease_token <> p_lease_token
     or job.lease_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'COPY_JOB_LEASE_INVALID';
  end if;

  if p_retryable is false then
    next_status := 'FAILED';
    next_due := now();
  elsif job.attempt_count >= job.max_attempts then
    next_status := 'DEAD_LETTER';
    next_due := now();
  else
    next_status := 'RETRY_WAIT';
    next_due := greatest(
      job.run_at,
      now() + make_interval(secs => least(3600, (2 ^ greatest(job.attempt_count - 1, 0))::integer))
    );
  end if;

  update public.automation_jobs
  set status = next_status,
      next_attempt_at = next_due,
      sanitized_error = left(btrim(p_error), 2000),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = job.id;

  if next_status in ('FAILED', 'DEAD_LETTER') then
    select owner_id into item_owner_id
    from public.content_items
    where id = job.content_item_id
      and organization_id = job.organization_id
    for update;

    if found then
      update public.content_items
      set state = 'ERROR'::public.content_state
      where id = job.content_item_id
        and organization_id = job.organization_id
        and state = 'GENERATING';

      insert into public.audit_events (
        organization_id, owner_id, content_item_id, event_type, metadata
      ) values (
        job.organization_id, item_owner_id, job.content_item_id, 'COPY_JOB_FAILED',
        jsonb_build_object(
          'jobId', job.id,
          'status', next_status,
          'error', left(btrim(p_error), 2000)
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'state', next_status,
    'jobId', job.id,
    'attempts', job.attempt_count,
    'nextAttemptAt', next_due
  );
end;
$$;

revoke all on function public.fail_copy_automation_job(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_copy_automation_job(uuid, uuid, uuid, text, boolean)
  to service_role;

-- 6. Hashtags on the immutable final copy record, so what a human approves
--    for review is what actually gets published — not just what the AI
--    proposed in copy_drafts.
--
--    Postgres identifies a function by (name, parameter TYPES), so adding
--    `p_hashtags` — even with a default — via `create or replace` would NOT
--    replace the existing 8-parameter function; it would create a second,
--    coexisting 9-parameter overload. Postgres grants EXECUTE on a newly
--    created function to PUBLIC by default, and nothing in this repo alters
--    that default, so the new overload would be callable directly by any
--    `authenticated` role via PostgREST/supabase-js — bypassing the Next.js
--    route entirely and this RPC's `service_role`-only intent (see the
--    revoke/grant pair for the 8-parameter version in
--    0009_tenantize_content_and_jobs.sql:324,328). `assert_organization_actor`
--    trusts `p_owner_id`/`p_organization_id` as already-verified — it does not
--    check them against `auth.uid()` — so an exposed overload would let any
--    authenticated member of any organization submit final copy while
--    attributing it to an arbitrary `p_owner_id` from that org's membership.
--    Dropping the old signature and creating a single 9-parameter function
--    under the same name avoids the overload trap entirely. The sole caller
--    (lib/supabase/repository.ts, Task 11 Step 6) is updated in the same
--    task to pass all nine parameters by name, so nothing is left calling
--    the old 8-parameter shape.
alter table public.final_copy_versions
  add column hashtags jsonb not null default '[]'::jsonb
  check (public.are_valid_hashtags(hashtags));

drop function if exists public.submit_final_copy_for_review(
  uuid, uuid, uuid, uuid, text, text, text, text
);

create function public.submit_final_copy_for_review(
  p_organization_id uuid, p_owner_id uuid, p_content_item_id uuid,
  p_selected_copy_draft_id uuid, p_headline text, p_body text, p_cta text,
  p_checksum text, p_hashtags jsonb
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
  if not public.are_valid_hashtags(p_hashtags) then
    raise exception using errcode = '22023', message = 'FINAL_COPY_INVALID_HASHTAGS';
  end if;
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
    body, cta, hashtags, checksum, version
  ) values (
    p_organization_id, item.owner_id, p_content_item_id, p_selected_copy_draft_id,
    p_headline, p_body, p_cta, p_hashtags, p_checksum, next_version
  ) returning * into created_copy;
  update public.content_items set selected_final_copy_id = created_copy.id, state = 'REVIEW'
  where id = p_content_item_id and organization_id = p_organization_id;
  insert into public.audit_events (organization_id, owner_id, actor_id, content_item_id, event_type, metadata)
  values (p_organization_id, item.owner_id, p_owner_id, p_content_item_id,
    'FINAL_COPY_SUBMITTED', jsonb_build_object('finalCopyId', created_copy.id, 'version', next_version));
  return created_copy;
end;
$$;

revoke all on function public.submit_final_copy_for_review(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.submit_final_copy_for_review(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;
