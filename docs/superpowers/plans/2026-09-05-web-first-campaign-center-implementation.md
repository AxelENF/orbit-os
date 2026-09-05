# Web-first Campaign Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn SnapGad Content OS into a web-first campaign center with validated campaign context, immutable final copy, n8n classification/copy contracts, a safe Meta preflight, and attributable commercial outcomes.

**Architecture:** `content_items` remains the campaign root. New server-only domain validators protect asset intake, final-copy selection, and publication inputs. Supabase persists the production shape and exposes private Realtime updates; the demo store mirrors the user-facing flow in local mode. n8n only returns signed structured analysis/copy; a server-side Meta adapter is configuration-gated and starts in preflight/dry-run mode.

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod 4, Supabase Auth/Storage/Postgres/Realtime, Vitest, `file-type`, `facebook-nodejs-business-sdk`.

---

## File structure

- `lib/content/campaign.ts` — campaign enums, labels, `campaignBriefSchema`, code generation and filter helpers.
- `lib/content/final-copy.ts` — final-copy schema, deterministic CTA/claim preflight and immutable checksum input.
- `lib/content/preflight.ts` — merges asset, brief and final-copy checks into one typed result.
- `lib/content/repository.ts` — public repository types for campaigns, final-copy revisions, classification and outcomes.
- `lib/content/campaign-client.ts` — browser calls for final copy, review submission, filters and outcome reads.
- `lib/integrations/meta-publisher.ts` — server-only `Publisher` interface plus a configuration-gated Meta implementation.
- `lib/supabase/realtime.ts` — owner-scoped subscription helpers that invalidate/refetch campaign records.
- `components/content/campaign-form.tsx` — campaign-first intake UI and preflight status.
- `components/content/campaign-library.tsx` — filterable library cards and next action.
- `components/content/copy-studio.tsx` — alternatives, final copy editor, preview and review action.
- `app/api/content/[id]/final-copy/route.ts` — save final-copy revision.
- `app/api/content/[id]/submit-review/route.ts` — validate the version and transition DRAFT to REVIEW.
- `app/api/content/[id]/preflight/route.ts` — return server preflight without publishing.
- `app/api/content/[id]/outcomes/route.ts` — owner-scoped outcome list for the portal.
- `app/api/integrations/n8n/outcome/route.ts` — signed bot/n8n outcome ingestion.
- `supabase/migrations/0007_campaign_center.sql` — campaign columns, final-copy revisions, outcomes, RPCs, RLS and Realtime publication.
- `tests/content/campaign.test.ts`, `tests/content/final-copy.test.ts`, `tests/content/preflight.test.ts` — pure domain behavior.
- `tests/api/final-copy.test.ts`, `tests/api/submit-review.test.ts`, `tests/api/campaign-preflight.test.ts`, `tests/api/outcomes.test.ts` — authenticated repository-bound route behavior.

## Task 1: Define the campaign and final-copy domain contract

**Files:**
- Create: `lib/content/campaign.ts`
- Create: `lib/content/final-copy.ts`
- Create: `lib/content/preflight.ts`
- Modify: `lib/content/contracts.ts`
- Modify: `lib/content/repository.ts`
- Test: `tests/content/campaign.test.ts`
- Test: `tests/content/final-copy.test.ts`
- Test: `tests/content/preflight.test.ts`

- [ ] **Step 1: Write failing campaign-domain tests**

```ts
it("creates a readable unique campaign code", () => {
  expect(createCampaignCode(() => "7f8e9d10")).toBe("SG-7F8E9D10");
});

it("rejects a campaign with an unknown funnel stage", () => {
  expect(() => parseCampaignBrief({ ...validBrief, funnelStage: "SCALE" })).toThrow();
});
```

- [ ] **Step 2: Run the tests and confirm they fail because campaign helpers do not exist**

Run: `npm test -- --run tests/content/campaign.test.ts`

Expected: FAIL with an unresolved import or undefined helper.

- [ ] **Step 3: Implement the smallest campaign contract**

```ts
export const FUNNEL_STAGES = ["DISCOVER", "CONSIDER", "DECIDE"] as const;
export const CTA_ACTIONS = ["WHATSAPP", "BOOK_DEMO", "VISIT_WEB", "LEARN_MORE"] as const;
export const campaignBriefSchema = contentBriefSchema.extend({
  campaignName: z.string().trim().min(3).max(120),
  campaignCode: z.string().regex(/^SG-[A-Z0-9]{8}$/),
  funnelStage: z.enum(FUNNEL_STAGES),
  primaryPain: z.string().trim().min(8).max(280),
  proofMechanism: z.enum(["DEMO", "WORKFLOW", "PRODUCT_VIEW", "NONE"]),
  ctaAction: z.enum(CTA_ACTIONS),
});
```

`createCampaignCode` must use `crypto.randomUUID()` by default, remove hyphens,
take the first eight characters and uppercase them. Extend the content repository
types with `CampaignBrief`, `FinalCopyRevision`, `CampaignClassification` and
`CampaignOutcome`; do not add an independent campaign root.

- [ ] **Step 4: Run campaign tests and confirm they pass**

Run: `npm test -- --run tests/content/campaign.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing final-copy and preflight tests**

```ts
it("requires a WhatsApp action phrase for a WhatsApp CTA", () => {
  expect(validateFinalCopy({ ...validFinalCopy, ctaAction: "WHATSAPP", cta: "Agenda ahora" }, validFacts).ok).toBe(false);
});

it("rejects an unapproved price claim", () => {
  expect(validateFinalCopy({ ...validFinalCopy, body: "Desde $4,999 MXN" }, ["Agenda citas"]).ok).toBe(false);
});
```

- [ ] **Step 6: Run the tests and confirm they fail**

Run: `npm test -- --run tests/content/final-copy.test.ts tests/content/preflight.test.ts`

Expected: FAIL because `validateFinalCopy` and `createPreflight` do not exist.

- [ ] **Step 7: Implement deterministic final-copy and aggregate preflight**

```ts
const CTA_PHRASES = {
  WHATSAPP: ["whatsapp", "escribe"],
  BOOK_DEMO: ["agenda", "demo"],
  VISIT_WEB: ["visita"],
  LEARN_MORE: ["conoce", "ver"],
} as const;

export function validateFinalCopy(copy: FinalCopyInput, allowedFacts: string[]): PreflightResult {
  // require non-empty headline/body/cta and a matching CTA phrase;
  // reject price, percentage, deadline, guarantee and superlative patterns
  // unless that exact claim is present in a normalized allowed fact.
}
```

`createPreflight` must return named checks for `asset`, `brief`, `finalCopy` and
`destination`; it never changes state or calls a publisher.

- [ ] **Step 8: Run domain tests and the existing content tests**

Run: `npm test -- --run tests/content/campaign.test.ts tests/content/final-copy.test.ts tests/content/preflight.test.ts tests/content/state-machine.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the domain contract**

```bash
git add lib/content/campaign.ts lib/content/final-copy.ts lib/content/preflight.ts lib/content/contracts.ts lib/content/repository.ts tests/content/campaign.test.ts tests/content/final-copy.test.ts tests/content/preflight.test.ts
git commit -m "feat: add campaign and final copy contracts"
```

## Task 2: Persist final-copy revisions and campaign outcomes

**Files:**
- Create: `supabase/migrations/0007_campaign_center.sql`
- Modify: `lib/demo/draft-store.ts`
- Modify: `lib/demo/repository.ts`
- Modify: `lib/supabase/repository.ts`
- Modify: `lib/content/repository.ts`
- Test: `tests/content/repository-contract.test.ts`
- Test: `tests/content/supabase-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

```ts
it("stores an immutable final-copy revision before review", async () => {
  const revision = await repository.saveFinalCopy(item.id, { ...validFinalCopy, confirmation: true });
  expect(revision.revision).toBe(1);
  await expect(repository.submitForReview(item.id, revision.id)).resolves.toMatchObject({ state: "REVIEW" });
});

it("rejects review after the saved final copy was superseded", async () => {
  const first = await repository.saveFinalCopy(item.id, validFinalCopy);
  await repository.saveFinalCopy(item.id, changedFinalCopy);
  await expect(repository.submitForReview(item.id, first.id)).rejects.toThrow();
});
```

- [ ] **Step 2: Run repository tests and confirm they fail**

Run: `npm test -- --run tests/content/repository-contract.test.ts tests/content/supabase-repository.test.ts`

Expected: FAIL because final-copy methods are absent.

- [ ] **Step 3: Add migration 0007**

Create `final_copy_revisions` with owner, content item, optional source draft,
headline/body/cta, `cta_action`, confirmation, checksum, revision and created
time. Add `active_final_copy_id` plus campaign columns to `content_items`.
Create `campaign_outcomes` with owner, content item, event kind, source,
metadata and occurred time. Reuse owner triggers and RLS patterns from `0001`.

Create service-role-only RPCs:

```sql
save_final_copy_revision(p_owner_id uuid, p_content_item_id uuid, p_source_draft_id uuid, p_headline text, p_body text, p_cta text, p_cta_action text, p_confirmation boolean, p_checksum text)
submit_content_for_review(p_owner_id uuid, p_content_item_id uuid, p_final_copy_id uuid)
```

The second RPC must lock the item, verify the revision is active, move only
`DRAFT` to `REVIEW`, clear any prior target approval and append an audit event.

- [ ] **Step 4: Implement repository methods in demo and Supabase adapters**

```ts
saveFinalCopy(contentItemId, input): Promise<FinalCopyRevision>
submitForReview(contentItemId, finalCopyId): Promise<ContentItem>
listCampaignOutcomes(contentItemId): Promise<CampaignOutcome[]>
recordCampaignOutcome(input): Promise<CampaignOutcome>
```

The demo adapter stores revisions in memory/local draft records and follows the
same state rules. The Supabase adapter scopes every read/write to the resolved
owner and never trusts an owner id from the browser.

- [ ] **Step 5: Run repository tests and migration-shape checks**

Run: `npm test -- --run tests/content/repository-contract.test.ts tests/content/supabase-repository.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence**

```bash
git add supabase/migrations/0007_campaign_center.sql lib/content/repository.ts lib/demo/draft-store.ts lib/demo/repository.ts lib/supabase/repository.ts tests/content/repository-contract.test.ts tests/content/supabase-repository.test.ts
git commit -m "feat: persist campaign final copy and outcomes"
```

## Task 3: Add safe campaign API routes

**Files:**
- Create: `app/api/content/[id]/final-copy/route.ts`
- Create: `app/api/content/[id]/submit-review/route.ts`
- Create: `app/api/content/[id]/preflight/route.ts`
- Create: `app/api/content/[id]/outcomes/route.ts`
- Modify: `app/api/content/route.ts`
- Modify: `lib/content/client.ts`
- Test: `tests/api/final-copy.test.ts`
- Test: `tests/api/submit-review.test.ts`
- Test: `tests/api/campaign-preflight.test.ts`
- Test: `tests/api/outcomes.test.ts`
- Test: `tests/api/n8n-outcome.test.ts`

- [ ] **Step 1: Write failing route tests through injected repository factories**

```ts
it("saves a validated final copy for the authenticated owner", async () => {
  const response = await POST(requestWith(validFinalCopy));
  expect(response.status).toBe(201);
});

it("does not submit review without a current validated final-copy revision", async () => {
  const response = await POST(requestForMissingRevision);
  expect(response.status).toBe(409);
});
```

- [ ] **Step 2: Run route tests and confirm they fail**

Run: `npm test -- --run tests/api/final-copy.test.ts tests/api/submit-review.test.ts tests/api/campaign-preflight.test.ts tests/api/outcomes.test.ts tests/api/n8n-outcome.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement routes with one repository factory boundary**

`POST final-copy` parses JSON with Zod, resolves the authenticated owner from
the factory, reads the campaign, runs `validateFinalCopy` against its facts and
saves a revision. `POST submit-review` accepts only a revision id, not free
copy text. `GET preflight` returns checks for the active final copy. The portal
can only `GET outcomes`. `POST /api/integrations/n8n/outcome` accepts the same
HMAC headers used by the copy callback and a strict body containing
`campaignCode`, `kind`, `source`, `occurredAt` and metadata; it resolves the
campaign by code before persisting the outcome.

The route client exports typed functions and sends credentials only to the same
origin. Return `401`, `404`, `409`, `422` or `503` with user-facing messages;
never return Supabase or Meta details.

- [ ] **Step 4: Run route tests**

Run: `npm test -- --run tests/api/final-copy.test.ts tests/api/submit-review.test.ts tests/api/campaign-preflight.test.ts tests/api/outcomes.test.ts tests/api/n8n-outcome.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit APIs**

```bash
git add app/api/content app/api/integrations/n8n/outcome lib/content/client.ts tests/api/final-copy.test.ts tests/api/submit-review.test.ts tests/api/campaign-preflight.test.ts tests/api/outcomes.test.ts tests/api/n8n-outcome.test.ts
git commit -m "feat: add campaign review APIs"
```

## Task 4: Build the campaign-first web experience

**Files:**
- Create: `components/content/campaign-form.tsx`
- Create: `components/content/campaign-library.tsx`
- Create: `components/content/copy-studio.tsx`
- Modify: `components/content/content-form.tsx`
- Modify: `components/content/draft-editor.tsx`
- Modify: `components/content/publication-targets.tsx`
- Modify: `app/(app)/library/page.tsx`
- Modify: `app/(app)/library/new/page.tsx`
- Modify: `app/(app)/drafts/page.tsx`
- Modify: `app/(app)/review/page.tsx`
- Modify: `components/layout/app-shell.tsx`
- Test: `tests/components/campaign-form.test.tsx`
- Test: `tests/components/copy-studio.test.tsx`

- [ ] **Step 1: Write failing component tests**

```tsx
// @vitest-environment jsdom

it("blocks campaign creation until the three campaign sections are complete", async () => {
  render(<CampaignForm />);
  expect(screen.getByRole("button", { name: "Guardar campaña" })).toBeDisabled();
});

it("sends only the saved final-copy id when submitting review", async () => {
  render(<CopyStudio record={reviewableRecord} />);
  await user.click(screen.getByRole("button", { name: "Enviar a revisión" }));
  expect(submitForReview).toHaveBeenCalledWith(reviewableRecord.content.id, "final-copy-1");
});
```

- [ ] **Step 2: Run component tests and confirm they fail**

Run: `npm test -- --run tests/components/campaign-form.test.tsx tests/components/copy-studio.test.tsx`

Expected: FAIL because campaign components do not exist.

- [ ] **Step 3: Implement campaign form and library**

`CampaignForm` groups the existing fields into Oferta y audiencia, Creativo
final, and Límites editoriales. It generates a campaign code client-side only
for preview; the server owns the persisted code. `CampaignLibrary` applies
client-side filters in demo mode and query parameters in production mode. It
shows a next action based on state, one proof mechanism and no technical
metadata wall.

- [ ] **Step 4: Implement Copy Studio and correct approval behavior**

`CopyStudio` shows alternatives, selected source, editable final headline/body/
CTA, character counts and compact Facebook/Instagram previews. Saving creates a
new revision. Sending review calls the new route. `PublicationTargets` waits
for `onApprove` to resolve before changing local state and restores controls on
failure. It disables approval until record state is `REVIEW` and an active final
copy exists.

- [ ] **Step 5: Run component tests**

Run: `npm test -- --run tests/components/campaign-form.test.tsx tests/components/copy-studio.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run browser-local smoke checks**

Run: `npm run dev -- --hostname 127.0.0.1`

Verify manually: create a demo campaign, filter it, edit/save final copy,
submit it to review, approve Facebook and confirm Instagram remains pending.

- [ ] **Step 7: Commit web experience**

```bash
git add components/content app/(app) components/layout/app-shell.tsx tests/components
git commit -m "feat: build campaign-first content workspace"
```

## Task 5: Make n8n results live and add a Meta configuration preflight

**Files:**
- Create: `lib/supabase/realtime.ts`
- Create: `lib/integrations/meta-publisher.ts`
- Modify: `app/api/integrations/n8n/copy-result/route.ts`
- Modify: `lib/integrations/n8n-client.ts`
- Modify: `components/content/copy-studio.tsx`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `n8n/SnapGad-Content-Engine-V1.json`
- Test: `tests/content/meta-publisher.test.ts`
- Test: `tests/integrations/n8n-client.test.ts`

- [ ] **Step 1: Write failing n8n and Meta preflight tests**

```ts
it("rejects an n8n result whose classification conflicts with the campaign schema", async () => {
  await expect(ingestCopyResult(invalidClassificationPayload)).rejects.toThrow();
});

it("reports Meta as not configured without constructing a network client", async () => {
  await expect(createMetaPublisher({}).preflight()).resolves.toEqual({ status: "NOT_CONFIGURED" });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `npm test -- --run tests/content/meta-publisher.test.ts tests/integrations/n8n-client.test.ts`

Expected: FAIL because the classification and publisher interfaces do not exist.

- [ ] **Step 3: Add only the needed packages**

```bash
npm install file-type@22 facebook-nodejs-business-sdk
```

Check Node remains `>=22`. Do not add a CMS, dashboard, Docker file, scheduler
or second AI SDK.

- [ ] **Step 4: Implement n8n structured callback and Realtime invalidation**

Extend the signed n8n callback schema with optional `classification` that is
fully validated when supplied. Persist it as audit metadata unless the owner
accepts it. Subscribe to private campaign changes in the browser only after
Supabase public config exists; debounce invalidations and unsubscribe on unmount.
Demo mode remains network-free.

- [ ] **Step 5: Implement Meta preflight only**

`MetaBusinessPublisher.preflight()` checks the server environment variables,
then returns `NOT_CONFIGURED`, `READY` or a sanitized configuration error. It
does not call create-post endpoints in this task. `.env.example` lists only
variable names for app id, app secret, page id and page token.

- [ ] **Step 6: Run targeted tests**

Run: `npm test -- --run tests/content/meta-publisher.test.ts tests/integrations/n8n-client.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit integration foundations**

```bash
git add lib/supabase/realtime.ts lib/integrations/meta-publisher.ts app/api/integrations/n8n/copy-result/route.ts lib/integrations/n8n-client.ts components/content/copy-studio.tsx .env.example package.json package-lock.json n8n/SnapGad-Content-Engine-V1.json tests/content/meta-publisher.test.ts tests/integrations/n8n-client.test.ts
git commit -m "feat: add realtime copy updates and Meta preflight"
```

## Task 6: Verify and document the handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/n8n/content-copy-workflow.md`
- Modify: `docs/n8n/content-publish-workflow.md`
- Test: all existing suites

- [ ] **Step 1: Document exact runtime boundaries**

State that local mode is demo-only, Supabase requires migrations `0001` through
`0007`, n8n copy callbacks require HMAC, and Meta preflight never publishes.
Document the required bot handoff contract for `campaign_code` without placing a
token or webhook secret in a checked-in file.

- [ ] **Step 2: Run the full verification suite**

Run: `npm test -- --run`

Expected: all tests PASS.

Run: `npm run lint`

Expected: exit code 0.

Run: `npm run build`

Expected: exit code 0.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Review the requirements against the spec**

Confirm that the final UI has campaign context, non-Docker web architecture,
Supabase persistence/realtime, n8n structured copy, final-copy approval,
independent Facebook approval, Meta preflight and campaign outcome contract.
Report any live dependency that cannot be confirmed without credentials as
staging work, not as complete.

- [ ] **Step 4: Commit docs and verification-ready state**

```bash
git add README.md docs/n8n
git commit -m "docs: explain web-first campaign operations"
```
