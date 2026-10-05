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
declare
  session_secret_id uuid;
  session_created_by uuid;
begin
  -- Bloquea y verifica la sesión ANTES de persistir la página. Así un nonce
  -- vencido, de otra organización o de otro actor nunca puede enlazar una
  -- página mediante una RPC privilegiada.
  select user_long_lived_token_vault_secret_id, created_by
  into session_secret_id, session_created_by
  from public.organization_meta_oauth_sessions
  where nonce = p_nonce
    and organization_id = p_organization_id
    and expires_at > now()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_NOT_FOUND';
  end if;
  if session_created_by <> p_connected_by then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_ACTOR_MISMATCH';
  end if;

  perform public.upsert_meta_connection(
    p_organization_id,
    p_connected_by,
    p_facebook_page_id,
    p_facebook_page_name,
    p_instagram_business_account_id,
    p_page_access_token
  );

  -- No se borra directamente desde Vault: se invalida el cifrado y después
  -- se remueve la referencia temporal. La API/cliente nunca ve este valor.
  perform public.invalidate_meta_vault_secret(
    session_secret_id,
    'Meta OAuth session completed'
  );

  delete from public.organization_meta_oauth_sessions
  where nonce = p_nonce and organization_id = p_organization_id;

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
  expired_session record;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'P0001', message = 'META_OAUTH_SESSION_CLEANUP_LIMIT_INVALID';
  end if;

  for expired_session in
    select nonce, user_long_lived_token_vault_secret_id
    from public.organization_meta_oauth_sessions
    where expires_at <= now()
    order by expires_at asc
    for update skip locked
    limit p_limit
  loop
    perform public.invalidate_meta_vault_secret(
      expired_session.user_long_lived_token_vault_secret_id,
      'Meta OAuth session expired'
    );
    delete from public.organization_meta_oauth_sessions
    where nonce = expired_session.nonce;
    deleted_count := deleted_count + 1;
  end loop;

  return jsonb_build_object('deleted', deleted_count);
end;
$$;

revoke all on function public.complete_meta_oauth_selection(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.delete_expired_meta_oauth_sessions(integer) from public, anon, authenticated;
grant execute on function public.complete_meta_oauth_selection(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.delete_expired_meta_oauth_sessions(integer) to service_role;
