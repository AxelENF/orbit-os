# Multitenant security hardening — 2026-09-21

## What is now implemented in the repository

- Pending Meta migrations no longer define plaintext `page_access_token` or
  `user_long_lived_token` columns. They use Supabase Vault references and
  service-role-only resolver/write RPCs instead.
- Meta OAuth callback and page-selection routes use the Vault-backed RPC
  contract. Nonce cookie, organization, membership, session creator, and
  expiry are checked before an OAuth selection can be completed.
- OpenRouter is BYOK per organization. A raw API key is encrypted in Vault;
  browser and normal authenticated calls receive only a sanitized status.
  The copy worker and visual-intake path resolve the credential for the job's
  actual organization immediately before the provider request.
- Absent, revoked, or failed BYOK configuration fails closed: copy generation
  does not call OpenRouter; optional intake suggestions return no suggestion
  and spend nothing.
- Trigger-only security-definer functions receive explicit revoke rules. The
  RLS membership helpers remain executable only where current RLS policies
  need them.
- Native Meta worker and optional n8n publication bridge have independent,
  opt-in flags: `SNAPGAD_META_PUBLISH_WORKER_ENABLED` and
  `SNAPGAD_N8N_PUBLISH_ENABLED`.

## Ordered migration batch

The remote project previously stopped at `0017`. Apply, in lexical order:

1. amended `0018_meta_publisher.sql` through `0030_actor_metadata_for_multi_asset_rpc.sql`;
2. `0031_organization_openrouter_byok_credentials.sql`;
3. `0032_security_definer_grants.sql`.

Do not connect a real Meta account or submit an OpenRouter key until the batch
has completed and the post-apply checks have passed.

## Validation completed locally

- TypeScript: `npx tsc --noEmit`.
- Targeted ESLint on all security/runtime changes.
- Targeted Vitest: 6 files, 80 tests passed.
- Production build: `npm run build`.

The unrestricted whole-suite runner can hang on this workstation's worker
pool. The same high-risk tests pass deterministically with one forked worker;
investigate the runner-pool issue separately rather than treating it as a
security failure.

## Remaining external operation

The Supabase MCP OAuth session expired on 2026-09-21. Its current dynamic
registration attempt is rejected by Supabase for requesting unsupported
scopes, so remote migration application and post-apply RLS/advisor checks are
blocked until the connector is reauthenticated/fixed. No remote schema change
was attempted after that failure.

## Post-apply proof checklist

1. Confirm migration history reaches `0032` and public tables have RLS.
2. Verify neither Meta plaintext token column exists.
3. Confirm `anon` and `authenticated` cannot execute service-only secret
   resolvers or read secret-link tables.
4. Run two-user/two-organization denial tests before using a real client.
5. Configure SnapGad's own BYOK credential and a non-production Meta page;
   leave direct publish disabled until a manual approval test succeeds.
