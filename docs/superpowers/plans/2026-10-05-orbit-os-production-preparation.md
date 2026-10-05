# Orbit OS Production Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare one reproducible, security-hardened Orbit OS migration and the exact evidence package required to run the first production pilot safely.

**Architecture:** The remote database is a clean baseline through `0017`, with no application rows. Preserve that immutable history and replace the un-applied local delta (`0018`–`0032`) with one canonical `20261005124203_orbit_os_mvp_consolidation.sql`. The migration is built and statically verified locally; a separate runbook provides read-only preflight, one explicit apply step, and read-only postflight/RLS checks for the production pilot.

**Tech Stack:** Next.js, TypeScript, Vitest, Supabase Postgres 17, Supabase Vault, RLS, Storage, Meta OAuth, OpenRouter BYOK.

---

## Confirmed remote baseline — 2026-10-05

- Project: `zsljrjuebdgcyinexdlj`.
- Applied migration history: `0001` through `0017`, in order.
- Public application tables: zero rows; RLS enabled on every listed table.
- `supabase_vault` is installed.
- Security advisors identify publicly executable trigger helpers plus `is_owner_profile`; the consolidated migration must revoke them. It must preserve authenticated grants for RLS helpers and the authenticated AIAS profile RPC.

## Permission gates

| Gate | Action | Owner | Required before |
| --- | --- | --- | --- |
| P0 | Read project schema, migration history, advisors and logs | Codex | Preparation |
| P1 | Write repository files and run local tests | Codex | Consolidation build |
| P2 | Apply the single DDL migration to `zsljrjuebdgcyinexdlj` | Axel explicitly confirms after reviewing preflight | Production migration |
| P3 | Configure runtime secrets in the deployment environment, not chat | Axel | Real OpenRouter/Meta use |
| P4 | Connect a Meta test page and approve one manual test publication | Axel + Codex | Publishing enablement |

### Task 1: Create a canonical migration inventory test

**Files:**
- Create: `tests/supabase/orbit-mvp-consolidation.test.ts`
- Create: `scripts/verify-orbit-mvp-migration.mjs`

- [ ] **Step 1: Write the failing inventory test**

```ts
expect(activeVersions).toEqual([
  '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009',
  '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018',
]);
expect(sql).toContain('Orbit OS MVP consolidation');
expect(sql).toContain('organization_ai_provider_credentials');
expect(sql).toContain('organization_meta_connections');
```

- [ ] **Step 2: Run the test and confirm it fails because the canonical migration does not exist**

Run: `npx vitest run tests/supabase/orbit-mvp-consolidation.test.ts --pool=forks --maxWorkers=1`

Expected: FAIL referring to the missing canonical migration.

- [ ] **Step 3: Implement the verifier**

```js
// scripts/verify-orbit-mvp-migration.mjs
// Read only root-level NNNN_*.sql files, reject duplicate versions, reject any
// version after 0018, and require the canonical migration markers.
```

- [ ] **Step 4: Run the verifier and test after generating the migration**

Run: `node scripts/verify-orbit-mvp-migration.mjs && npx vitest run tests/supabase/orbit-mvp-consolidation.test.ts --pool=forks --maxWorkers=1`

Expected: verifier prints the 18 active versions and Vitest passes.

### Task 2: Build the single canonical `0018` migration

**Files:**
- Create: `supabase/migrations/20261005124203_orbit_os_mvp_consolidation.sql`
- Move to archive: `supabase/archive/unapplied-0018-0032/`
- Modify: migration-shape tests that refer to retired filenames.

- [ ] **Step 1: Preserve the un-applied source files outside the active migration directory**

```text
supabase/archive/unapplied-0018-0032/
  0018_meta_publisher.sql
  ...
  0032_security_definer_grants.sql
```

- [ ] **Step 2: Produce one ordered SQL body**

The canonical file must embed the final behavior from the archived migrations in dependency order: Meta/Vault, content assets, publish job fixes, OAuth cleanup, race guard, atomic multi-asset writes, publishing hardening, hot-path index, interactive AI usage, logos bucket, API keys, actor metadata, OpenRouter BYOK, and final grants.

- [ ] **Step 3: Add canonical-only security corrections**

```sql
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
revoke all on function public.assign_organization_from_legacy_owner() from public, anon, authenticated;
revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function public.prevent_last_organization_owner_removal() from public, anon, authenticated;
revoke all on function public.prevent_legacy_owner_id_mutation() from public, anon, authenticated;
revoke all on function public.is_owner_profile(uuid) from public, anon;
grant execute on function public.is_owner_profile(uuid) to authenticated, service_role;
```

- [ ] **Step 4: Drop only obsolete legacy RPC overloads after the organization-scoped replacement exists**

The test must assert that legacy three-argument approval and legacy single-asset creation overloads are absent, while the organization-scoped signatures remain. Do not drop the RLS helper functions or `save_aias_organization_profile`.

### Task 3: Generate production preflight and postflight SQL

**Files:**
- Create: `supabase/runbooks/0018-preflight.sql`
- Create: `supabase/runbooks/0018-postflight.sql`
- Create: `docs/runbooks/orbit-os-first-production-pilot.md`

- [ ] **Step 1: Write read-only preflight SQL**

```sql
select version, name from supabase_migrations.schema_migrations order by version;
select schemaname, tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
select count(*) as nonempty_application_tables
from information_schema.tables t
where t.table_schema = 'public'
  and t.table_type = 'BASE TABLE';
```

- [ ] **Step 2: Write postflight SQL that proves the final schema**

```sql
select version, name from supabase_migrations.schema_migrations order by version;
select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef order by p.proname;
```

- [ ] **Step 3: Document the apply command as a separately authorized action**

```text
Only after preflight matches the recorded baseline and Axel explicitly approves:
apply `20261005124203_orbit_os_mvp_consolidation.sql` through the authenticated Supabase MCP.
```

### Task 4: Verify application contracts against the canonical migration

**Files:**
- Modify: `tests/content/meta-publisher-migration.test.ts`
- Modify: `tests/content/content-item-assets-atomic-migration.test.ts`
- Modify: `tests/content/intake-suggestions-migration.test.ts`
- Modify: `tests/organizations/api-keys-migration.test.ts`
- Modify: `tests/organizations/actor-metadata-migration.test.ts`
- Modify: `tests/organizations/multi-asset-actor-metadata-migration.test.ts`
- Create: `tests/supabase/production-rpc-contract.test.ts`

- [ ] **Step 1: Update the migration tests to load the canonical file**

```ts
const path = fileURLToPath(
  new URL('../../supabase/migrations/20261005124203_orbit_os_mvp_consolidation.sql', import.meta.url),
);
```

- [ ] **Step 2: Add a contract test for the RPCs used by the repository**

```ts
expect(sql).toContain('create_content_item_with_assets_in_organization');
expect(sql).toContain('apply_publication_diagnosis');
expect(sql).toContain('configure_organization_openrouter_credential');
expect(sql).toContain('resolve_meta_connection_for_publish');
```

- [ ] **Step 3: Run focused tests, type checking, lint and production build**

Run: `npx vitest run tests/supabase tests/content tests/organizations tests/api tests/worker --pool=forks --maxWorkers=1`

Run: `npx tsc --noEmit && npx eslint app lib worker tests scripts && npm run build`

Expected: all focused tests, type checks, lint and build pass.

### Task 5: Prepare the first-pilot operational package

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/runbooks/orbit-os-permission-and-secrets-checklist.md`

- [ ] **Step 1: Separate required values by responsibility**

```text
Browser: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
Server/worker: SUPABASE_SERVICE_ROLE_KEY, worker health token
Per organization: OpenRouter BYOK via Vault-backed UI; never environment-wide client keys
Meta: OAuth app credentials/server callback only; page tokens only in Vault
```

- [ ] **Step 2: Add an enablement gate**

```text
SNAPGAD_META_PUBLISH_WORKER_ENABLED=false until a test page has completed a reviewed publication.
```

- [ ] **Step 3: Create tomorrow's exact execution checklist**

The runbook must require: read-only preflight, explicit approval, one DDL application, postflight SQL, security advisors, two-user/two-organization RLS test, one OpenRouter generation, and one manual Meta review path. A failure at any gate keeps publishing disabled.

### Task 6: Final review and handoff

**Files:**
- Modify: `docs/vault/08-multitenant-security-hardening-2026-09-21.md`
- Create: `docs/vault/09-production-preparation-2026-10-05.md`

- [ ] **Step 1: Record implemented versus remote-applied state without credentials**
- [ ] **Step 2: Run `git diff --check` and record exact test/build outputs**
- [ ] **Step 3: Review no secret value is present in tracked changes**
- [ ] **Step 4: Present the one explicit production migration approval gate to Axel**

## Review checklist

- The active migration folder contains `0001`–`0018` exactly once each.
- The remote database is untouched until the explicit P2 approval.
- No page token, OpenRouter key, service key, database URL or OAuth secret appears in source, docs, test fixtures or command output.
- Trigger-only functions are not executable through PostgREST.
- RLS helpers retain only the grants necessary for policies to evaluate.
- Human review remains required before any public post or paid promotion.
