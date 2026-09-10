# SnapGad Content OS Campaign Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype-like multi-screen content flow with a polished,
mobile-capable campaign workspace a business client can operate unaided.

**Architecture:** One campaign detail workbench becomes canonical. List,
review and history are filtered views over the same campaign summary query.
Brand defaults prefill the wizard, while technical runtime details stay behind
development-only flags.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind CSS,
Vitest/Testing Library, existing repository API.

---

## File structure

- `app/(app)/campaigns/page.tsx` — campaign list with saved views.
- `app/(app)/campaigns/new/page.tsx` — three-step wizard.
- `app/(app)/campaigns/[id]/page.tsx` — single campaign workbench.
- `components/campaigns/campaign-list.tsx` — list/filter/next-action UI.
- `components/campaigns/campaign-wizard.tsx` — accessible wizard.
- `components/campaigns/campaign-workbench.tsx` — creative/copy/approval/activity.
- `components/layout/app-shell.tsx` — active desktop and mobile navigation.
- `components/layout/organization-switcher.tsx` — tenant identity, not
  infrastructure status.
- `app/globals.css` — SnapGad visual tokens and responsive layout.

### Task 1: Establish UI tokens and navigation

**Files:** `app/globals.css`, `app/layout.tsx`, `components/layout/app-shell.tsx`,
`components/layout/organization-switcher.tsx`, `tests/components/app-shell.test.tsx`

- [ ] Write tests that assert the current route has an accessible active
  navigation label and all primary destinations are reachable through the
  mobile menu.
- [ ] Run the test and confirm failure.
- [ ] Implement navy/cobalt surfaces, vivid `#FF4D00` action color, warm white
  reading surfaces, one body sans stack and consistent focus/hover/error
  tokens. Avoid decorative counts and technical provider labels.
- [ ] Add persistent client navigation: Inicio, Campañas, Calendario,
  Resultados, Marca y conexiones. Add an accessible mobile drawer with the
  same links and organization/user identity.
- [ ] Run focused tests, full tests, lint and build.

### Task 2: Make campaigns the only work object

**Files:** `app/(app)/campaigns/page.tsx`,
`components/campaigns/campaign-list.tsx`, `lib/content/client.ts`,
`tests/components/campaign-list.test.tsx`

- [ ] Write tests for status filters `requires_attention`, `scheduled` and
  `published`, and ensure a card shows one deterministic next action.
- [ ] Run the test and confirm failure.
- [ ] Add a campaign summary endpoint/client call backed by the tenant-scoped
  summary query. Render an empty state with “Crear campaña” and a compact
  filter bar instead of non-interactive feature cards.
- [ ] Map existing `/library`, `/drafts`, `/review` and `/history` URLs to
  redirects or filtered Campaigns views. Do not duplicate campaign fetching.
- [ ] Run full verification.

### Task 3: Build an actual three-step campaign wizard

**Files:** `app/(app)/campaigns/new/page.tsx`,
`components/campaigns/campaign-wizard.tsx`, `lib/content/campaign.ts`,
`tests/components/campaign-wizard.test.tsx`

- [ ] Write tests that block progression until step requirements are satisfied,
  preserve entered values when moving backward, and preload allowed facts/CTA
  defaults from Brand OS.
- [ ] Run failing test.
- [ ] Implement exactly three labelled steps: `Objetivo y oferta`, `Creativo
  final`, `Mensaje y destino`. Generate campaign code on server creation only;
  show a post-create confirmation instead of claiming copy was generated.
- [ ] Keep advanced Brand OS overrides collapsed. Validate asset and brief
  before the final submit; surface a plain-language correction for each error.
- [ ] Run all verification commands.

### Task 4: Build the canonical workbench

**Files:** `app/(app)/campaigns/[id]/page.tsx`,
`components/campaigns/campaign-workbench.tsx`,
`components/content/draft-editor.tsx`,
`components/content/publication-targets.tsx`,
`tests/components/campaign-workbench.test.tsx`

- [ ] Write tests proving review uses only the active immutable final copy,
  edit/save creates a new final-copy version, and Facebook approval does not
  approve Instagram.
- [ ] Run failing tests.
- [ ] Assemble creative preview, copy studio, per-platform approval,
  scheduling state, activity and outcomes into tabs/sections within one route.
  Do not render raw signed URLs, n8n/OpenRouter/Supabase labels, or a demo
  banner in production mode.
- [ ] After any copy change, show the campaign as requiring review; display the
  exact version approved beside each channel’s approval state.
- [ ] Run full verification and manual desktop/mobile smoke test.

## Completion criteria

Every client-facing action begins from Campaigns or a campaign workbench;
there is no empty navigation on mobile, no approval of a stale draft, and the
visual system feels like SnapGad rather than a generic developer dashboard.
