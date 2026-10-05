-- Orbit OS production-pilot preflight (read-only).
-- Run in Supabase SQL Editor immediately BEFORE applying 0018.
-- Expected: migration history ends at 0017; all application tables have 0 rows.

select version, name
from supabase_migrations.schema_migrations
order by version;

select table_name, row_count
from (
  select 'profiles'::text table_name, count(*)::bigint row_count from public.profiles
  union all select 'organizations', count(*) from public.organizations
  union all select 'organization_members', count(*) from public.organization_members
  union all select 'assets', count(*) from public.assets
  union all select 'content_items', count(*) from public.content_items
  union all select 'publication_targets', count(*) from public.publication_targets
  union all select 'automation_jobs', count(*) from public.automation_jobs
  union all select 'automation_runs', count(*) from public.automation_runs
  union all select 'audit_events', count(*) from public.audit_events
) inventory
order by table_name;

select extname, extversion
from pg_extension
where extname = 'supabase_vault';

select bucket_id, public
from storage.buckets
where bucket_id in ('content-assets', 'organization-logos')
order by bucket_id;

select routine_schema, routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'rls_auto_enable',
    'assign_organization_from_legacy_owner',
    'create_profile_for_auth_user',
    'prevent_last_organization_owner_removal',
    'prevent_legacy_owner_id_mutation',
    'is_owner_profile'
  )
order by routine_name, grantee;
