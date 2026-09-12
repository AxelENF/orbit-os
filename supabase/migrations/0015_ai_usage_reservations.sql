-- Additive migration. Depends on 0014_copy_hashtags_and_ai_usage.sql.
--
-- An append-only usage ledger alone cannot enforce a monthly cap under
-- concurrent workers: two workers can both read the same remaining balance
-- and each spend it. Reservations serialize that decision per organization
-- before a provider request, then settlement creates the immutable usage row.

create table public.ai_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  job_id uuid not null references public.automation_jobs(id) on delete restrict,
  attempt integer not null check (attempt > 0),
  reserved_cost_usd numeric(10, 4) not null check (reserved_cost_usd > 0),
  status text not null check (status in ('RESERVED', 'SETTLED')),
  expires_at timestamptz not null,
  settled_at timestamptz,
  actual_cost_usd numeric(10, 4) check (actual_cost_usd is null or actual_cost_usd >= 0),
  created_at timestamptz not null default now(),
  unique (job_id, attempt)
);

create index ai_usage_reservations_active_budget_idx
  on public.ai_usage_reservations (organization_id, created_at)
  where status = 'RESERVED';

alter table public.ai_usage_reservations enable row level security;

create policy "Members read organization ai reservations"
  on public.ai_usage_reservations
  for select to authenticated
  using (public.is_organization_member(organization_id));

alter table public.ai_usage_events
  add column reservation_id uuid references public.ai_usage_reservations(id) on delete restrict;

create unique index ai_usage_events_reservation_id_uidx
  on public.ai_usage_events (reservation_id)
  where reservation_id is not null;

create or replace function public.reserve_ai_request_budget(
  p_organization_id uuid,
  p_job_id uuid,
  p_attempt integer,
  p_maximum_cost_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  organization_budget numeric(10, 2);
  recorded_spend numeric(10, 4);
  reserved_spend numeric(10, 4);
  existing public.ai_usage_reservations%rowtype;
  created public.ai_usage_reservations%rowtype;
begin
  if p_attempt <= 0 or p_maximum_cost_usd <= 0 then
    raise exception using errcode = '22023', message = 'AI_BUDGET_RESERVATION_INVALID';
  end if;

  -- This row lock serializes the budget decision for an organization.
  select ai_monthly_budget_usd into organization_budget
  from public.organizations
  where id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'AI_BUDGET_ORGANIZATION_NOT_FOUND';
  end if;

  select * into existing
  from public.ai_usage_reservations
  where job_id = p_job_id and attempt = p_attempt
  for update;
  if found then
    if existing.status = 'RESERVED' and existing.expires_at > now() then
      return jsonb_build_object(
        'status', 'RESERVED',
        'reservationId', existing.id,
        'reservedCostUsd', existing.reserved_cost_usd
      );
    end if;
    if existing.status = 'SETTLED' then
      return jsonb_build_object('status', 'ALREADY_SETTLED');
    end if;
    raise exception using errcode = 'P0001', message = 'AI_BUDGET_RESERVATION_EXPIRED';
  end if;

  select coalesce(sum(estimated_cost_usd), 0) into recorded_spend
  from public.ai_usage_events
  where organization_id = p_organization_id
    and created_at >= date_trunc('month', now());

  select coalesce(sum(reserved_cost_usd), 0) into reserved_spend
  from public.ai_usage_reservations
  where organization_id = p_organization_id
    and status = 'RESERVED'
    and expires_at > now()
    and created_at >= date_trunc('month', now());

  if organization_budget is not null
    and recorded_spend + reserved_spend + p_maximum_cost_usd > organization_budget then
    return jsonb_build_object('status', 'BUDGET_EXCEEDED');
  end if;

  insert into public.ai_usage_reservations (
    organization_id, job_id, attempt, reserved_cost_usd, status, expires_at
  ) values (
    p_organization_id, p_job_id, p_attempt, p_maximum_cost_usd, 'RESERVED', now() + interval '10 minutes'
  ) returning * into created;

  return jsonb_build_object(
    'status', 'RESERVED',
    'reservationId', created.id,
    'reservedCostUsd', created.reserved_cost_usd
  );
end;
$$;

revoke all on function public.reserve_ai_request_budget(uuid, uuid, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.reserve_ai_request_budget(uuid, uuid, integer, numeric)
  to service_role;

create or replace function public.settle_ai_usage_reservation(
  p_reservation_id uuid,
  p_provider text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation public.ai_usage_reservations%rowtype;
  settlement_status text := 'SETTLED';
begin
  if nullif(btrim(p_provider), '') is null
    or nullif(btrim(p_model), '') is null
    or p_input_tokens < 0
    or p_output_tokens < 0
    or p_estimated_cost_usd < 0 then
    raise exception using errcode = '22023', message = 'AI_USAGE_SETTLEMENT_INVALID';
  end if;

  select * into reservation
  from public.ai_usage_reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'AI_USAGE_RESERVATION_NOT_FOUND';
  end if;

  if reservation.status = 'SETTLED' then
    return jsonb_build_object(
      'status', case when reservation.actual_cost_usd > reservation.reserved_cost_usd
        then 'RESERVATION_EXCEEDED' else 'SETTLED' end
    );
  end if;

  if p_estimated_cost_usd > reservation.reserved_cost_usd then
    settlement_status := 'RESERVATION_EXCEEDED';
  end if;

  insert into public.ai_usage_events (
    organization_id, job_id, reservation_id, provider, model,
    input_tokens, output_tokens, estimated_cost_usd
  ) values (
    reservation.organization_id, reservation.job_id, reservation.id,
    p_provider, p_model, p_input_tokens, p_output_tokens, p_estimated_cost_usd
  );

  update public.ai_usage_reservations
  set status = 'SETTLED', settled_at = now(), actual_cost_usd = p_estimated_cost_usd
  where id = reservation.id;

  return jsonb_build_object('status', settlement_status);
end;
$$;

revoke all on function public.settle_ai_usage_reservation(uuid, text, text, integer, integer, numeric)
  from public, anon, authenticated;
grant execute on function public.settle_ai_usage_reservation(uuid, text, text, integer, integer, numeric)
  to service_role;
