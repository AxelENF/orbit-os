-- Foundation only: establish organization identity and membership without
-- changing existing owner_id-scoped domain tables or runtime repositories.
do $$
begin
  create type public.organization_role as enum ('owner', 'editor', 'reviewer', 'viewer');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  legacy_owner_id uuid unique references public.profiles(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.organization_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.organization_brand_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  brand_name text,
  guidelines jsonb not null default '{}'::jsonb check (jsonb_typeof(guidelines) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (length(trim(provider)) > 0),
  credential_handle text not null check (length(trim(credential_handle)) > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISCONNECTED', 'ERROR')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

-- Stable organization IDs equal the historic owner_id. The old columns remain
-- authoritative for existing domain data until a later, explicitly scoped migration.
insert into public.organizations (id, legacy_owner_id, name)
select distinct owner_id, owner_id, 'Legacy organization ' || owner_id::text
from (
  select id as owner_id from public.profiles where role = 'owner'
  union
  select owner_id from public.assets
  union
  select owner_id from public.content_items
  union
  select owner_id from public.copy_drafts
  union
  select owner_id from public.publication_targets
  union
  select owner_id from public.automation_runs
  union
  select owner_id from public.audit_events
  union
  select owner_id from public.final_copy_versions
) as legacy_owners
where owner_id is not null
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
select id, legacy_owner_id, 'owner'::public.organization_role
from public.organizations
where legacy_owner_id is not null
on conflict (organization_id, user_id) do nothing;

create or replace function public.organization_member_role(p_organization_id uuid)
returns public.organization_role
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select member.role
  from public.organization_members as member
  where member.organization_id = p_organization_id
    and member.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.organization_member_role(p_organization_id) is not null;
$$;

create or replace function public.has_organization_role(
  p_organization_id uuid,
  p_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.organization_member_role(p_organization_id) = any(p_roles);
$$;

revoke all on function public.organization_member_role(uuid) from public, anon;
revoke all on function public.is_organization_member(uuid) from public, anon;
revoke all on function public.has_organization_role(uuid, public.organization_role[]) from public, anon;
grant execute on function public.organization_member_role(uuid) to authenticated, service_role;
grant execute on function public.is_organization_member(uuid) to authenticated, service_role;
grant execute on function public.has_organization_role(uuid, public.organization_role[]) to authenticated, service_role;

-- INSERT does not remove an existing owner; UPDATE can remove ownership by role; DELETE can remove the last owner.
-- UPDATE also protects ownership moves to another organization or user.
-- Locking the organization row serializes concurrent owner-removal attempts.
create or replace function public.prevent_last_organization_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  protected_organization_id uuid;
  removes_owner boolean;
begin
  if tg_op = 'DELETE' then
    protected_organization_id := old.organization_id;
    removes_owner := old.role = 'owner'::public.organization_role;
    if not removes_owner then
      return old;
    end if;
  else
    protected_organization_id := old.organization_id;
    removes_owner := old.role = 'owner'::public.organization_role
      and (
        new.role <> 'owner'::public.organization_role
        or new.organization_id is distinct from old.organization_id
        or new.user_id is distinct from old.user_id
      );
    if not removes_owner then
      return new;
    end if;
  end if;

  perform 1
  from public.organizations as organization
  where organization.id = protected_organization_id
  for update;
  if not found then
    -- Allow membership cleanup caused by deleting the parent organization.
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if not exists (
    select 1
    from public.organization_members as member
    where member.organization_id = protected_organization_id
      and member.role = 'owner'::public.organization_role
      and member.user_id <> old.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'ORGANIZATION_LAST_OWNER_REQUIRED';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.prevent_legacy_owner_id_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.legacy_owner_id is distinct from old.legacy_owner_id then
    raise exception using
      errcode = '23514',
      message = 'ORGANIZATION_LEGACY_OWNER_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_last_organization_owner_removal on public.organization_members;
create trigger prevent_last_organization_owner_removal
  before delete or update of organization_id, user_id, role on public.organization_members
  for each row execute function public.prevent_last_organization_owner_removal();
drop trigger if exists prevent_legacy_owner_id_mutation on public.organizations;
create trigger prevent_legacy_owner_id_mutation
  before update of legacy_owner_id on public.organizations
  for each row execute function public.prevent_legacy_owner_id_mutation();

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();
drop trigger if exists organization_members_set_updated_at on public.organization_members;
create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();
drop trigger if exists organization_brand_profiles_set_updated_at on public.organization_brand_profiles;
create trigger organization_brand_profiles_set_updated_at
  before update on public.organization_brand_profiles
  for each row execute function public.set_updated_at();
drop trigger if exists organization_integrations_set_updated_at on public.organization_integrations;
create trigger organization_integrations_set_updated_at
  before update on public.organization_integrations
  for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_brand_profiles enable row level security;
alter table public.organization_integrations enable row level security;

drop policy if exists "Members read their organization" on public.organizations;
create policy "Members read their organization" on public.organizations
  for select to authenticated using (public.is_organization_member(id));
drop policy if exists "Owners manage their organization" on public.organizations;
create policy "Owners manage their organization" on public.organizations
  for update to authenticated
  using (public.has_organization_role(id, array['owner']::public.organization_role[]))
  with check (public.has_organization_role(id, array['owner']::public.organization_role[]));

drop policy if exists "Members read organization members" on public.organization_members;
create policy "Members read organization members" on public.organization_members
  for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists "Owners manage organization members" on public.organization_members;
create policy "Owners manage organization members" on public.organization_members
  for all to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]))
  with check (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));

drop policy if exists "Members read organization brand profile" on public.organization_brand_profiles;
create policy "Members read organization brand profile" on public.organization_brand_profiles
  for select to authenticated using (public.is_organization_member(organization_id));
drop policy if exists "Editors manage organization brand profile" on public.organization_brand_profiles;
create policy "Editors manage organization brand profile" on public.organization_brand_profiles
  for all to authenticated
  using (public.has_organization_role(organization_id, array['owner', 'editor']::public.organization_role[]))
  with check (public.has_organization_role(organization_id, array['owner', 'editor']::public.organization_role[]));

drop policy if exists "Owners read organization integrations" on public.organization_integrations;
create policy "Owners read organization integrations" on public.organization_integrations
  for select to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));
drop policy if exists "Owners manage organization integrations" on public.organization_integrations;
create policy "Owners manage organization integrations" on public.organization_integrations
  for all to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]))
  with check (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));
