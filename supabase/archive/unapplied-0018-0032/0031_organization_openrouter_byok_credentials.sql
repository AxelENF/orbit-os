-- ============================================================
-- Organization-owned OpenRouter (BYOK) credentials
-- ============================================================
--
-- Security invariants:
--   * The plaintext API key exists only as an RPC input and in Supabase Vault.
--   * No public table, audit event, job payload, or authenticated RPC response
--     contains the API key or the Vault secret identifier.
--   * Only the service_role can resolve the decrypted key for a trusted server
--     or worker. Browser code must use the sanitized status RPC below instead.
--   * Credential changes are owner-only because the key controls a customer's
--     external AI billing account. Editors can inspect non-sensitive status.
--
-- Vault does not expose a documented deletion API used by this repository.
-- Revocation therefore fail-closes the application resolver immediately; the
-- customer must also revoke the key at OpenRouter. Rotation updates the same
-- encrypted Vault secret in place, avoiding an orphaned historical secret.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists public.organization_ai_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider = 'OPENROUTER'),
  model text not null check (length(btrim(model)) between 1 and 200),
  input_cost_per_million_usd numeric(14, 6)
    check (input_cost_per_million_usd is null or input_cost_per_million_usd >= 0),
  output_cost_per_million_usd numeric(14, 6)
    check (output_cost_per_million_usd is null or output_cost_per_million_usd >= 0),
  monthly_budget_usd numeric(10, 2)
    check (monthly_budget_usd is null or monthly_budget_usd >= 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'REVOKED', 'ERROR')),
  last_error_code text,
  configured_by uuid not null references auth.users(id) on delete restrict,
  configured_at timestamptz not null default now(),
  last_rotated_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider),
  constraint organization_ai_provider_credentials_revocation_state_check
    check (
      (status = 'REVOKED' and revoked_at is not null)
      or (status <> 'REVOKED' and revoked_at is null)
    )
);

create index if not exists organization_ai_provider_credentials_org_status_idx
  on public.organization_ai_provider_credentials (organization_id, status);

-- This link is deliberately private: a Vault UUID is not a secret by itself,
-- but disclosing it broadens the set of objects a compromised client can probe.
create table if not exists private.organization_ai_provider_secret_links (
  credential_id uuid primary key
    references public.organization_ai_provider_credentials(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organization_ai_provider_credentials enable row level security;
alter table private.organization_ai_provider_secret_links enable row level security;

-- All credential writes and reads use narrowly scoped RPCs. This prevents a
-- future broad table grant from exposing non-sensitive configuration by mistake.
revoke all on table public.organization_ai_provider_credentials from public, anon, authenticated;
revoke all on table private.organization_ai_provider_secret_links from public, anon, authenticated;

drop trigger if exists organization_ai_provider_credentials_set_updated_at
  on public.organization_ai_provider_credentials;
create trigger organization_ai_provider_credentials_set_updated_at
  before update on public.organization_ai_provider_credentials
  for each row execute function public.set_updated_at();

-- Service-only write path. The application server must authenticate its caller
-- before invoking it, and this function independently confirms that the actor
-- is a current organization owner. It intentionally returns no secret data.
create or replace function public.configure_organization_openrouter_credential(
  p_organization_id uuid,
  p_configured_by uuid,
  p_api_key text,
  p_model text,
  p_input_cost_per_million_usd numeric default null,
  p_output_cost_per_million_usd numeric default null,
  p_monthly_budget_usd numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, vault
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
  v_vault_secret_id uuid;
  v_vault_name text;
begin
  if p_organization_id is null
     or p_configured_by is null
     or p_api_key is null
     or length(btrim(p_api_key)) < 8
     or p_api_key <> btrim(p_api_key)
     or p_model is null
     or length(btrim(p_model)) > 200
     or nullif(btrim(p_model), '') is null
     or p_input_cost_per_million_usd < 0
     or p_output_cost_per_million_usd < 0
     or p_monthly_budget_usd < 0 then
    raise exception using errcode = '22023', message = 'OPENROUTER_CREDENTIAL_INVALID_INPUT';
  end if;

  -- The function may be called under service_role (where auth.uid() is null),
  -- so authorize the claimed actor against the durable membership relation.
  if not exists (
    select 1
    from public.organization_members as member
    where member.organization_id = p_organization_id
      and member.user_id = p_configured_by
      and member.role = 'owner'::public.organization_role
  ) then
    raise exception using errcode = '42501', message = 'OPENROUTER_CREDENTIAL_OWNER_REQUIRED';
  end if;

  -- Serialize first configuration and rotations for one organization/provider.
  perform pg_advisory_xact_lock(
    hashtext('organization-openrouter-credential:' || p_organization_id::text)
  );

  select credential.* into v_credential
  from public.organization_ai_provider_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.provider = 'OPENROUTER'
  for update;

  if found then
    select link.vault_secret_id into v_vault_secret_id
    from private.organization_ai_provider_secret_links as link
    where link.credential_id = v_credential.id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'OPENROUTER_CREDENTIAL_SECRET_LINK_MISSING';
    end if;
  end if;

  v_vault_name := 'orbit-openrouter-' || p_organization_id::text;
  if v_vault_secret_id is null then
    v_vault_secret_id := vault.create_secret(
      p_api_key,
      v_vault_name,
      'Orbit OS organization-owned OpenRouter credential'
    );
  else
    perform vault.update_secret(
      v_vault_secret_id,
      p_api_key,
      v_vault_name,
      'Orbit OS organization-owned OpenRouter credential',
      null
    );
  end if;

  insert into public.organization_ai_provider_credentials (
    organization_id, provider, model,
    input_cost_per_million_usd, output_cost_per_million_usd, monthly_budget_usd,
    status, last_error_code, configured_by, configured_at, last_rotated_at, revoked_at
  ) values (
    p_organization_id, 'OPENROUTER', btrim(p_model),
    p_input_cost_per_million_usd, p_output_cost_per_million_usd, p_monthly_budget_usd,
    'ACTIVE', null, p_configured_by, now(), now(), null
  )
  on conflict (organization_id, provider) do update
  set model = excluded.model,
      input_cost_per_million_usd = excluded.input_cost_per_million_usd,
      output_cost_per_million_usd = excluded.output_cost_per_million_usd,
      monthly_budget_usd = excluded.monthly_budget_usd,
      status = 'ACTIVE',
      last_error_code = null,
      configured_by = excluded.configured_by,
      configured_at = now(),
      last_rotated_at = now(),
      revoked_at = null,
      updated_at = now()
  returning * into v_credential;

  insert into private.organization_ai_provider_secret_links (
    credential_id, vault_secret_id, updated_at
  ) values (
    v_credential.id, v_vault_secret_id, now()
  )
  on conflict (credential_id) do update
  set vault_secret_id = excluded.vault_secret_id,
      updated_at = now();

  return jsonb_build_object(
    'credentialId', v_credential.id,
    'provider', v_credential.provider,
    'model', v_credential.model,
    'status', v_credential.status,
    'configuredAt', v_credential.configured_at,
    'lastRotatedAt', v_credential.last_rotated_at
  );
end;
$$;

-- Service-only resolver. Keep it private and never forward its result to a
-- browser, job payload, database audit row, or public API response.
create or replace function private.resolve_organization_openrouter_credential(
  p_organization_id uuid
)
returns table (
  credential_id uuid,
  api_key text,
  model text,
  input_cost_per_million_usd numeric,
  output_cost_per_million_usd numeric,
  monthly_budget_usd numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public, private, vault
as $$
begin
  return query
  select
    credential.id,
    secret.decrypted_secret,
    credential.model,
    credential.input_cost_per_million_usd,
    credential.output_cost_per_million_usd,
    credential.monthly_budget_usd
  from public.organization_ai_provider_credentials as credential
  join private.organization_ai_provider_secret_links as link
    on link.credential_id = credential.id
  join vault.decrypted_secrets as secret
    on secret.id = link.vault_secret_id
  where credential.organization_id = p_organization_id
    and credential.provider = 'OPENROUTER'
    and credential.status = 'ACTIVE';
end;
$$;

-- PostgREST only exposes configured API schemas (normally `public`), while
-- the Node worker deliberately talks to Supabase through PostgREST RPC. This
-- narrow wrapper preserves that execution path without exposing the private
-- resolver or decrypted key to browser roles: it is executable by service_role
-- only and must never be proxied to a client response.
create or replace function public.resolve_organization_openrouter_credential_for_worker(
  p_organization_id uuid
)
returns table (
  credential_id uuid,
  api_key text,
  model text,
  input_cost_per_million_usd numeric,
  output_cost_per_million_usd numeric,
  monthly_budget_usd numeric
)
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select *
  from private.resolve_organization_openrouter_credential(p_organization_id);
$$;

-- Authenticated clients only receive sanitized configuration. The explicit
-- auth.uid() comparison closes the actor-parameter spoofing gap that applies
-- to service-role-oriented helper functions elsewhere in the schema.
create or replace function public.get_organization_openrouter_credential_status(
  p_organization_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
begin
  if auth.uid() is null or auth.uid() <> p_actor_id then
    raise exception using errcode = '42501', message = 'OPENROUTER_CREDENTIAL_ACTOR_FORBIDDEN';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_actor_id,
    array['owner', 'editor']::public.organization_role[]
  );

  select * into v_credential
  from public.organization_ai_provider_credentials
  where organization_id = p_organization_id
    and provider = 'OPENROUTER';

  if not found then
    return jsonb_build_object('configured', false, 'provider', 'OPENROUTER');
  end if;

  return jsonb_build_object(
    'configured', true,
    'provider', v_credential.provider,
    'model', v_credential.model,
    'status', v_credential.status,
    'inputCostPerMillionUsd', v_credential.input_cost_per_million_usd,
    'outputCostPerMillionUsd', v_credential.output_cost_per_million_usd,
    'monthlyBudgetUsd', v_credential.monthly_budget_usd,
    'configuredAt', v_credential.configured_at,
    'lastRotatedAt', v_credential.last_rotated_at,
    'revokedAt', v_credential.revoked_at
  );
end;
$$;

-- Service-only error/revocation transitions. Error values are intentionally
-- bounded codes, not provider response bodies, because responses can contain
-- customer data or credential-adjacent diagnostics.
create or replace function public.mark_organization_openrouter_credential_error(
  p_organization_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
begin
  if p_error_code is null
     or length(btrim(p_error_code)) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'OPENROUTER_CREDENTIAL_ERROR_CODE_INVALID';
  end if;

  update public.organization_ai_provider_credentials
  set status = 'ERROR', last_error_code = btrim(p_error_code), updated_at = now()
  where organization_id = p_organization_id
    and provider = 'OPENROUTER'
    and status <> 'REVOKED'
  returning * into v_credential;

  return jsonb_build_object('marked', found);
end;
$$;

create or replace function public.revoke_organization_openrouter_credential(
  p_organization_id uuid,
  p_revoked_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_credential public.organization_ai_provider_credentials%rowtype;
begin
  if p_organization_id is null or p_revoked_by is null then
    raise exception using errcode = '22023', message = 'OPENROUTER_CREDENTIAL_REVOKE_INVALID_INPUT';
  end if;

  if not exists (
    select 1
    from public.organization_members as member
    where member.organization_id = p_organization_id
      and member.user_id = p_revoked_by
      and member.role = 'owner'::public.organization_role
  ) then
    raise exception using errcode = '42501', message = 'OPENROUTER_CREDENTIAL_OWNER_REQUIRED';
  end if;

  update public.organization_ai_provider_credentials
  set status = 'REVOKED',
      last_error_code = null,
      revoked_at = now(),
      updated_at = now()
  where organization_id = p_organization_id
    and provider = 'OPENROUTER'
    and status <> 'REVOKED'
  returning * into v_credential;

  return jsonb_build_object(
    'revoked', found,
    'provider', 'OPENROUTER',
    'revokedAt', v_credential.revoked_at
  );
end;
$$;

revoke all on function public.configure_organization_openrouter_credential(uuid, uuid, text, text, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function private.resolve_organization_openrouter_credential(uuid)
  from public, anon, authenticated;
revoke all on function public.resolve_organization_openrouter_credential_for_worker(uuid)
  from public, anon, authenticated;
revoke all on function public.get_organization_openrouter_credential_status(uuid, uuid)
  from public, anon;
revoke all on function public.mark_organization_openrouter_credential_error(uuid, text)
  from public, anon, authenticated;
revoke all on function public.revoke_organization_openrouter_credential(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.configure_organization_openrouter_credential(uuid, uuid, text, text, numeric, numeric, numeric)
  to service_role;
grant execute on function private.resolve_organization_openrouter_credential(uuid)
  to service_role;
grant execute on function public.resolve_organization_openrouter_credential_for_worker(uuid)
  to service_role;
grant execute on function public.get_organization_openrouter_credential_status(uuid, uuid)
  to authenticated;
grant execute on function public.mark_organization_openrouter_credential_error(uuid, text)
  to service_role;
grant execute on function public.revoke_organization_openrouter_credential(uuid, uuid)
  to service_role;

comment on table public.organization_ai_provider_credentials is
  'Sanitized per-organization AI provider configuration. The raw OpenRouter key is only in Supabase Vault.';
comment on table private.organization_ai_provider_secret_links is
  'Private linkage from AI provider configuration to encrypted Vault secrets. Never expose through client APIs.';
comment on function private.resolve_organization_openrouter_credential(uuid) is
  'Service-role-only resolver. Its decrypted API key result must never cross a browser or public API boundary.';
comment on function public.resolve_organization_openrouter_credential_for_worker(uuid) is
  'PostgREST-compatible service-role-only wrapper for the private resolver. Never proxy its decrypted API key result to a client.';
