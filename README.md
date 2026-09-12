# SnapGad Content OS

This project starts in demo mode. It does not require external service credentials
and uses an isolated in-memory repository, so it never calls Supabase, n8n, Meta,
or any other service.

Do not commit Supabase, Meta, n8n, or any other real credentials. Use local environment files for future configuration and keep them out of version control.

## Setup

```bash
npm install
npm test
npm run lint
```

## Modes

- **Demo (default):** leave the Supabase variables unset. The app uses the
  in-memory repository and browser-local asset previews for local development
  and tests only. Nothing is uploaded to a remote service.
- **Configured Supabase:** copy `.env.example` to `.env.local` and set
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the
  server-only `SUPABASE_SERVICE_ROLE_KEY`. Signed n8n callbacks additionally
  require `SNAPGAD_N8N_SHARED_SECRET` on both servers. If a public Supabase
  variable is present but the server key is missing, the API fails closed with
  a configuration error instead of silently using demo data. The service-role key is never imported into or
  exposed to the browser.

The database schema is now applied to the connected Supabase project
`zsljrjuebdgcyinexdlj`. The migration history contains
`supabase/migrations/0001_content_os.sql` through
`0017_publication_result_snapshots.sql` (including the enum-only `0012` step),
applied and verified in order with the Supabase CLI. The migrations create
organization-scoped tables, a private `content-assets` storage bucket,
membership RLS policies, AIAS profiles, and portal-owned durable copy jobs.
Migration `0013` adds the worker lifecycle RPCs used by
`SupabaseCopyWorkerStore`. Migration history, critical tables, enum values,
RPCs and the private bucket were verified by read-only queries after the push.
End-to-end RLS behavior with a real Auth user and the application runtime still
requires a separate staging smoke test.

Before starting the real copy worker, set a finite
`organizations.ai_monthly_budget_usd` for the pilot organization through a
reviewed operator session. The worker atomically reserves the configured
maximum request cost before it calls OpenRouter and settles the actual amount
to the append-only usage ledger afterward. This does not enable Meta posting:
all publication remains human-approved and manual-assisted.

The n8n callback route uses HMAC authentication and a service-role repository,
not a browser session. Its database RPC derives `owner_id` from the locked
content item and atomically records idempotency, both copy alternatives, a
sanitized audit event, and the `GENERATING` to `DRAFT` transition.

Audit events are immutable. Their related profile, content item, and publication
target references use `RESTRICT`, so those records cannot be deleted while an
audit event depends on them.

## Initial owner bootstrap

The migration creates and backfills profiles as `reviewer`, and clients cannot
change roles. After identifying the intended user's Auth UUID, an operator with
server/database access promotes that UUID to `owner` in `public.profiles`.
Do this through a reviewed, privileged runbook; never from the browser and never
by hardcoding an email in a migration. Only an `owner` profile can invoke the
protected content-creation RPC.

```sql
-- Run only through a privileged operator session after verifying this Auth UUID.
update public.profiles
set role = 'owner'
where id = '<auth-user-uuid>';
```

Automation idempotency is scoped to `(kind, idempotency_key)`: a copy or
publish request and its callback can share one logical key, while a duplicate
of the same kind is rejected.

## n8n Content Engine V1

The inactive export at [`n8n/SnapGad-Content-Engine-V1.json`](n8n/SnapGad-Content-Engine-V1.json)
contains one signed, copy-only worker path:

- `POST /webhook/snapgad/content/copy` — OpenRouter vision/copy generation and
  callback with two alternatives. The worker claims a durable job from the
  portal before reading the private asset and completes that job through the
  signed callback.

Use the runbooks in [`docs/n8n/`](docs/n8n/) before importing. The database
migrations are applied, but keep the workflow inactive until the portal
callback URL is reachable and one test job has been verified. The export
contains no credentials, has no direct Supabase access, and has not been
imported or activated in the connected n8n instance.

The server exposes a signed request bridge at `/api/integrations/n8n/copy` and
signed worker endpoints at `/api/integrations/n8n/copy/claim` and
`/api/integrations/n8n/copy/complete`. The portal enqueues the durable job
before any n8n delivery; n8n receives only the job identifier and signed
lease, then reads the stored brief and asset through the claim endpoint. The
Meta publish bridge remains preflight-only and is not part of this worker.
For the portal-owned path, the server-only `SupabaseCopyWorkerStore` uses the
same lifecycle through Postgres RPCs and signed `content-assets` URLs. An
internal `GET /api/internal/worker/health` endpoint exposes aggregate queue
telemetry only when `SNAPGAD_WORKER_HEALTH_TOKEN` is configured; it is not a
browser or tenant-facing route.

The persistent runner is started with `npm run worker`. It fails closed unless
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SNAPGAD_COPY_WORKER_MODULE` are present. The processor module must export a
default function (or `processCopyJob`) that receives one claimed job and
returns an object result. Polling, lease heartbeat, retry, and expired-lease
recovery are owned by `worker/durable-runner.ts`; provider code is injected and
therefore no Meta, OpenRouter, or n8n call is implicit.
In demo mode, the browser screens use their explicit local store; with
Supabase configuration, the new-creative, campaigns, drafts, review and
history screens use the authenticated API.

The production read/approval API is available at `GET /api/content`,
`GET /api/content/:id`, and
`POST /api/content/:id/targets/:targetId/approve`. These routes derive the
owner from the Supabase session, return the content record with targets, copy
drafts and audit events, and require the item to be in `REVIEW` before a target
can be approved. Applying migration `0005` is required before using the
approval route against Supabase, and migration `0006` is required for asset
uploads. The new-creative form sends multipart assets to `POST /api/content`
when public Supabase configuration is present; application environment
credentials and an authenticated user are still required for end-to-end
verification.

After a human publishes a previously approved destination directly in Meta,
`POST /api/content/:id/targets/:targetId/manual-delivery` records its HTTPS
URL, publication date and an optional internal note. It never invokes Meta or
uses a Meta token. It is organization-scoped, idempotent and remains a manual
evidence step. A content item becomes `PUBLISHED` only after every configured
destination has its own recorded delivery.

## Campaign control plane

Every newly uploaded creative now requires a campaign name, concrete offer,
funnel stage and HTTPS destination alongside its commercial brief. The server
stores a readable `campaign_code` and the portal only enables per-network
approval after `POST /api/content/:id/final-copy` has persisted a validated,
immutable final-copy version and moved the item to `REVIEW`.

`GET /api/content/:id/preflight` is a non-mutating check for asset format,
destination and final copy. It is safe to use while preparing a campaign. The
Meta configuration boundary is deliberately preflight-only: credentials in
`META_*` are server-only and do not make any Meta API call or publish a post.
Even a configured n8n publish URL is fail-closed unless the explicit,
reviewed `SNAPGAD_PUBLISH_WORKER_ENABLED=true` staging flag is present; the
default remains no network publication.
The actual Facebook/Instagram publishing connector remains staging work until
a single approved asset and target-specific Meta permissions are verified.

La fase y su checklist de transferencia están documentadas en
[`docs/superpowers/plans/2026-09-04-snapgad-content-os-production-adapter.md`](docs/superpowers/plans/2026-09-04-snapgad-content-os-production-adapter.md).
