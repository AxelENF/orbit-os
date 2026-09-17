# Orbit Agent MCP Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex and Claude operate Orbit's marketing workflow through a small, tenant-safe local MCP server without exposing Meta, Supabase, or provider secrets to the model.

**Architecture:** Extend API v1 until it covers agent workflows, then create a local stdio MCP wrapper that authenticates with one organization-scoped Orbit API key from its process environment. MCP exposes high-value workflow tools and brand/campaign resources, not raw database access. Remote Streamable HTTP is deliberately deferred until the local agent path and staging security smoke pass.

**Tech Stack:** TypeScript, Next.js API v1, Zod, `@modelcontextprotocol/sdk`, stdio MCP transport, Vitest, MCP Inspector.

---

### Task 1: Add least-privilege agent API scopes

**Files:**
- Create: `supabase/migrations/0032_organization_api_key_scopes.sql`
- Create: `lib/api/scopes.ts`
- Modify: `lib/api/keys.ts`
- Modify: `lib/api/v1-context.ts`
- Test: `tests/api/api-key-scopes.test.ts`

- [ ] Write failing tests for scope denial: a key with `campaigns:read` cannot create, submit copy, modify a profile, or queue publication; a key with `campaigns:write` cannot publish; a publish key cannot change organization profile.
- [ ] Implement the fixed scope union: `campaigns:read`, `campaigns:write`, `campaigns:publish`, `brand:read`, `brand:write`, and `results:read`. Validate it with Zod in `lib/api/scopes.ts`; never accept arbitrary scope strings.
- [ ] Add a `scopes text[] not null` column to `organization_api_keys` with an empty-array default, include scopes in create/list/verify RPC outputs, and preserve the one-time display of the raw key only at creation.
- [ ] Make `resolveV1RequestContext` derive organization plus verified scopes from the hashed API key and export `requireV1Scope(context, scope)`. Do not derive tenant from tool input.
- [ ] Run `npm test -- tests/api/api-key-scopes.test.ts` and commit with `feat: scope Orbit API keys for agents`.

### Task 2: Complete the API v1 agent workflow contract

**Files:**
- Create: `app/api/v1/brand-context/route.ts`
- Create: `app/api/v1/campaigns/[id]/final-copy/route.ts`
- Create: `app/api/v1/campaigns/[id]/readiness/route.ts`
- Create: `app/api/v1/results/route.ts`
- Modify: `lib/content/repository.ts`
- Modify: `lib/supabase/repository.ts`
- Test: `tests/api/v1-agent-workflow.test.ts`

- [ ] Add `GET /api/v1/brand-context`, protected by `brand:read`, returning the active API-key organization profile, allowed facts, forbidden claims, default CTA, configured platforms, and no connection token or secret identifiers.
- [ ] Add `POST /api/v1/campaigns/:id/final-copy`, protected by `campaigns:write`, accepting headline/body/CTA/hashtags. Reuse the existing final-copy validation and persistence path, then run the existing deterministic diagnosis; it must return `AUTOMATIC_READY` or `REVIEW_REQUIRED` plus sanitized findings.
- [ ] Add `GET /api/v1/campaigns/:id/readiness`, protected by `campaigns:read`, returning asset count, copy state, target state, diagnosis quality, safe next action, and no sensitive configuration.
- [ ] Add `GET /api/v1/results`, protected by `results:read`, with cursor pagination and optional campaign ID. Return recorded observations only; never calculate or promise ROI.
- [ ] Keep `POST /api/v1/campaigns/:id/publish` behind `campaigns:publish` and reject it unless readiness is `AUTOMATIC_READY` or the existing explicit human review path has approved the target. It must never create spend, ads, audiences, or boosted posts.
- [ ] Run focused endpoint tests, then the complete quality suite. Commit with `feat: complete agent-safe Orbit API v1`.

### Task 3: Build the local stdio MCP server

**Files:**
- Create: `mcp/orbit-agent-server.ts`
- Create: `mcp/orbit-api-client.ts`
- Create: `mcp/orbit-schemas.ts`
- Create: `mcp/orbit-resources.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Test: `tests/mcp/orbit-agent-server.test.ts`

- [ ] Add `@modelcontextprotocol/sdk` and an `npm run mcp:orbit` script that starts only a stdio server. The process must require `ORBIT_API_BASE_URL`, `ORBIT_API_KEY`, and `ORBIT_MCP_ASSET_ROOTS`; it must fail with a generic configuration message rather than echoing values.
- [ ] Implement a single API client that sends the API key in an Authorization header, validates every response with Zod, applies a 30-second timeout, and converts 401/403/409/422/503 responses into actionable MCP errors without server payload leakage.
- [ ] Implement read-only tools: `orbit_get_brand_context`, `orbit_list_campaigns`, `orbit_get_campaign`, `orbit_get_campaign_readiness`, and `orbit_list_results`. Mark them read-only and return concise structured output with IDs agents can reuse.
- [ ] Implement action tools: `orbit_create_campaign_from_file`, `orbit_submit_final_copy`, and `orbit_publish_campaign`. `orbit_create_campaign_from_file` must resolve a real local path, reject symbolic-link escapes, enforce that it belongs to `ORBIT_MCP_ASSET_ROOTS`, and stream it as the existing multipart API v1 request. It must not fetch arbitrary URLs or accept base64 payloads.
- [ ] Implement resources `orbit://brand-context` and `orbit://campaigns/{campaignId}` plus a `compose_brand_safe_post` prompt that injects only the selected organization profile and an explicit “do not invent claims” rule.
- [ ] Make `orbit_publish_campaign` return the persisted readiness decision and target IDs. If review is required, return the exact sanitized findings and do not retry/override automatically.
- [ ] Write unit tests with a fake API client for scope failures, asset-root escapes, publication blocks, pagination, and token redaction. Run `npx @modelcontextprotocol/inspector` against a test API fixture and commit with `feat: add local Orbit agent MCP`.

### Task 4: Make Codex/Claude operation reproducible

**Files:**
- Create: `docs/mcp/orbit-agent.md`
- Create: `examples/orbit-mcp.config.json`
- Modify: `docs/vault/00-index.md`
- Test: `tests/mcp/orbit-agent-server.test.ts`

- [ ] Document a local configuration that keeps `ORBIT_API_KEY` in the host process environment, not an LLM prompt, chat attachment, repository, or MCP tool argument.
- [ ] Document the four-step agent playbook: read brand context; create/upload the already approved creative; submit factual copy; inspect readiness and publish only when Orbit returns an eligible target.
- [ ] Include exact failure handling for `REVIEW_REQUIRED`, expired Meta connection, no active worker, missing asset, and API-key scope denial. Each case must tell the operator whether to edit copy, reconnect Meta, start the worker, upload a valid asset, or create a correctly scoped key.
- [ ] Add a regression test proving `orbit_get_brand_context` and campaign resources never include `pageAccessToken`, `userLongLivedToken`, `SUPABASE_SERVICE_ROLE_KEY`, or any environment value.
- [ ] Commit with `docs: document Orbit agent MCP operation`.

### Task 5: Defer remote MCP until local proof exists

**Files:**
- Create: `docs/mcp/remote-mcp-release-gate.md`

- [ ] Record that a hosted Streamable HTTP MCP endpoint is not part of the personal pilot. It needs OAuth 2.1/resource metadata, per-request tenant identity, rate limits, audit logs, idempotency, and a deployment secret manager before public exposure.
- [ ] Require completion of the database staging plan and a successful local stdio MCP Inspector run before designing remote transport.
- [ ] Commit with `docs: define remote MCP release gate`.
