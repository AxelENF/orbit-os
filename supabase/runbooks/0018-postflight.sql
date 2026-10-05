-- Orbit OS production-pilot postflight (read-only).
-- Run only AFTER migration 0018 finishes successfully. No row changes are made.

select version, name
from supabase_migrations.schema_migrations
order by version;

select namespaces.nspname as table_schema, classes.relname as table_name, classes.relrowsecurity as row_security
from pg_class classes
join pg_namespace namespaces on namespaces.oid = classes.relnamespace
where classes.relkind = 'r'
  and namespaces.nspname = 'public'
  and classes.relname in (
    'organization_meta_connections',
    'organization_meta_oauth_sessions',
    'content_item_assets',
    'organization_ai_provider_credentials',
    'organization_api_keys'
  )
order by table_name;

with protected_functions(name, identity_arguments) as (
  values
    ('rls_auto_enable', ''),
    ('assign_organization_from_legacy_owner', ''),
    ('create_profile_for_auth_user', ''),
    ('prevent_last_organization_owner_removal', ''),
    ('prevent_legacy_owner_id_mutation', ''),
    ('is_owner_profile', 'uuid')
)
select
  protected_functions.name,
  protected_functions.identity_arguments,
  has_function_privilege('anon', procedures.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', procedures.oid, 'execute') as authenticated_can_execute,
  has_function_privilege('public', procedures.oid, 'execute') as public_can_execute
from protected_functions
join pg_proc procedures on procedures.proname = protected_functions.name
join pg_namespace namespaces on namespaces.oid = procedures.pronamespace and namespaces.nspname = 'public'
where pg_get_function_identity_arguments(procedures.oid) = protected_functions.identity_arguments
order by protected_functions.name;

select
  has_function_privilege('authenticated', 'public.has_organization_role(uuid,public.organization_role[])'::regprocedure, 'execute') as has_org_role_available,
  has_function_privilege('authenticated', 'public.is_organization_member(uuid)'::regprocedure, 'execute') as is_member_available,
  has_function_privilege('authenticated', 'public.organization_member_role(uuid)'::regprocedure, 'execute') as member_role_available,
  has_function_privilege('authenticated', 'public.save_aias_organization_profile(uuid,uuid,jsonb,text,text,integer,jsonb)'::regprocedure, 'execute') as brand_profile_available;

select policyname, qual
from pg_policies
where schemaname = 'public'
  and tablename = 'profiles'
  and policyname = 'Users read their profile';
