# SnapGad Content OS MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small internal Next.js portal that turns a final Canva asset into a human-approved FB/IG publication job with full traceability.

**Architecture:** Next.js owns UI, validation and business state; Supabase provides Auth, Postgres and private Storage; n8n receives signed jobs and returns signed callbacks. V1 runs in demo mode without real credentials, then enables Supabase and n8n independently.

**Tech Stack:** Next.js App Router, TypeScript, Tailwind, Vitest, Zod, Supabase SSR/client libraries, Supabase SQL migrations, react-dropzone, n8n HTTP/Graph API workflows.

---

## File map

```text
snapgad-content-os/
  app/
    (app)/layout.tsx
    (app)/library/page.tsx
    (app)/library/new/page.tsx
    (app)/drafts/page.tsx
    (app)/drafts/[id]/page.tsx
    (app)/review/page.tsx
    (app)/history/page.tsx
    api/integrations/n8n/copy-result/route.ts
    api/integrations/n8n/publish-result/route.ts
    page.tsx
  components/
    content/content-form.tsx
    content/asset-dropzone.tsx
    content/draft-editor.tsx
    content/publication-targets.tsx
    layout/app-shell.tsx
    ui/*
  lib/
    content/constants.ts
    content/contracts.ts
    content/state-machine.ts
    content/validation.ts
    content/repository.ts
    integrations/n8n-signature.ts
    integrations/n8n-client.ts
    supabase/client.ts
    supabase/server.ts
    demo/repository.ts
  supabase/migrations/0001_content_os.sql
  tests/
    content/state-machine.test.ts
    content/validation.test.ts
    integrations/n8n-signature.test.ts
    api/copy-result.test.ts
  docs/
    n8n/content-copy-workflow.md
    n8n/content-publish-workflow.md
  .env.example
  README.md
```

### Task 1: Scaffold the isolated Next.js project and quality baseline

**Files:**
- Create: `package.json`, `app/page.tsx`, `app/layout.tsx`, `tsconfig.json`, `vitest.config.ts`
- Create: `.gitignore`, `.env.example`, `README.md`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: Scaffold generated Next.js code**

Run from `snapgad-content-os`:

```powershell
npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir false --use-npm --import-alias "@/*" --yes
npm install zod react-dropzone @supabase/supabase-js @supabase/ssr
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Add a failing smoke test**

```ts
import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/lib/content/constants";

describe("application identity", () => {
  it("uses the SnapGad Content OS name", () => {
    expect(APP_NAME).toBe("SnapGad Content OS");
  });
});
```

- [ ] **Step 3: Run the test and confirm RED**

Run: `npm test -- --run tests/smoke.test.ts`  
Expected: fail because `@/lib/content/constants` does not exist.

- [ ] **Step 4: Implement only the identity constant and test configuration**

```ts
export const APP_NAME = "SnapGad Content OS";
```

Add a `test` script that runs `vitest` and configure the `@/` alias for Vitest.

- [ ] **Step 5: Run baseline checks**

Run: `npm test -- --run tests/smoke.test.ts`  
Expected: PASS, 1 test.

Run: `npm run lint`  
Expected: exit code 0.

- [ ] **Step 6: Commit**

```powershell
git add .
git commit -m "chore: scaffold SnapGad Content OS"
```

### Task 2: Define taxonomies, contracts, validation and content state machine

**Files:**
- Create: `lib/content/contracts.ts`, `lib/content/validation.ts`, `lib/content/state-machine.ts`
- Modify: `lib/content/constants.ts`
- Test: `tests/content/validation.test.ts`, `tests/content/state-machine.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
it("rejects a content item without allowed facts", () => {
  const result = contentBriefSchema.safeParse({
    businessLine: "AUTOMATIZAR",
    service: "bot_whatsapp",
    niche: "clinicas",
    contentType: "venta_directa",
    objective: "conversaciones_whatsapp",
    cta: "Solicita una demo",
    humanDescription: "Atiende, califica y agenda solicitudes.",
    allowedFacts: [],
    format: "feed_4_5",
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Write failing transition tests**

```ts
it("does not allow publication before approval", () => {
  expect(() => transitionContentState("DRAFT", "PUBLISHED")).toThrow(
    "Invalid content state transition",
  );
});
```

- [ ] **Step 3: Run the tests and confirm RED**

Run: `npm test -- --run tests/content`  
Expected: fail because validation/state modules do not exist.

- [ ] **Step 4: Implement contracts and only the allowed transitions**

Use Zod enums for controlled taxonomy. Require a non-empty CTA, human
description and `allowedFacts`. Model states as `UPLOADED`, `GENERATING`,
`DRAFT`, `REVIEW`, `APPROVED`, `SCHEDULED`, `PUBLISHED`, `REJECTED`, `ERROR`.
Allow no direct `DRAFT → PUBLISHED` transition.

- [ ] **Step 5: Run all Task 2 tests**

Run: `npm test -- --run tests/content`  
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add lib tests
git commit -m "feat: add content contracts and workflow rules"
```

### Task 3: Add Supabase schema, secure repository boundary and demo repository

**Files:**
- Create: `supabase/migrations/0001_content_os.sql`
- Create: `lib/supabase/client.ts`, `lib/supabase/server.ts`
- Create: `lib/content/repository.ts`, `lib/demo/repository.ts`
- Modify: `.env.example`, `README.md`
- Test: `tests/content/repository-contract.test.ts`

- [ ] **Step 1: Write failing repository contract tests**

```ts
it("creates a content item with independent Facebook and Instagram targets", async () => {
  const repository = createDemoRepository();
  const item = await repository.createContentItem(validBrief);
  const targets = await repository.listPublicationTargets(item.id);
  expect(targets.map((target) => target.platform)).toEqual(["FACEBOOK", "INSTAGRAM"]);
  expect(targets.every((target) => target.status === "PENDING_REVIEW")).toBe(true);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- --run tests/content/repository-contract.test.ts`  
Expected: fail because the repository does not exist.

- [ ] **Step 3: Add migration and repository interface**

Migration creates `profiles`, `assets`, `content_items`, `copy_drafts`,
`publication_targets`, `automation_runs`, `audit_events`; enables RLS and adds
owner-only policies. Storage bucket is private. Add unique constraints for
idempotency keys and `(content_item_id, platform)`.

The app imports a repository interface; the demo implementation lives in
memory and never invokes network calls. The Supabase implementation is added
behind the same interface and only selected when env is configured.

- [ ] **Step 4: Run the contract tests and lint**

Run: `npm test -- --run tests/content/repository-contract.test.ts`  
Expected: PASS.

Run: `npm run lint`  
Expected: exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add supabase lib .env.example README.md tests
git commit -m "feat: add content storage contract and demo mode"
```

### Task 4: Build the asset library and new-content intake flow

**Files:**
- Create: `components/layout/app-shell.tsx`, `components/content/asset-dropzone.tsx`, `components/content/content-form.tsx`
- Create: `app/(app)/layout.tsx`, `app/(app)/library/page.tsx`, `app/(app)/library/new/page.tsx`
- Test: `tests/components/content-form.test.tsx`

- [ ] **Step 1: Write a failing form test**

```tsx
it("keeps generate disabled until the commercial brief is factual and complete", async () => {
  render(<ContentForm onSubmit={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Generar borradores" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("CTA"), "Solicita una demo");
  expect(screen.getByRole("button", { name: "Generar borradores" })).toBeDisabled();
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- --run tests/components/content-form.test.tsx`  
Expected: fail because the form does not exist.

- [ ] **Step 3: Implement minimal intake UI**

Create a clean dark/cobalt internal UI. The form accepts a 4:5 image, controlled
taxonomy, human description, allowed facts and CTA. It must show that the image
is final from Canva and does not generate graphics. The first save uses demo
repository storage when Supabase is unavailable.

- [ ] **Step 4: Run component tests, lint and local build**

Run: `npm test -- --run tests/components/content-form.test.tsx`  
Expected: PASS.

Run: `npm run lint && npm run build`  
Expected: exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add app components tests
git commit -m "feat: add asset library intake flow"
```

### Task 5: Build drafts, review and independent publication target controls

**Files:**
- Create: `components/content/draft-editor.tsx`, `components/content/publication-targets.tsx`
- Create: `app/(app)/drafts/page.tsx`, `app/(app)/drafts/[id]/page.tsx`, `app/(app)/review/page.tsx`, `app/(app)/history/page.tsx`
- Test: `tests/components/publication-targets.test.tsx`

- [ ] **Step 1: Write a failing target-state test**

```tsx
it("approves Facebook without approving Instagram", async () => {
  render(<PublicationTargets targets={pendingTargets} onApprove={onApprove} />);
  await userEvent.click(screen.getByRole("button", { name: "Aprobar Facebook" }));
  expect(onApprove).toHaveBeenCalledWith("facebook-target-id");
  expect(screen.getByText("Instagram: pendiente de revisión")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- --run tests/components/publication-targets.test.tsx`  
Expected: fail because the component does not exist.

- [ ] **Step 3: Implement review flow**

Show visual analysis, two drafts, editable final text and warnings. Approval
must use the state machine and act per target. The history view renders audit
events and sanitized errors. Do not render a functional `Publicar ahora`
control until Task 7 connects a tested n8n endpoint.

- [ ] **Step 4: Run relevant tests and build**

Run: `npm test -- --run tests/components/publication-targets.test.tsx`  
Expected: PASS.

Run: `npm run lint && npm run build`  
Expected: exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add app components tests
git commit -m "feat: add draft review and target approvals"
```

### Task 6: Implement signed n8n callback verification and copy-result ingestion

**Files:**
- Create: `lib/integrations/n8n-signature.ts`, `lib/integrations/n8n-client.ts`
- Create: `app/api/integrations/n8n/copy-result/route.ts`
- Modify: `lib/content/repository.ts`, `lib/demo/repository.ts`
- Test: `tests/integrations/n8n-signature.test.ts`, `tests/api/copy-result.test.ts`

- [ ] **Step 1: Write a failing signature test**

```ts
it("rejects a callback whose HMAC does not match the raw payload", () => {
  expect(verifyN8nSignature('{"event":"copy"}', "bad", "test-secret")).toBe(false);
});
```

- [ ] **Step 2: Write a failing idempotency test**

```ts
it("stores a copy callback only once per idempotency key", async () => {
  const first = await ingestCopyResult(validCallback);
  const second = await ingestCopyResult(validCallback);
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
});
```

- [ ] **Step 3: Run tests and confirm RED**

Run: `npm test -- --run tests/integrations tests/api/copy-result.test.ts`  
Expected: fail because signature verification and endpoint are absent.

- [ ] **Step 4: Implement callback only**

Verify a SHA-256 HMAC against `SNAPGAD_N8N_SHARED_SECRET`; reject missing/invalid
signatures with 401. Validate body with Zod, persist draft alternatives and
audit event exactly once, then move content `GENERATING → DRAFT`.

- [ ] **Step 5: Run tests and build**

Run: `npm test -- --run tests/integrations tests/api/copy-result.test.ts`  
Expected: PASS.

Run: `npm run lint && npm run build`  
Expected: exit code 0.

- [ ] **Step 6: Commit**

```powershell
git add app lib tests
git commit -m "feat: ingest signed n8n copy callbacks"
```

### Task 7: Document and add dry-run request/publish bridge for n8n

**Files:**
- Create: `docs/n8n/content-copy-workflow.md`, `docs/n8n/content-publish-workflow.md`
- Create: `app/api/integrations/n8n/publish-result/route.ts`
- Modify: `lib/integrations/n8n-client.ts`, `.env.example`, `README.md`
- Test: `tests/api/publish-result.test.ts`

- [ ] **Step 1: Write a failing publish guard test**

```ts
it("rejects a publish result for a target that was not approved", async () => {
  const response = await postPublishResult(unapprovedTargetCallback);
  expect(response.status).toBe(409);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- --run tests/api/publish-result.test.ts`  
Expected: fail because the route does not exist.

- [ ] **Step 3: Implement dry-run bridge and docs**

The portal can queue a signed request to the configured n8n webhook only when
the target is approved. In demo mode it records `DRY_RUN_QUEUED` and returns
without network. The callback accepts `remotePostId`, remote URL or sanitized
error and updates only that target. The docs specify n8n nodes, payload,
credentials location, HMAC and a Meta test-page procedure; they do not include
credentials.

- [ ] **Step 4: Run all tests, lint and build**

Run: `npm test -- --run`  
Expected: PASS.

Run: `npm run lint && npm run build`  
Expected: exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add app lib docs .env.example README.md tests
git commit -m "feat: add controlled n8n publishing bridge"
```

## End-to-end verification

1. Run `npm test -- --run`, `npm run lint` and `npm run build`.
2. Start demo mode with `npm run dev` and create a content item.
3. Confirm it cannot reach approval without brief/CTA/facts.
4. Submit a signed local copy callback; verify two drafts appear exactly once.
5. Approve only Facebook; confirm Instagram remains pending.
6. Queue demo publication; confirm it creates an audit event but no network call.
7. In staging only, configure n8n and a Meta test destination; validate one
   Facebook post and one Instagram post separately before enabling production.
