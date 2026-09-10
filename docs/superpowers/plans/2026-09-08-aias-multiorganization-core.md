# SnapGad AIAS Multi-Organization Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform SnapGad Content OS into a simple AI-operated SaaS where each user can manage multiple organizations, configure a business-specific pitch once, receive contextual copy recommendations, approve content, and publish through OAuth-connected channels without making n8n part of the daily path.

**Architecture:** Keep Next.js as the control plane and Supabase/Postgres as the source of truth. Add a small internal worker process that consumes durable jobs for copy generation and publication; retain n8n only as an explicitly configured escape hatch for complex external automations. Use provider adapters for OpenRouter, Meta, and asset storage so the portal stays independent of vendor-specific payloads.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase Auth/Postgres/Storage, Zod, Vitest, Meta OAuth + Graph API, OpenRouter, optional n8n webhook adapter.

---

## Current boundaries to preserve

- Demo mode remains network-free when Supabase variables are absent.
- `organization_id` is the tenant boundary; `owner_id` is compatibility data only.
- Browser code never receives service-role keys, Meta secrets, or provider tokens.
- Every publication remains approval-gated and idempotent.
- Generated copy must use the organization brief and allowed facts; AI output is a draft until approved.
- The portal owns job state, leases, audit events, and remote publication IDs.

## Task 1: Make the AIAS domain explicit

**Files:**
- Create: `lib/aias/contracts.ts`
- Create: `lib/aias/brief.ts`
- Create: `tests/aias/brief.test.ts`
- Modify: `lib/content/campaign.ts`
- Modify: `lib/content/contracts.ts`

- [x] Define `AiasOrganizationProfile` with `businessName`, `industry`, `subIndustry`, `locations`, `offerings`, `idealCustomer`, `painPoints`, `proofPoints`, `tone`, `forbiddenClaims`, `defaultCta`, and `timezone`.
- [x] Define `AiasWorkflowPreferences` with enabled workflows, approval requirement, default platforms, and publishing windows.
- [x] Add Zod parsing that rejects an empty business identity, empty industry, and unsupported timezone.
- [x] Make campaign briefs resolve their missing pitch fields from the organization profile instead of assuming SnapGad’s pitch.
- [x] Add tests proving two organizations with different profiles generate different prompt context and that forbidden claims survive into validation.

## Task 2: Onboarding and multiple organizations per account

**Files:**
- Create: `app/(app)/onboarding/page.tsx`
- Create: `app/(app)/settings/organizations/page.tsx`
- Create: `app/api/organizations/route.ts`
- Create: `app/api/organizations/[id]/profile/route.ts`
- Create: `lib/organizations/active-organization.ts`
- Create: `tests/organizations/active-organization.test.ts`
- Modify: `lib/content/repository-factory.ts`
- Modify: `proxy.ts`
- Modify: `supabase/migrations/0008_tenancy_foundation.sql`

**Progress:** The tenant-safe resolver now accepts an optional active-organization hint only after matching it against authenticated memberships. The signed-cookie codec, `GET /api/organizations`, selector visual y pantallas no destructivas de onboarding/organizaciones están en el worktree. La creación, edición persistente y redirect por perfil completo siguen pendientes hasta definir migración y staging.

**Progress (2026-09-09):** Añadida la API autenticada de perfil AIAS en `/api/organizations/[id]/profile` con GET/PUT/PATCH, membership por usuario autenticado, roles owner/editor, validación de versión y respuestas no-cache. Onboarding y settings ya renderizan el formulario y guardan por organización cuando Supabase público está configurado; modo demo permanece sin red. Sigue pendiente probarlo contra Supabase real.

- [x] Replace the current “reject if more than one membership exists” behavior with a validated active-organization selector stored in a signed, server-readable cookie.
- [x] Resolve the active organization only after checking `organization_members` for the authenticated user.
- [ ] Redirect a new user to onboarding until the organization profile is complete.
- [ ] Support creating a new organization, switching organizations, renaming one, and editing its profile without accepting arbitrary tenant IDs from the browser.
- [ ] Add RLS tests for user A, user B, and a user who belongs to two organizations.

## Task 3: Persist the AIAS profile and brand rules

**Files:**
- Create: `supabase/migrations/0011_aias_profiles.sql`
- Create: `lib/organizations/profile-repository.ts`
- Create: `app/api/organizations/[id]/profile/route.test.ts`
- Modify: `supabase/migrations/0008_tenancy_foundation.sql`

- [ ] Extend `organization_brand_profiles` with structured columns or a versioned JSON contract for pitch, tone, prohibited claims, CTA rules, and customer language.
- [ ] Store a `profile_version` and create an audit event whenever the profile changes.
- [ ] Add a default profile only for newly created organizations; never copy SnapGad’s profile into a client organization.
- [ ] Make copy jobs snapshot the profile version used for generation so later edits do not rewrite historical provenance.

**Progress (2026-09-09):** El contrato local `AiasProfileRepository` ya está implementado y revisado con versionado optimista, hash SHA-256, auditoría aislada por organización, snapshots inmutables y validación JSON acíclica. Sigue pendiente la migración `0011`, la ruta autenticada y el adaptador durable de Supabase; este bloque no se considera persistencia de producción.

**Progress (2026-09-09, staging-prep):** Creada la migración aditiva `0011_aias_profiles.sql` y el adaptador `SupabaseAiasProfileRepository`. La migración elimina la escritura directa `FOR ALL` heredada de 0008 para dejar lectura por miembros y escritura AIAS únicamente vía RPC con `auth.uid`, rol owner/editor, advisory lock, `expectedVersion`, historial append-only y hash canonicalizado. El formulario ya está conectado a onboarding/settings cuando Supabase público está configurado. No ha sido aplicada ni probada contra una instancia Supabase real.

## Task 4: Internal job runner, with n8n as optional escape hatch

**Files:**
- Create: `worker/index.ts`
- Create: `worker/job-runner.ts`
- Create: `worker/providers/copy-provider.ts`
- Create: `worker/providers/publish-provider.ts`
- Create: `worker/health.ts`
- Create: `tests/worker/job-runner.test.ts`
- Modify: `lib/automation/jobs.ts`
- Modify: `supabase/migrations/0010_automation_jobs.sql`
- Modify: `package.json`

- [x] Add `RETRY_WAIT`, `CANCELLED`, `run_at`, `next_attempt_at`, `last_error`, and `provider` to the job contract.
- [x] Add atomic claim, lease renewal, success completion, failure completion, cancellation, and expired-lease recovery RPCs.
- [x] Implement a long-running Node worker that polls Postgres, processes one job at a time per organization, and exits non-zero on unrecoverable configuration errors.
- [x] Add exponential backoff with a maximum attempt count and a visible dead-letter state.
- [x] Keep the existing n8n request bridge behind its explicit URL/secret configuration and the reviewed `SNAPGAD_PUBLISH_WORKER_ENABLED` flag; no ordinary copy or publish job may require it.
- [x] Add `npm run worker`, polling/heartbeat/recovery, and the token-gated health endpoint that reports queue lag, active leases, and last successful run. The explicit processor module is still a required deployment input.

**Progress (2026-09-09):** El kernel local en memoria ya cubre estados, idempotencia por organización/kind/key, leases, recuperación, reintentos con backoff, dead-letter, cancelación, clonación profunda, health y providers inyectables. Fue revisado para exigir ownership por `organizationId` y `leaseToken`. Sigue pendiente el store durable/RPC en Supabase, el proceso persistente y el endpoint operativo; no es todavía un worker de producción.

**Progress (2026-09-09, lifecycle-contract):** Añadidos `lib/automation/durable-job-contract.ts`, `SupabaseCopyWorkerStore` y `supabase/migrations/0013_automation_job_lifecycle.sql` como frontera tipada, adapter server-only y migración aditiva preparada. El contrato formaliza `runAt`, `nextAttemptAt`, `provider`, estados de retry/cancel/dead-letter y ownership de lease. La migración contiene RPCs de claim/renew/fail/cancel/recovery/health; `worker/durable-runner.ts` y `worker/entrypoint.ts` ya ofrecen polling persistente, heartbeat y arranque fail-closed con módulo de processor explícito. Todo está cubierto con tests aislados, pero la migración aún no se aplica ni el processor se valida contra Supabase real; sólo se acepta después de staging.

**Quality notes:** Antes de procesar proveedores de larga duración, el worker persistente debe añadir renovación automática/heartbeat del lease. `markFailed` es helper interno y no debe exponerse directamente; la persistencia durable debe conservar el ownership atómico del lease.

## Task 5: Provider-specific diagnosis and copy generation

**Files:**
- Create: `lib/aias/publication-diagnosis.ts`
- Create: `lib/providers/openrouter.ts`
- Create: `tests/aias/publication-diagnosis.test.ts`
- Modify: `app/api/integrations/n8n/copy/route.ts`
- Modify: `lib/integrations/n8n-client.ts`
- Modify: `lib/content/final-copy.ts`

- [ ] Build a deterministic diagnostic input containing organization profile, campaign brief, asset metadata, target platform, funnel stage, offer, CTA, and allowed facts.
- [ ] Ask the model for structured output: `pain`, `consequence`, `desired_outcome`, `proof_used`, `copy`, `cta`, `risk_flags`, and `platform_adaptation`.
- [ ] Validate output against allowed facts and forbidden claims before it can enter review.
- [ ] Store the model/provider/model-version/profile-version metadata with every draft.
- [ ] Keep one primary recommendation plus one alternative; do not generate uncontrolled copy batches.

**Progress:** `lib/aias/publication-diagnosis.ts` ya ofrece un diagnóstico puro y determinista para perfil + señal + canal/objetivo. Valida la entrada con Zod, marca hallazgos por severidad, bloquea claims en conflicto y no permite `readyForCopy` sin dolor, proof y CTA verificables. La llamada al proveedor, snapshot de versión y generación de copy todavía no están implementados.

**Quality gate:** La revisión de calidad cerró el bypass por aliases, CTA narrativo, urgencia/rankings y whitespace. El diagnóstico permanece deliberadamente sin efectos y requiere revisión humana; aún no es un proveedor de copy.

## Task 6: OAuth integrations and Meta publication

**Files:**
- Create: `app/api/integrations/meta/oauth/start/route.ts`
- Create: `app/api/integrations/meta/oauth/callback/route.ts`
- Create: `app/(app)/settings/integrations/meta/page.tsx`
- Create: `lib/integrations/meta/oauth.ts`
- Create: `lib/integrations/meta/publisher.ts`
- Create: `tests/integrations/meta/oauth.test.ts`
- Create: `tests/integrations/meta/publisher.test.ts`
- Create: `supabase/migrations/0012_integration_credentials.sql`
- Modify: `lib/integrations/meta-publisher.ts`

- [ ] Use OAuth for onboarding, but keep the actual Graph API calls server-side; OAuth is authorization, not a replacement for the API.
- [ ] Store only encrypted credential references and non-secret metadata per organization.
- [ ] Support one Facebook Page connection and one linked professional Instagram account first.
- [ ] Implement Facebook publication and Instagram container → status → publish as separate provider methods.
- [ ] Resolve permissions based on the selected Meta login mode instead of hardcoding both scope families.
- [ ] Require an approved target and a fresh publication preflight before any remote call.
- [ ] Persist remote post IDs, remote URLs, provider error codes, and timestamps.

## Task 7: Asset storage and Meta delivery

**Files:**
- Create: `lib/storage/asset-storage.ts`
- Create: `lib/storage/supabase-storage.ts`
- Create: `lib/storage/local-disk-storage.ts`
- Create: `app/api/assets/[id]/delivery/route.ts`
- Create: `tests/storage/asset-storage.test.ts`
- Modify: `app/api/content/route.ts`
- Modify: `lib/content/asset-validation.ts`

- [ ] Keep Supabase Storage as the first production adapter.
- [ ] Add local disk only as an explicit self-hosted adapter under a configured root directory; never expose filesystem paths.
- [ ] Add a just-in-time, signed delivery URL for Meta publication.
- [ ] Normalize PNG/WEBP to JPEG for Instagram while preserving the original asset.
- [ ] Record checksum, normalized derivative, dimensions, MIME type, and storage provider.
- [ ] Add cleanup for abandoned uploads and organization quotas.
- [ ] Treat Google Drive as a later import/export connector, not runtime storage.

## Task 8: AIAS workspace UX

**Files:**
- Create: `app/(app)/ai-assistant/page.tsx`
- Create: `app/(app)/calendar/page.tsx`
- Create: `components/aias/next-action-card.tsx`
- Create: `components/aias/organization-switcher.tsx`
- Modify: `components/layout/app-shell.tsx`
- Modify: `app/(app)/library/page.tsx`
- Modify: `app/(app)/history/page.tsx`

- [ ] Make the default home screen a “next best action” workspace, not a form.
- [ ] Show profile completeness, assets awaiting diagnosis, copy awaiting review, scheduled publications, and failed jobs.
- [ ] Add a calendar for approved/scheduled content; do not add drag-and-drop workflow programming yet.
- [ ] Show the selected organization in every mutating screen.
- [x] Create and integrate the reusable organization switcher for Supabase-configured workspaces.
- [ ] Let the AI recommend what to publish next based on past content, but require user approval for publication.

## Removal gate for n8n

- [ ] Internal worker processes 20 copy jobs with no duplicate completions.
- [ ] Expired leases recover successfully after worker restart.
- [ ] One approved Facebook post and one approved Instagram post succeed in staging.
- [ ] Multi-organization isolation passes automated tests.
- [ ] Storage delivery URLs work from an external Meta request.
- [ ] Only after these checks: archive the n8n export, disable its bridge, and remove it from the default deployment.

## Explicitly out of scope for this release

- Generic visual workflow builder.
- Ads Manager automation.
- CRM, ERP, analytics warehouse, and inbox replacement.
- Google Drive as primary storage.
- Autonomous publishing without approval.
- Multi-provider social network expansion before Facebook + Instagram are reliable.
