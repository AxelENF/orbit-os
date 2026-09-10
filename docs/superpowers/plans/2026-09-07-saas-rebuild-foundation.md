# SnapGad Content OS SaaS Rebuild Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current single-owner demo foundation into a tenant-safe,
job-driven product core without enabling real publication.

**Architecture:** Supabase becomes the system of record. Server routes resolve
the current organization from a membership, persist an atomic automation job,
and give n8n a signed worker contract instead of database access. Existing
demo mode remains local-only behind the repository adapter.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Supabase Postgres/Auth/
Storage, Vitest, n8n webhook HMAC.

---

## File structure

- `lib/organizations/context.ts` — authenticated organization/role resolution.
- `lib/organizations/permissions.ts` — role checks used only server-side.
- `lib/automation/jobs.ts` — typed job states and HMAC payload helpers.
- `app/api/internal/jobs/[id]/claim/route.ts` — signed worker claim endpoint.
- `app/api/internal/jobs/[id]/complete/route.ts` — signed worker callback.
- `supabase/migrations/0008_tenancy_foundation.sql` — organizations,
  memberships, Brand OS, integrations and RLS helpers.
- `supabase/migrations/0009_tenantize_content_and_jobs.sql` — tenant columns,
  job table, backfill, RLS replacement and atomic RPCs.
- `tests/organizations/context.test.ts` — access resolution behavior.
- `tests/automation/jobs.test.ts` — state/idempotency behavior.
- `tests/api/worker-jobs.test.ts` — callback/claim boundary.

### Task 1: Stabilize the current baseline

**Files:**
- Modify: `components/content/draft-editor.tsx`
- Modify: `proxy.ts`
- Modify: `tests/api/content-create.test.ts`
- Test: `tests/components/draft-editor.test.tsx`

- [ ] Write a failing test that loads a record containing `finalCopy`, changes
  to a second record, and asserts the form derives visible copy from the
  current record without synchronously setting state inside an effect.
- [ ] Run `npm test -- --run tests/components/draft-editor.test.tsx` and
  confirm the test fails because the derivation helper is absent.
- [ ] Extract a pure `toEditableFinalCopy(record)` helper, initialise/reset
  editor draft state only from explicit record-load events, and replace the
  mutable `response` in `proxy.ts` with `const`.
- [ ] Remove the unused `_campaignName` destructuring in the test fixture.
- [ ] Run `npm test -- --run`, `npm run lint`, `npm run build`, and
  `git diff --check`; each must exit successfully before the next task.

### Task 2: Add organization and Brand OS foundations

**Files:**
- Create: `lib/organizations/context.ts`
- Create: `lib/organizations/permissions.ts`
- Create: `supabase/migrations/0008_tenancy_foundation.sql`
- Test: `tests/organizations/context.test.ts`

- [ ] Write tests for `requireOrganizationContext`: an authenticated owner
  resolves an organization, a non-member receives `OrganizationAccessError`,
  and an editor cannot perform an owner-only action.
- [ ] Run `npm test -- --run tests/organizations/context.test.ts`; expect a
  missing-module failure.
- [ ] Implement exact roles `owner | editor | reviewer | viewer`; export
  `canEditCampaign`, `canApproveCampaign` and `canManageConnections`.
- [ ] Add migration tables `organizations`, `organization_members`,
  `organization_brand_profiles`, and `organization_integrations`. Tokens are
  represented only by `credential_handle`; no token column is readable through
  RLS. Add `is_organization_member(org_id)` and role-aware policies.
- [ ] Add a deterministic backfill function that creates one SnapGad tenant
  and membership for each current `content_items.owner_id`, preserving
  `owner_id` as `created_by_id` rather than trusting a request field.
- [ ] Run the focused tests, then full tests and lint.

### Task 3: Tenantize campaign persistence

**Files:**
- Create: `supabase/migrations/0009_tenantize_content_and_jobs.sql`
- Modify: `lib/content/repository.ts`
- Modify: `lib/supabase/repository.ts`
- Modify: `lib/content/repository-factory.ts`
- Test: `tests/content/repository-contract.test.ts`
- Test: `tests/content/supabase-repository.test.ts`

- [ ] Write a repository contract test in which two organization contexts use
  the same content id space and verify reads, assets and targets from org A
  are invisible to org B.
- [ ] Run the focused tests and confirm they fail before implementation.
- [ ] Add `organization_id NOT NULL` to every content-domain table, backfill
  via memberships, add composite indexes, migrate private storage paths to
  `organization_id/asset_id/filename`, and replace owner RLS with membership
  RLS. Do not drop existing owner columns in this migration.
- [ ] Change the repository constructor to accept trusted
  `OrganizationContext`; its methods never accept an organization id from a
  client payload. Map legacy `ownerId` to `createdById` only in audit output.
- [ ] Add one summary query for campaign lists so list pages do not issue one
  full-record request per campaign.
- [ ] Run targeted tests, `npm test -- --run`, `npm run lint` and build.

### Task 4: Replace n8n database access with atomic jobs

**Files:**
- Create: `lib/automation/jobs.ts`
- Create: `app/api/internal/jobs/[id]/claim/route.ts`
- Create: `app/api/internal/jobs/[id]/complete/route.ts`
- Modify: `lib/integrations/n8n-client.ts`
- Modify: `app/api/integrations/n8n/copy/route.ts`
- Modify: `app/api/integrations/n8n/publish/route.ts`
- Modify: `n8n/SnapGad-Content-Engine-V1.json`
- Test: `tests/automation/jobs.test.ts`
- Test: `tests/api/worker-jobs.test.ts`

- [ ] Write tests proving only one claim transitions a job from `QUEUED` to
  `PROCESSING`, a duplicated callback is idempotent, an expired signature is
  rejected, and the worker cannot submit another organization’s job.
- [ ] Run the new tests and confirm they fail.
- [ ] Create `automation_jobs` with `organization_id`, `content_item_id`,
  `target_id`, `kind`, `status`, `idempotency_key`, `payload_version`,
  `result`, `error`, `claimed_at` and audit timestamps. Add one RPC that
  atomically claims `QUEUED` work and one that completes only the claimed job.
- [ ] Make portal requests send only `jobId`, timestamp and HMAC. The claim
  route resolves signed asset URL, stored brief and active final copy from the
  job’s database record; it never accepts `assetUrl`, `copy`, `ownerId` or
  `organizationId` from n8n/browser input.
- [ ] Remove `SUPABASE_SERVICE_ROLE_KEY` and direct database HTTP nodes from
  the exported n8n workflow. Its idempotency decision becomes the portal claim
  response, fixing the current self-duplicate bug.
- [ ] Keep publish jobs disabled: `complete` can persist a dry-run result but
  cannot call Meta until a tenant connection is implemented.
- [ ] Run full tests/lint/build and document the exact n8n environment names
  without committing any secret.

### Task 5: Consolidate active documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/n8n/content-copy-workflow.md`
- Modify: `docs/n8n/content-publish-workflow.md`
- Create: `docs/architecture/content-os-current-state.md`

- [ ] Replace contradictory statements about active workflows and migrations
  with the job contract, tenant boundary, local/demo definition and staging
  checklist.
- [ ] Mark historical design docs as superseded through their headers; retain
  them for traceability rather than deleting them.
- [ ] Run `git diff --check` and full verification.

## Completion criteria

No client data is scoped by caller-provided tenant data, n8n cannot reach
Supabase directly, jobs survive retries safely, and all local tests/lint/build
pass. No Meta publication is enabled by this plan.
