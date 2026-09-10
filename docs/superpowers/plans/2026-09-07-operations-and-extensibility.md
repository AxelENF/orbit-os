# SnapGad Content OS Operations and Extensibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add simple scheduling, trustworthy commercial results, tenant-scoped
API access and a deliberately limited MCP after the foundation and campaign
experience are live.

**Architecture:** Scheduling and outcome ingestion operate on approved campaign
records. A versioned REST API is the stable integration contract; MCP wraps a
small subset of that contract and cannot bypass human approval or publish.

**Tech Stack:** Next.js API routes, Supabase, Zod, Vitest, n8n signed webhooks.

---

### Task 1: Add schedule as a controlled campaign state

**Files:** `supabase/migrations/0010_campaign_schedule.sql`,
`app/api/campaigns/[id]/schedule/route.ts`, `lib/content/schedule.ts`,
`components/campaigns/schedule-panel.tsx`, `tests/content/schedule.test.ts`,
`tests/api/campaign-schedule.test.ts`

- [ ] Test that only an approved target with an immutable final copy can be
  scheduled, timezone is retained, and a past time is rejected.
- [ ] Implement one `scheduled_for` per target, an audit event and atomic state
  transition. n8n gets a due-job only from the portal worker claim route.
- [ ] Build a compact calendar/list with local timezone displayed to the
  client. Scheduling never activates Meta publication by itself.
- [ ] Run full verification.

### Task 2: Normalize bot outcomes and results

**Files:** `supabase/migrations/0011_campaign_outcomes.sql`,
`app/api/integrations/bot/outcomes/route.ts`, `lib/content/outcomes.ts`,
`app/(app)/results/page.tsx`, `components/results/results-dashboard.tsx`,
`tests/content/outcomes.test.ts`, `tests/api/bot-outcomes.test.ts`

- [ ] Test idempotent ingestion keyed by external event id, valid kinds
  `CONVERSATION | QUALIFIED_LEAD | APPOINTMENT | QUOTE | SALE`, and rejection
  when campaign code belongs to another tenant.
- [ ] Implement signed ingestion with minimum metadata, campaign attribution by
  stored campaign code and aggregate counts. Do not calculate ROI or revenue
  without a verified source of truth.
- [ ] Build Results with dates, campaign filter and counts for conversations,
  qualified leads, appointments, quotes and sales.
- [ ] Run full verification.

### Task 3: Add API v1 and managed integrations

**Files:** `supabase/migrations/0012_api_keys_and_integrations.sql`,
`lib/api/keys.ts`, `app/api/v1/campaigns/route.ts`,
`app/api/v1/campaigns/[id]/route.ts`, `app/api/v1/outcomes/route.ts`,
`tests/api/v1-auth.test.ts`, `docs/api/v1.md`

- [ ] Test hashed API keys with tenant scope, expiry/revocation, required
  scopes and no cross-organization response leakage.
- [ ] Implement read/write scopes only for campaigns and bot outcomes. Keys
  are shown once at creation and stored hashed; no organization identifier in
  body determines tenant.
- [ ] Add organization integration settings that store a credential handle and
  connection state only. Implement Meta OAuth only after app review/redirect
  URLs are configured in staging.
- [ ] Run full verification and document curl examples without secrets.

### Task 4: Expose a safe MCP surface

**Files:** `lib/mcp/tools.ts`, `app/api/mcp/route.ts`, `tests/mcp/tools.test.ts`,
`docs/mcp.md`

- [ ] Test that MCP can list campaigns, inspect results, create a draft
  campaign and request human review, but cannot approve or publish a campaign.
- [ ] Implement MCP tools backed solely by API v1 scopes and organization
  context. Include tool descriptions that make human approval explicit.
- [ ] Run full verification and document connection/onboarding steps.

## Completion criteria

The client can see useful campaign outcomes and schedule approved work. API/MCP
access is organization-scoped, revocable and cannot trigger a publication or
spend without the same portal approval path.
