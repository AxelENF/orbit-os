# Orbit OS Pilot Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the deployed Orbit OS schema to a real SnapGad owner account and verify the full internal content workflow before enabling any external publisher.

**Architecture:** Supabase is the source of truth for auth, tenant isolation, assets and AI credentials. The Next.js portal uses server-only service-role operations after session validation; OpenRouter credentials are encrypted per organization through BYOK. Publishing remains human-reviewed and manual until OAuth and worker smoke tests pass.

**Tech Stack:** Next.js 16, TypeScript, Supabase Auth/Postgres/Storage/Vault, OpenRouter BYOK, Meta Graph OAuth, Vitest.

---

## Current production state

- GitHub branch: `integration/main-consolidation`, commit `d57c7bf`.
- Supabase schema: `0001`–`0017` plus `20261005124203_orbit_os_mvp_consolidation`.
- Database is empty and all application tables have RLS enabled.
- Native Meta publishing and the legacy n8n bridge are disabled by default.
- No `.env.local` exists on the current development machine, so the app cannot yet connect to the real Supabase/Auth project.

### Task 1: Configure a secure local runtime

**Files:**
- Create locally only: `.env.local` (must remain gitignored)
- Read: `.env.example`
- Verify: `lib/supabase/client.ts`, `lib/supabase/server.ts`

- [ ] **Step 1: Copy the template without committing it.**

```powershell
Copy-Item .env.example .env.local
```

- [ ] **Step 2: Fill the minimum SnapGad pilot values from Supabase Project Settings → API.**

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-or-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET=<32-or-more-random-characters>
SNAPGAD_WORKER_HEALTH_TOKEN=<32-or-more-random-characters>
```

Never place any of these in `NEXT_PUBLIC_*`, Git, screenshots, or chat.

- [ ] **Step 3: Keep every external publisher disabled for this pilot.**

```dotenv
SNAPGAD_META_PUBLISH_WORKER_ENABLED=false
SNAPGAD_N8N_PUBLISH_ENABLED=false
```

- [ ] **Step 4: Start the portal and prove Supabase is reachable.**

```powershell
npm run dev
```

Expected: `http://localhost:3000` opens without falling back to placeholder credentials.

- [ ] **Step 5: Commit only code or docs if anything changed.**

```powershell
git status --short
git add <changed-safe-files>
git commit -m "chore: document pilot runtime setup"
```

### Task 2: Bootstrap SnapGad as tenant zero

**Files:**
- Read: `app/onboarding/page.tsx`, `app/organizations/page.tsx`
- Verify: `public.organizations`, `public.organization_members`, `public.organization_brand_profiles`

- [ ] **Step 1: Create the owner through the configured Supabase Auth flow.**

Use one controlled SnapGad email, enable email confirmation if the project is publicly reachable, and use a unique password managed outside the repository.

- [ ] **Step 2: Complete onboarding with one organization.**

Use `SnapGad Technology` as the first organization. Do not create test organizations yet; tenant isolation is easier to validate from a clean owner account first.

- [ ] **Step 3: Fill the AIAS profile with factual positioning.**

Enter services, target niches, offer, CTA, voice, forbidden claims and allowed facts. Keep ROI, prices, guarantees and testimonials empty unless they are substantiated.

- [ ] **Step 4: Verify the tenant records with a read-only query.**

```sql
select o.name, m.role, p.version
from public.organizations o
join public.organization_members m on m.organization_id = o.id
left join public.organization_brand_profiles p on p.organization_id = o.id;
```

Expected: one organization, one `owner` membership, one versioned brand profile.

### Task 3: Validate the internal content loop

**Files:**
- Read: `app/library/new/page.tsx`, `app/review/page.tsx`, `worker/providers/copy-processor.ts`
- Test: `tests/content/intake-suggestions.test.ts`, `tests/worker/copy-processor.test.ts`

- [ ] **Step 1: Upload one non-sensitive SnapGad asset.**

Use a final, brand-approved image. Confirm it appears only inside the SnapGad organization library.

- [ ] **Step 2: Create one direct-sale content item.**

Use a factual offer and a WhatsApp destination. Do not activate a paid Meta campaign in this step.

- [ ] **Step 3: Configure the organization OpenRouter BYOK credential through the portal.**

Confirm the UI displays only status/model information and never displays the raw key after saving.

- [ ] **Step 4: Generate one copy and inspect its diagnosis.**

Expected: generated variants are scoped to the active organization, use the configured profile, and do not invent unsupported performance claims.

- [ ] **Step 5: Approve one final version and record a manual delivery.**

Expected: history, audit event and target state show the same content item and organization.

- [ ] **Step 6: Run focused regression before considering any publisher.**

```powershell
npx vitest run tests/content/intake-suggestions.test.ts tests/worker/copy-processor.test.ts --pool=forks --maxWorkers=1
```

Expected: passing tests. Fix failures before activating integrations.

### Task 4: Validate tenant isolation before onboarding a client

**Files:**
- Read: `supabase/runbooks/0018-postflight.sql`
- Test: `tests/supabase/orbit-mvp-consolidation.test.ts`

- [ ] **Step 1: Create a second controlled Auth user and a second test organization.**

This must be a test-only account with no real client data.

- [ ] **Step 2: Upload an asset under each organization.**

Use distinct filenames and no shared IDs.

- [ ] **Step 3: Verify cross-tenant reads are blocked through the browser session, not service role.**

Expected: the first user cannot browse assets, drafts, profile data, API keys or credentials of the second organization.

- [ ] **Step 4: Remove test-only data after recording results.**

Do this through the portal or a narrowly scoped, reviewed SQL operation; never bulk-delete production tables.

### Task 5: Prepare Meta only after the manual loop is proven

**Files:**
- Read: `app/api/integrations/meta/connect/route.ts`, `app/api/integrations/meta/callback/route.ts`, `app/api/integrations/meta/status/route.ts`
- Verify: `public.organization_meta_connections`, `public.organization_meta_oauth_sessions`

- [ ] **Step 1: Register the exact callback URL in Meta Developers.**

Use the deployed HTTPS portal URL, not localhost, for the production callback. Configure the same URL in `META_APP_ID` and `META_APP_SECRET` runtime environment only.

- [ ] **Step 2: Connect a SnapGad-owned test page first.**

Confirm the portal status endpoint reports metadata only; page access tokens must stay in Vault.

- [ ] **Step 3: Keep the publish worker disabled during OAuth validation.**

```dotenv
SNAPGAD_META_PUBLISH_WORKER_ENABLED=false
```

- [ ] **Step 4: Enable publishing only after a reviewed staging post succeeds.**

Use an organic, non-paid post. Confirm the remote post ID, content item status and audit event before any campaign budget is added.

### Task 6: Production handoff and routine operation

**Files:**
- Read: `docs/runbooks/orbit-os-first-production-pilot.md`
- Read: `docs/runbooks/orbit-os-permissions-and-secrets-checklist.md`

- [ ] **Step 1: Deploy the exact GitHub commit `d57c7bf` or a later reviewed commit.**

```powershell
git log -1 --oneline
```

- [ ] **Step 2: Add production secrets in the host dashboard, never the repository.**

Use the same variable names from Task 1 and re-check that no server-only secret has a `NEXT_PUBLIC_` prefix.

- [ ] **Step 3: Schedule a weekly operational review.**

Review failed jobs, AI spend, rejected copy, manual publication results and security/performance advisors. Add indexes only after real query patterns justify them.

- [ ] **Step 4: Onboard clients only after Task 4 passes.**

Each client gets its own organization, membership roles, profile and provider credential. Never reuse SnapGad keys or assets across tenants.

## Acceptance criteria

The internal MVP is ready when a SnapGad owner can sign in, onboard an organization, upload an image, generate a fact-safe copy with its own key, approve it, record a manual publication, and see its full tenant-scoped audit trail. Meta autopublishing and client onboarding are separate gates, not prerequisites for the first internal marketing workflow.
