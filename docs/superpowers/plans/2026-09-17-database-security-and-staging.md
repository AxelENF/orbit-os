# Database Security and Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orbit's Supabase schema reproducible, encrypt every organization-scoped Meta OAuth token at rest, and prove a full staging path before any customer connection is enabled.

**Architecture:** Preserve migrations `0001`–`0030` exactly as historical input. Add a new additive migration that moves permanent Page tokens and temporary OAuth user tokens into Supabase Vault, with IDs—not plaintext—stored in Orbit tables. The worker receives a decrypted token only through service-role-only database functions while claiming a job; browser and MCP clients never receive it.

**Tech Stack:** Next.js 16, TypeScript, Supabase Postgres/RLS/Storage/Vault, Vitest, Supabase CLI.

---

### Task 1: Establish the real migration baseline before changing data

**Files:**
- Create: `scripts/verify-supabase-baseline.mjs`
- Create: `docs/vault/08-supabase-staging-evidence.md`
- Test: `tests/scripts/verify-supabase-baseline.test.ts`

- [ ] Write a failing test that rejects a migration listing with a gap, duplicate version, or a remote version that does not exist in `supabase/migrations`.
- [ ] Implement `scripts/verify-supabase-baseline.mjs` to read filenames matching `NNNN_*.sql`, invoke `npx supabase migration list --linked --output json`, and output only versions plus status. It must never print database URLs or environment values.
- [ ] Run `npm test -- tests/scripts/verify-supabase-baseline.test.ts`; expect pass.
- [ ] With a separately configured staging project, run `node scripts/verify-supabase-baseline.mjs` and save only the version comparison and UTC timestamp in `docs/vault/08-supabase-staging-evidence.md`.
- [ ] If remote stops at `0017`, record `0018`–`0030` as pending. If it differs earlier, stop: do not run `db push` until the divergence is reconciled in a new migration or documented restore plan.
- [ ] Commit with `test: verify Supabase migration baseline`.

### Task 2: Replace plaintext OAuth token columns with Vault references

**Files:**
- Create: `supabase/migrations/0031_vault_meta_connection_tokens.sql`
- Modify: `supabase/migrations/0018_meta_publisher.sql` only through `create or replace function` statements inside `0031`; do not edit the historical file.
- Modify: `lib/automation/supabase-publish-worker-store.ts`
- Test: `tests/content/vault-meta-token-migration.test.ts`
- Test: `tests/worker/supabase-publish-worker-store.test.ts`

- [ ] Write migration-shape tests asserting: `organization_meta_connections` has `page_access_token_secret_id uuid`; OAuth selection sessions have `user_long_lived_token_secret_id uuid`; authenticated/anon roles cannot read `vault.decrypted_secrets`; and only service-role RPCs can claim a decrypted page token.
- [ ] In migration `0031`, enable `supabase_vault` only if absent, add the two Vault ID columns, and add an audit-safe `token_key_version integer not null default 1` to both records. Keep the legacy plaintext columns temporarily for deterministic migration only.
- [ ] Create service-role-only `security definer` helpers with fixed `search_path = public, vault, pg_temp`: one upserts a Vault secret and returns its UUID, one resolves a secret only while claiming a publish job, and one destroys/invalidates a secret reference on disconnect or OAuth-session expiry. Revoke `public`, `anon`, and `authenticated` from each helper; grant only `service_role`.
- [ ] Replace `upsert_meta_connection`, OAuth-session insertion/selection, `claim_next_publish_automation_job`, `revoke_meta_connection`, and cleanup functions through `create or replace function` so their persistent rows contain only secret IDs. The job claim response may contain the decrypted `pageAccessToken`; no table, audit event, or error message may persist it.
- [ ] Backfill non-empty legacy values inside the migration through the service-role helper, then set the old values to an empty string. Do not drop the old columns until a staging restore and one successful OAuth reconnection have passed; schedule their removal in a later additive migration.
- [ ] Update TypeScript parsers so a claimed publish job has the same runtime shape, but errors use stable codes such as `META_TOKEN_SECRET_UNAVAILABLE`, never the provider token or SQL error text.
- [ ] Run the two focused tests, then `npm test -- --run`, `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- [ ] Commit with `feat: encrypt Meta connection tokens with Vault`.

### Task 3: Make environment and deployment contracts truthful

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/vault/01-current-state.md`
- Modify: `docs/vault/05-personal-pilot-production-plan.md`
- Modify: `docs/vault/06-staging-pilot-runbook.md`
- Test: `tests/worker/entrypoint.test.ts`

- [ ] Write an assertion that `.env.example` documents `SNAPGAD_META_PUBLISH_WORKER_ENABLED` and does not document the retired publish-worker flag as active configuration.
- [ ] Replace every operational reference to `SNAPGAD_PUBLISH_WORKER_ENABLED` with `SNAPGAD_META_PUBLISH_WORKER_ENABLED`; keep a short note that the retired name is intentionally ignored by the worker.
- [ ] Document the exact deployment split: web process has Supabase browser/server configuration; worker has service role plus copy/provider configuration; publish worker additionally has `META_APP_ID`, `META_APP_SECRET`, and the explicit enable flag. No value belongs in git.
- [ ] Update README and vault status to distinguish `implemented`, `migration-applied`, `staging-smoked`, and `production-enabled` rather than calling all code either demo or production.
- [ ] Run `npm test -- tests/worker/entrypoint.test.ts` and a repository-wide search confirming the retired flag appears only in a compatibility test or historical documentation note.
- [ ] Commit with `docs: align publish worker deployment contract`.

### Task 4: Apply and smoke-test staging safely

**Files:**
- Modify: `docs/vault/08-supabase-staging-evidence.md`
- Test: `tests/smoke/staging-orbit-flow.md` (manual executable checklist, not an automated credential test)

- [ ] Create a protected staging Supabase project/branch and a non-production Meta test Page/Instagram professional account. Leave `SNAPGAD_META_PUBLISH_WORKER_ENABLED=false` while schema changes are applied.
- [ ] Run the baseline script, then apply pending migrations in order through Supabase CLI. Re-run the baseline script and record the final matched versions.
- [ ] Create two Auth users in different organizations. Verify RLS denies cross-organization campaign, asset, profile, API-key, logo, and result reads.
- [ ] Connect the test Meta account by OAuth. Query only status RPCs as an authenticated user and confirm they reveal no token. Query the table with an admin test connection and confirm plaintext token fields are blank while Vault references exist.
- [ ] Enable the worker only in staging. Upload a private image, create final copy with allowed facts, verify the diagnosis decision, claim and complete a test publish job, and confirm its audit row contains status/IDs/URL but no token.
- [ ] Disconnect the Meta account and verify the Vault reference is invalidated, a subsequent publish job fails closed with `META_TOKEN_SECRET_UNAVAILABLE`, and the UI presents reconnection rather than a raw SQL error.
- [ ] Record UTC timestamps, migration versions, test organization IDs redacted to prefixes, and pass/fail results. Never store tokens, database URLs, or API keys in the evidence file.
- [ ] Commit the redacted evidence with `docs: record staging security smoke`.

### Task 5: Define production release gate

**Files:**
- Modify: `docs/vault/08-supabase-staging-evidence.md`

- [ ] Mark production eligible only when Task 4 passes, Meta app redirect URIs and permissions are confirmed for the deployed domain, monitoring captures worker failures, and the current integration branch is merged through a reviewed pull request.
- [ ] Keep auto-publish disabled for organizations without an active encrypted connection or an `AUTOMATIC_READY` diagnosis. Do not enable ads spend or comment automation in this release.
- [ ] Commit with `docs: define Orbit production release gate`.
