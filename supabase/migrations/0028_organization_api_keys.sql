-- 0019_organization_api_keys.sql
-- Tabla + RPCs para claves de API por organización (API v1). Ver
-- docs/superpowers/specs/2026-09-14-api-v1-tenant-keys-design.md.

create table if not exists public.organization_api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  key_hash text not null unique,
  key_prefix text not null check (length(key_prefix) = 12),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table public.organization_api_keys enable row level security;

create policy "Owners read their api keys" on public.organization_api_keys for select to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));

-- Sin policy de insert/update/delete: solo las RPCs de abajo escriben esta
-- tabla, corriendo con privilegios de servicio (security definer), no con
-- los del caller. Evita que una policy amplia permita a un owner reescribir
-- created_by de una clave para atribuirla a otro usuario.

create function public.create_organization_api_key(p_organization_id uuid, p_label text)
returns table (id uuid, key_prefix text, secret text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text := 'sk_live_' || encode(gen_random_bytes(32), 'hex');
  v_hash text := encode(digest(v_secret, 'sha256'), 'hex');
  v_prefix text := left(v_secret, 12);
  v_id uuid;
begin
  -- has_organization_role devuelve NULL (no false) cuando el caller no
  -- tiene ninguna fila de membresía, y `if not null` es `if null` en
  -- plpgsql — no ejecuta el bloque. coalesce fuerza NULL a "no autorizado".
  if not coalesce(public.has_organization_role(p_organization_id, array['owner']::public.organization_role[]), false) then
    raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER';
  end if;
  insert into public.organization_api_keys (organization_id, label, key_hash, key_prefix, created_by)
  values (p_organization_id, p_label, v_hash, v_prefix, auth.uid())
  returning organization_api_keys.id into v_id;
  return query select v_id, v_prefix, v_secret;
end;
$$;

create function public.revoke_organization_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  select organization_id into v_organization_id
  from public.organization_api_keys where id = p_key_id;
  -- Corrección ronda 3: mismo bug de NULL que create_organization_api_key.
  if v_organization_id is null
     or not coalesce(public.has_organization_role(v_organization_id, array['owner']::public.organization_role[]), false) then
    raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER';
  end if;
  update public.organization_api_keys set revoked_at = now()
  where id = p_key_id and revoked_at is null;
end;
$$;

revoke all on function public.create_organization_api_key(uuid, text) from public, anon;
revoke all on function public.revoke_organization_api_key(uuid) from public, anon;
grant execute on function public.create_organization_api_key(uuid, text) to authenticated;
grant execute on function public.revoke_organization_api_key(uuid) to authenticated;

revoke select on public.organization_api_keys from authenticated;
grant select (id, organization_id, label, key_prefix, created_by, created_at, last_used_at, revoked_at)
  on public.organization_api_keys to authenticated;
