-- ============================================================
-- Meta OAuth session cleanup and atomic page selection
-- ============================================================

create function public.complete_meta_oauth_selection(
  p_organization_id uuid,
  p_nonce uuid,
  p_facebook_page_id text,
  p_facebook_page_name text,
  p_instagram_business_account_id text,
  p_page_access_token text,
  p_connected_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform public.upsert_meta_connection(
    p_organization_id,
    p_connected_by,
    p_facebook_page_id,
    p_facebook_page_name,
    p_instagram_business_account_id,
    p_page_access_token
  );

  delete from public.organization_meta_oauth_sessions
  where nonce = p_nonce and organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_NOT_FOUND';
  end if;

  return jsonb_build_object('connected', true);
end;
$$;

-- Mantenimiento: invocar esta función periódicamente desde el mismo mecanismo
-- operativo que usa el repositorio para tareas de mantenimiento del worker
-- (por ejemplo, junto con la recuperación de leases expirados). Esta migración
-- no registra un cron por sí sola.
create function public.delete_expired_meta_oauth_sessions(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  deleted_count integer := 0;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_CLEANUP_LIMIT_INVALID';
  end if;

  with expired as (
    select nonce
    from public.organization_meta_oauth_sessions
    where expires_at <= now()
    order by expires_at asc
    for update skip locked
    limit p_limit
  )
  delete from public.organization_meta_oauth_sessions as session
  using expired
  where session.nonce = expired.nonce;

  get diagnostics deleted_count = row_count;
  return jsonb_build_object('deleted', deleted_count);
end;
$$;

revoke all on function public.complete_meta_oauth_selection(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_expired_meta_oauth_sessions(integer) from public, anon, authenticated;
grant execute on function public.complete_meta_oauth_selection(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.delete_expired_meta_oauth_sessions(integer) to service_role;
