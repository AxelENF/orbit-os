-- AIAS organization profiles. This migration is intentionally additive and has
-- not been applied to a live Supabase project by this repository.
--
-- An organization may have a brand-profile row without having completed AIAS
-- onboarding. `aias_profile is null` is therefore the durable "not configured"
-- state; this avoids seeding SnapGad (or any other tenant) into the product.
alter table public.organization_brand_profiles
  add column if not exists aias_profile jsonb,
  add column if not exists profile_version integer not null default 1,
  add column if not exists profile_hash text,
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists profile_metadata jsonb not null default '{}'::jsonb;

alter table public.organization_brand_profiles
  drop constraint if exists organization_brand_profiles_profile_version_check;
alter table public.organization_brand_profiles
  add constraint organization_brand_profiles_profile_version_check
  check (profile_version >= 1);

alter table public.organization_brand_profiles
  drop constraint if exists organization_brand_profiles_aias_profile_object_check;
alter table public.organization_brand_profiles
  add constraint organization_brand_profiles_aias_profile_object_check
  check (aias_profile is null or jsonb_typeof(aias_profile) = 'object');

alter table public.organization_brand_profiles
  drop constraint if exists organization_brand_profiles_profile_hash_check;
alter table public.organization_brand_profiles
  add constraint organization_brand_profiles_profile_hash_check
  check (profile_hash is null or profile_hash ~ '^[0-9a-f]{64}$');

alter table public.organization_brand_profiles
  drop constraint if exists organization_brand_profiles_profile_metadata_object_check;
alter table public.organization_brand_profiles
  add constraint organization_brand_profiles_profile_metadata_object_check
  check (jsonb_typeof(profile_metadata) = 'object');

create table if not exists public.organization_brand_profile_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_version integer not null check (profile_version >= 1),
  aias_profile jsonb not null check (jsonb_typeof(aias_profile) = 'object'),
  profile_hash text not null check (length(profile_hash) = 64),
  changed_by uuid not null references auth.users(id) on delete restrict,
  profile_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(profile_metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (organization_id, profile_version)
);

create index if not exists organization_brand_profile_history_org_version_idx
  on public.organization_brand_profile_history (organization_id, profile_version desc);

-- 0008 initially granted editors FOR ALL on the shared brand-profile row.
-- Remove that broad policy before exposing AIAS columns: direct authenticated
-- writes would otherwise bypass expectedVersion and the history ledger. The
-- security-definer RPC below is the only authenticated write path for AIAS.
drop policy if exists "Editors manage organization brand profile"
  on public.organization_brand_profiles;
drop policy if exists "Members read organization brand profile"
  on public.organization_brand_profiles;
alter table public.organization_brand_profiles enable row level security;
create policy "Members read organization brand profile"
  on public.organization_brand_profiles
  for select to authenticated
  using (public.is_organization_member(organization_id));

alter table public.organization_brand_profile_history enable row level security;

drop policy if exists "Members read AIAS profile history"
  on public.organization_brand_profile_history;
create policy "Members read AIAS profile history"
  on public.organization_brand_profile_history
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- All writes go through the version-checked RPC below. There is deliberately
-- no client INSERT/UPDATE policy for history rows.
revoke all on table public.organization_brand_profile_history from anon, authenticated;
grant select on table public.organization_brand_profile_history to authenticated;

create or replace function public.save_aias_organization_profile(
  p_organization_id uuid,
  p_actor_id uuid,
  p_profile jsonb,
  p_profile_canonical text,
  p_profile_hash text,
  p_expected_version integer default null,
  p_profile_metadata jsonb default '{}'::jsonb
)
returns public.organization_brand_profiles
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  current_row public.organization_brand_profiles%rowtype;
  saved_row public.organization_brand_profiles%rowtype;
  actual_version integer;
  next_version integer;
  computed_hash text;
begin
  if auth.uid() is null or auth.uid() <> p_actor_id then
    raise exception using errcode = '42501', message = 'AIAS_PROFILE_ACTOR_FORBIDDEN';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception using errcode = '22023', message = 'AIAS_PROFILE_INVALID_JSON';
  end if;
  if p_profile_hash is null or p_profile_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'AIAS_PROFILE_HASH_INVALID';
  end if;
  if p_profile_metadata is null or jsonb_typeof(p_profile_metadata) <> 'object' then
    raise exception using errcode = '22023', message = 'AIAS_PROFILE_METADATA_INVALID';
  end if;

  perform public.assert_organization_actor(
    p_organization_id,
    p_actor_id,
    array['owner', 'editor']::public.organization_role[]
  );

  -- Serialize first-create and version-update races for an organization even
  -- when its brand-profile row does not exist yet.
  perform pg_advisory_xact_lock(
    hashtext('aias-profile:' || p_organization_id::text)
  );

  -- pgcrypto is installed by 0001_content_os.sql. The canonical string is
  -- supplied by the adapter and checked against JSONB before hashing, so the
  -- SQL and TypeScript boundaries hash exactly the same bytes.
  if p_profile_canonical is null or p_profile_canonical::jsonb <> p_profile then
    raise exception using errcode = '22023', message = 'AIAS_PROFILE_CANONICAL_INVALID';
  end if;
  -- The local adapter sorts object keys lexicographically and preserves array
  -- order. It sends that exact canonical JSON string, then the database hashes
  -- the same bytes after checking it parses back to the supplied JSONB value.
  computed_hash := encode(public.digest(p_profile_canonical, 'sha256'), 'hex');
  if computed_hash <> p_profile_hash then
    raise exception using errcode = '22023', message = 'AIAS_PROFILE_HASH_MISMATCH';
  end if;

  select * into current_row
  from public.organization_brand_profiles
  where organization_id = p_organization_id
  for update;

  actual_version := case
    when current_row.id is null or current_row.aias_profile is null then null
    else current_row.profile_version
  end;
  if actual_version is null then
    if p_expected_version is not null then
      raise exception using errcode = 'P0001', message = 'AIAS_PROFILE_VERSION_CONFLICT';
    end if;
    next_version := 1;
  else
    if p_expected_version is null or p_expected_version <> actual_version then
      raise exception using errcode = 'P0001', message = 'AIAS_PROFILE_VERSION_CONFLICT';
    end if;
    next_version := actual_version + 1;
  end if;

  if current_row.id is null then
    insert into public.organization_brand_profiles (
      organization_id, aias_profile, profile_version, profile_hash,
      updated_by, profile_metadata
    ) values (
      p_organization_id, p_profile, next_version, p_profile_hash,
      p_actor_id, p_profile_metadata
    ) returning * into saved_row;
  else
    update public.organization_brand_profiles
    set aias_profile = p_profile,
        profile_version = next_version,
        profile_hash = p_profile_hash,
        updated_by = p_actor_id,
        profile_metadata = p_profile_metadata,
        updated_at = now()
    where organization_id = p_organization_id
    returning * into saved_row;
  end if;

  insert into public.organization_brand_profile_history (
    organization_id, profile_version, aias_profile, profile_hash,
    changed_by, profile_metadata
  ) values (
    p_organization_id, next_version, p_profile, p_profile_hash,
    p_actor_id, p_profile_metadata
  );

  return saved_row;
end;
$$;

revoke all on function public.save_aias_organization_profile(
  uuid, uuid, jsonb, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.save_aias_organization_profile(
  uuid, uuid, jsonb, text, text, integer, jsonb
) to authenticated;
