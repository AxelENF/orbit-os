-- supabase/migrations/0018_meta_publisher.sql
-- Real Meta publisher: multi-asset carousel model, OAuth connection storage,
-- PUBLISH job lifecycle, and the ADR-008 diagnosis gate.
-- Spec: docs/superpowers/specs/2026-09-13-meta-publisher-oauth-adapter-design.md (rev 4)

-- ============================================================
-- Task 1: content_item_assets
-- ============================================================

alter table public.content_items
  add constraint content_items_id_organization_unique unique (id, organization_id);
alter table public.assets
  add constraint assets_id_organization_unique unique (id, organization_id);

create table public.content_item_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  content_item_id uuid not null,
  asset_id uuid not null,
  position smallint not null check (position >= 0 and position <= 9),
  created_at timestamptz not null default now(),
  unique (content_item_id, position),
  unique (content_item_id, asset_id),
  foreign key (content_item_id, organization_id)
    references public.content_items (id, organization_id) on delete restrict,
  foreign key (asset_id, organization_id)
    references public.assets (id, organization_id) on delete restrict
);

create index content_item_assets_content_item_idx
  on public.content_item_assets (content_item_id, position);

alter table public.content_item_assets enable row level security;
create policy "Organization members read content item assets"
  on public.content_item_assets
  for select to authenticated
  using (public.is_organization_member(organization_id));

-- Backfill: content_items creados antes de esta migración con asset_id
-- asignado obtienen su fila de portada. No toca content_items sin asset_id
-- (el camino create_content_item_with_targets, que crea items sin imagen a
-- propósito — ver spec, sección "Modelo de assets múltiples").
insert into public.content_item_assets (organization_id, content_item_id, asset_id, position)
select organization_id, id, asset_id, 0
from public.content_items
where asset_id is not null
on conflict (content_item_id, position) do nothing;

-- ============================================================
-- Task 2: organization_meta_connections
-- ============================================================

create table public.organization_meta_connections (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  facebook_page_id text not null check (length(btrim(facebook_page_id)) > 0),
  facebook_page_name text not null check (length(btrim(facebook_page_name)) > 0),
  instagram_business_account_id text,
  page_access_token text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED', 'ERROR')),
  constraint organization_meta_connections_token_nonempty_when_active
    check (status <> 'ACTIVE' or length(btrim(page_access_token)) > 0),
  connected_by uuid not null references public.profiles(id) on delete restrict,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Sin ninguna policy para authenticated/anon: select directo queda denegado
-- por RLS incluso si alguien olvida el revoke de abajo. Las dos capas son
-- intencionales, no redundantes.
alter table public.organization_meta_connections enable row level security;
revoke all on public.organization_meta_connections from public, anon, authenticated;

create function public.get_meta_connection_status(
  p_organization_id uuid, p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  connection public.organization_meta_connections%rowtype;
begin
  perform public.assert_organization_actor(
    p_organization_id, p_actor_id,
    array['owner', 'editor', 'reviewer']::public.organization_role[]
  );
  select * into connection
  from public.organization_meta_connections
  where organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('status', 'NOT_CONNECTED');
  end if;
  return jsonb_build_object(
    'status', connection.status,
    'facebookPageName', connection.facebook_page_name,
    'hasInstagram', connection.instagram_business_account_id is not null,
    'connectedAt', connection.connected_at
  );
end;
$$;

create function public.upsert_meta_connection(
  p_organization_id uuid, p_connected_by uuid,
  p_facebook_page_id text, p_facebook_page_name text,
  p_instagram_business_account_id text, p_page_access_token text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if nullif(btrim(p_facebook_page_id), '') is null
     or nullif(btrim(p_facebook_page_name), '') is null
     or nullif(btrim(p_page_access_token), '') is null then
    raise exception using errcode = '22023', message = 'META_CONNECTION_INVALID_INPUT';
  end if;
  insert into public.organization_meta_connections (
    organization_id, facebook_page_id, facebook_page_name,
    instagram_business_account_id, page_access_token, status,
    connected_by, connected_at, updated_at
  ) values (
    p_organization_id, btrim(p_facebook_page_id), btrim(p_facebook_page_name),
    nullif(btrim(p_instagram_business_account_id), ''), p_page_access_token, 'ACTIVE',
    p_connected_by, now(), now()
  )
  on conflict (organization_id) do update set
    facebook_page_id = excluded.facebook_page_id,
    facebook_page_name = excluded.facebook_page_name,
    instagram_business_account_id = excluded.instagram_business_account_id,
    page_access_token = excluded.page_access_token,
    status = 'ACTIVE',
    connected_by = excluded.connected_by,
    updated_at = now();
  return jsonb_build_object('connected', true);
end;
$$;

create function public.revoke_meta_connection(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.organization_meta_connections
  set status = 'REVOKED', page_access_token = '', updated_at = now()
  where organization_id = p_organization_id;
  return jsonb_build_object('revoked', found);
end;
$$;

create function public.mark_meta_connection_error(p_organization_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  update public.organization_meta_connections
  set status = 'ERROR', updated_at = now()
  where organization_id = p_organization_id
  returning jsonb_build_object('marked', true);
$$;

revoke all on function public.get_meta_connection_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.upsert_meta_connection(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.revoke_meta_connection(uuid) from public, anon, authenticated;
revoke all on function public.mark_meta_connection_error(uuid) from public, anon, authenticated;
grant execute on function public.get_meta_connection_status(uuid, uuid) to authenticated;
grant execute on function public.upsert_meta_connection(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.revoke_meta_connection(uuid) to service_role;
grant execute on function public.mark_meta_connection_error(uuid) to service_role;

-- ============================================================
-- Task 3: organization_meta_oauth_sessions
-- ============================================================

create table public.organization_meta_oauth_sessions (
  nonce uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  discovered_pages jsonb not null check (jsonb_typeof(discovered_pages) = 'array'),
  user_long_lived_token text not null check (length(btrim(user_long_lived_token)) > 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz not null
);
alter table public.organization_meta_oauth_sessions enable row level security;
revoke all on public.organization_meta_oauth_sessions from public, anon, authenticated;
