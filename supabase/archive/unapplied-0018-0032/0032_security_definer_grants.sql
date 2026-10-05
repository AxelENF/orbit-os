-- 0032_security_definer_grants.sql
--
-- Trigger functions run because the trigger is attached to a table; they do
-- not need to be callable over PostgREST. Explicitly revoke the default
-- PUBLIC grants that otherwise make these SECURITY DEFINER functions RPCs.
-- Keep the organization membership helpers untouched: current RLS policies
-- deliberately depend on their authenticated execution grants.

revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function public.assign_organization_from_legacy_owner() from public, anon, authenticated;
revoke all on function public.prevent_last_organization_owner_removal() from public, anon, authenticated;
revoke all on function public.prevent_legacy_owner_id_mutation() from public, anon, authenticated;

-- This function was created by an earlier remote bootstrap and is absent
-- from the repository migrations. Guard the revoke so fresh installations
-- and already-provisioned projects share the same migration history.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

-- `is_owner_profile` is a legacy read helper. It remains executable for
-- authenticated compatibility paths, but is not an anonymous RPC.
revoke all on function public.is_owner_profile(uuid) from public, anon;
grant execute on function public.is_owner_profile(uuid) to authenticated, service_role;

-- The ALL policy already implies SELECT for owners, so this duplicate
-- permissive SELECT policy only adds planner work and linter noise.
drop policy if exists "Owners read organization integrations" on public.organization_integrations;
