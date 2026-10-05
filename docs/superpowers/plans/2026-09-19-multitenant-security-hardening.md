# Orbit OS multitenant security hardening

> **Execution status:** Active. This plan governs the personal-MVP release before any real Meta account or client-owned AI credential is connected.

## Objective

Turn Orbit OS into an authentically isolated, multi-organization AIAS: each user can operate one or more organizations, each organization owns its content, brand context, assets, publishing connection, AI budget, and optional BYOK provider credential. Public posting remains explicitly human-approved. Secrets never become application rows, job payloads, audit metadata, browser data, or logs.

## Non-negotiable guardrails

- RLS is defense in depth; server APIs must derive actor and active organization from the authenticated session, never from an untrusted request body.
- No client, API response, audit event, automation job, or status endpoint can return an OpenRouter key, Meta page token, or Meta user token.
- Credential writes/readbacks happen only through service-role-only fixed-`search_path` RPCs. Vault references are opaque implementation details.
- Every mutable resource is organization-scoped and uses organization-qualified lookup/update predicates.
- Meta direct publishing stays disabled by default; approval is a hard gate. Paid distribution is still a manual action in Meta Business Suite.
- Tenant-owned OpenRouter credentials replace the current global production key. A global key may only exist as an explicitly disabled local-development fallback.

## Evidence and release boundary

- Remote Supabase is empty and ends at migration `0017`; local migration files `0018`–`0030` are not applied.
- `0018_meta_publisher.sql` would persist Meta tokens in plaintext. It must be corrected **before** it reaches the remote database.
- The current copy worker and intake suggestion path use the global `OPENROUTER_API_KEY`; this cannot ship as a client-billed SaaS flow.
- Supabase’s security advisor reports trigger/helper `SECURITY DEFINER` functions with default executable grants. Trigger-only functions need explicit revokes; RLS helpers must retain only the grants their policies require.

## Delivery phases

### Phase 0 — Freeze the unsafe boundary and document the contract

1. Preserve the user-facing personal-MVP experience in demo mode.
2. Record the migration inventory and security findings in the vault.
3. Treat Meta OAuth and direct publishing as unavailable until Phase 3 verification succeeds.
4. Do not create a Supabase branch automatically: the project is empty, but branch creation may be billable. Use deterministic migration checks locally and remote preflight instead.

### Phase 1 — Harden legacy grants and make pending Meta storage secret-safe

1. Amend un-applied `0018_meta_publisher.sql` and `0021_meta_oauth_session_cleanup.sql`; because the remote has no migrations after `0017` and no rows, this avoids ever creating plaintext token columns.
2. Store only opaque secret references in `organization_meta_connections` and transient OAuth sessions.
3. Add a private/non-exposed storage contract backed by Supabase Vault. Public tables hold metadata and reference ids only.
4. Add fixed-search-path, service-role-only writer/resolver RPCs for:
   - creating an ephemeral OAuth session secret;
   - resolving that temporary secret during page selection;
   - atomically replacing the page-token secret and removing the temporary secret;
   - resolving a page token only for the publishing worker;
   - revocation/rotation without returning a token.
5. Revoke `PUBLIC`, `anon`, and `authenticated` execution from trigger-only security-definer functions. Keep RLS helper execution as narrowly scoped as the policies require.
6. Update callback, page-selection, status, repository, and worker paths to use the new secret-safe contract.

### Phase 2 — Tenant-owned AI credentials and bounded cost control

1. Add a new migration after `0030` for `private.organization_ai_provider_credentials`, keyed by `organization_id`, provider, status, Vault secret reference, model and non-sensitive price/budget configuration.
2. Add service-role-only RPCs to configure, rotate, revoke, resolve, and report a sanitized credential status. The resolved API key exists only in server memory at provider-call time.
3. Replace global OpenRouter resolution in both copy generation and image-intake suggestions with an organization-scoped resolver.
4. Keep budget reservation and settlement per organization; reject disabled/revoked/missing credentials before an external request.
5. Add `Cache-Control: no-store` and input redaction for credential configuration endpoints.

### Phase 3 — RLS/auth and storage hardening

1. Test two-user/two-organization denial cases for every sensitive read/write, OAuth action, publishing claim, asset path, and API key.
2. Bind OAuth preview/selection to both the nonce cookie and the creating actor, not only the organization.
3. Consolidate overlapping permissive RLS policies only after behavioral tests pass; wrap stable auth/helper predicates with `select` where it is correct and index measured tenant hot paths.
4. Harden storage path validation for `organization-logos` and `content-assets`, including safe foreign-org, malformed-path, overwrite, and delete behavior.
5. Validate and namespace user-supplied audit metadata so it cannot overwrite system fields.

### Phase 4 — Runtime, operator, and MCP readiness

1. Unify on `SNAPGAD_META_PUBLISH_WORKER_ENABLED`; remove the stale publish flag from documentation/runtime decisions.
2. Keep n8n as an optional adapter for genuinely complex client flows, not as the source of truth for Orbit’s content lifecycle.
3. Build the Orbit local stdio MCP only over organization-scoped Orbit API v1 endpoints and API keys; it must never expose Supabase, Vault, Meta, or raw provider credentials.
4. Provide readiness diagnostics that state exactly which non-secret setup is incomplete: Supabase auth, active organization, BYOK status, brand profile, storage, Meta connection, review gate, or worker.

## Verification and migration application order

1. Static-review amended SQL and TypeScript; run `npm run lint`, `npm test`, and `npm run build`.
2. Inspect remote migration history and current RLS/advisors immediately before applying.
3. Apply the ordered migration batch `0018`–`0030`, followed by the new hardening migrations, only after the secret-safe replacement is committed.
4. Re-run advisors; verify every public table has RLS and every secret function/table is inaccessible to `anon` and `authenticated`.
5. Run two-tenant integration checks with synthetic users and no real provider/Meta credentials.
6. Only then configure SnapGad’s own organization credential/Meta account and test a manually approved, non-paid draft publication.

## Definition of personal-MVP ready

- A signed-in owner can create/select organizations, maintain the AIAS profile, upload assets, generate a copy draft using that organization’s own AI credential, review/finalize it, and create a manual delivery record.
- A member of Organization A cannot read, mutate, generate for, or publish Organization B’s data.
- Meta and OpenRouter secrets are encrypted in Vault and never observable from browser/API/list/history/audit/job paths.
- Direct posting remains opt-in and can be disabled globally and per organization.
- The app is usable without n8n; n8n integration remains optional for specialized workflows.
