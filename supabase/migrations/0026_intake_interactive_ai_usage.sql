-- Interactive (non-job) AI usage ledger entry for intake vision
-- suggestions. job_id is nullable on ai_usage_events (0014) precisely
-- for calls like this one that aren't tied to a durable job.
-- Spec: docs/superpowers/specs/2026-09-14-intake-vision-suggestions-design.md

create function public.record_interactive_ai_usage(
  p_organization_id uuid,
  p_provider text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_estimated_cost_usd is null or p_estimated_cost_usd < 0
     or nullif(btrim(p_provider), '') is null
     or nullif(btrim(p_model), '') is null then
    raise exception using errcode = '22023', message = 'INTERACTIVE_AI_USAGE_INVALID_INPUT';
  end if;

  insert into public.ai_usage_events (
    organization_id, job_id, provider, model, input_tokens, output_tokens, estimated_cost_usd
  ) values (
    p_organization_id, null, p_provider, p_model, p_input_tokens, p_output_tokens, p_estimated_cost_usd
  );

  return jsonb_build_object('recorded', true);
end;
$$;

revoke all on function public.record_interactive_ai_usage(uuid, text, text, integer, integer, numeric) from public, anon, authenticated;
grant execute on function public.record_interactive_ai_usage(uuid, text, text, integer, integer, numeric) to service_role;
