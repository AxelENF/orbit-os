# SnapGad Content Engine Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the existing SnapGad Content OS MVP with a signed n8n copy/publish bridge and an importable, approval-gated n8n workflow that can be tested without publishing live content.

**Architecture:** The existing Next.js portal remains the source of truth for content state, approvals, and audit events. n8n is an executor: it receives signed copy or publish jobs, calls OpenRouter/Meta with server-side credentials, and returns signed callbacks. The first real test is one approved Facebook post; Instagram remains a separate target and request.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Vitest, Supabase/Postgres/Storage, n8n Webhook/HTTP Request/Code nodes, OpenRouter vision/chat API, Meta Graph API.

---

## Existing baseline

- `snapgad-content-os` already contains the portal, demo repository, state machine, Supabase migration, asset intake, draft review, independent FB/IG targets, and tests for tasks 1–5.
- `C:\Users\AxelENF\Downloads\MARKET BOT` contains six exported prototypes. Exports are not treated as live evidence; the verified live n8n evidence remains the WhatsApp MVP only.
- No credentials are written to source, no workflow is activated, and no Meta post is sent by this implementation.

## File map

```text
snapgad-content-os/
  lib/integrations/n8n-signature.ts       HMAC signing and verification
  lib/integrations/n8n-client.ts          typed signed requests to n8n
  app/api/integrations/n8n/copy-result/route.ts
  app/api/integrations/n8n/publish-result/route.ts
  docs/n8n/content-copy-workflow.md       n8n copy workflow contract
  docs/n8n/content-publish-workflow.md    n8n publish workflow contract
  tests/integrations/n8n-signature.test.ts
  tests/api/copy-result.test.ts
  tests/api/publish-result.test.ts
  n8n/SnapGad-Content-Engine-V1.json      importable dry-run workflow
```

### Task 1: Signed callback and idempotent copy ingestion

**Files:**
- Create: `lib/integrations/n8n-signature.ts`
- Create: `app/api/integrations/n8n/copy-result/route.ts`
- Modify: `lib/content/repository.ts`, `lib/demo/repository.ts`
- Test: `tests/integrations/n8n-signature.test.ts`, `tests/api/copy-result.test.ts`

- [x] Verify the canonical JSON HMAC (`timestamp + "." + stableJson(body)`) with `sha256` and timing-safe comparison; reject missing or invalid signatures with 401.
- [x] Validate `contentItemId`, `idempotencyKey`, `visualAnalysis`, exactly two draft alternatives, and `warnings` with Zod.
- [x] Persist one callback per `(COPY_CALLBACK, idempotencyKey)` and return `{ created: false }` for retries.
- [x] Record a sanitized audit event and transition `GENERATING → DRAFT` only after validation.
- [x] Run the focused copy tests and lint.

### Task 2: Approval-gated publish request and callback

**Files:**
- Create: `app/api/integrations/n8n/publish-result/route.ts`
- Modify: `lib/content/repository.ts`, `lib/demo/repository.ts`, `lib/integrations/n8n-client.ts`
- Test: `tests/api/publish-result.test.ts`

- [x] Reject any publish result/request unless its target is `APPROVED` with 409.
- [x] Keep Facebook and Instagram target states, IDs, URLs, and errors independent.
- [x] Sign outbound requests with HMAC and use a unique idempotency key per target request.
- [x] Accept only `remotePostId`, `remoteUrl`, `publishedAt`, and sanitized error fields in callbacks.
- [x] In demo mode record `DRY_RUN_QUEUED` without network calls.
- [x] Run the full test suite, lint, and build.

### Task 3: Importable n8n workflow and runbook

**Files:**
- Create: `n8n/SnapGad-Content-Engine-V1.json`
- Create: `docs/n8n/content-copy-workflow.md`
- Create: `docs/n8n/content-publish-workflow.md`
- Modify: `.env.example`, `README.md`

- [x] Add a Webhook trigger for copy jobs, a Code node for schema/idempotency checks, HTTP Request nodes for OpenRouter and portal callback, and an error path.
- [x] Add a separate Webhook trigger for publish jobs, an approval guard, platform branch, Meta Graph HTTP Request, and portal callback.
- [x] Use environment variables/credential references only; never embed tokens, URLs with secrets, or real IDs.
- [x] Keep the workflow inactive on import and mark all live endpoint values as configuration inputs in the runbook.
- [x] Document a staging test with one final Canva 4:5 asset and a Meta test destination; document how to inspect execution IDs and callback payloads.
- [x] Run JSON parse validation plus the full Next.js checks.

## End-to-end acceptance

1. Local demo can create a valid content item and show two targets.
2. Invalid brief, invalid HMAC, malformed callback, and unapproved target are rejected.
3. Replaying the same callback does not duplicate drafts, audit events, or publications.
4. Importing the JSON creates an inactive workflow with no secrets.
5. A staging copy request returns two drafts and updates the portal to `DRAFT`.
6. Approving only Facebook can queue only Facebook; Instagram remains pending.
7. A staging Meta test call returns a remote ID that is visible in portal history.
8. Production activation remains a separate, explicit decision after the staging test.
