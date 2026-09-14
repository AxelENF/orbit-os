# Unificación de navegación y vista de campaña — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `/library`, `/drafts`, and `/review` into one campaign list at `/library`, with a single, correctly-scoped "por revisar" (attention) predicate, inline approve/retry, and `/drafts` + `/review` becoming redirects — per `docs/superpowers/specs/2026-09-14-navigation-unification-design.md` (revision 4).

**Architecture:** `ContentSummary` gains a server-computed `hasActionableTarget: boolean` field so `/library`'s default view stays on the cheap `listContentSummaries()` fetch; only the `attention` filter triggers a second, scoped `getContentRecord()` fetch via a new `useAttentionTargets` hook. `/drafts` and `/review` become server-side `redirect()`s. Demo mode (`!isProductionMode`) reads `readDemoDrafts()` directly — no second fetch needed there, since it already carries `targets`.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Supabase, Vitest + Testing Library.

---

## Antes de empezar

- Rama: `feat/ia-navigation-unification` (ya activa, basada en `feat/meta-publisher-oauth-adapter`, hereda migraciones `0018`-`0024`). La próxima migración de esta rama es `0025`.
- Ignora cualquier cambio en `.codebase-memory/` que aparezca en `git status` — es un indexador de fondo ajeno a este trabajo, nunca lo agregues a un commit.
- Cada tarea termina en un commit propio (`git add <archivos exactos>`, nunca `git add -A`).
- Regla de seguridad: nunca `git reset --hard`, `git checkout --`, `git clean`, ni nada que descarte trabajo ya commiteado. Si algo falla de forma inesperada, para y reporta.
- Comandos de verificación usados en todo el plan: `npm test -- <archivo>` (Vitest), `npx tsc --noEmit`, `npm run lint`, `npm run build`.

---

### Task 1: Migración — índice `(organization_id, status)` en `publication_targets`

**Files:**
- Create: `supabase/migrations/0025_publication_targets_status_index.sql`

El único índice existente sobre esta tabla es
`publication_targets_organization_content_item_id_idx` en
`(organization_id, content_item_id, platform)`
(`supabase/migrations/0009_tenantize_content_and_jobs.sql:48`) — no cubre
`status`. La consulta nueva de la Task 3 filtra por
`(organization_id, status)`, un prefijo distinto.

- [ ] **Step 1: Crear la migración**

```sql
-- 0025_publication_targets_status_index.sql
create index if not exists publication_targets_organization_status_idx
  on public.publication_targets (organization_id, status);
```

- [ ] **Step 2: Verificar que no rompe nada existente**

No hay test dedicado para una migración que solo agrega un índice — no es
observable por Vitest (es una preocupación de rendimiento, no de
comportamiento) y escribir un test vacío solo para tener un archivo sería
YAGNI. Verificación: confirma que el archivo sigue el mismo estilo que
`supabase/migrations/0009_tenantize_content_and_jobs.sql:48` (mismo
`create index if not exists`, mismo `public.` prefijo).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0025_publication_targets_status_index.sql
git commit -m "feat: add organization+status index on publication_targets"
```

---

### Task 2: `ContentSummary` gana `hasActionableTarget` (campo requerido) + arreglar fixtures existentes

**Files:**
- Modify: `lib/content/repository.ts:46-50`
- Modify: `tests/content/campaign-view.test.ts:6-14`
- Modify: `tests/api/content-read-approval.test.ts:51-59`

Este paso solo agrega el campo al tipo y arregla los dos sitios que
construyen un `ContentSummary` literal con datos de prueba (detectados
por spec — uno por nombre de tipo, otro por duck-typing). La lógica real
de *cómo se calcula* el valor es la Task 3 (Supabase) y la Task 4 (demo
repository) — aquí el objetivo es que el repositorio vuelva a compilar
con valores placeholder honestos, no todavía correctos en todos los
casos.

- [ ] **Step 1: Agregar el campo al tipo**

En `lib/content/repository.ts`, la definición actual es:

```typescript
/** Lightweight list projection; detail screens request full records separately. */
export type ContentSummary = Pick<
  ContentItem,
  "id" | "state" | "createdAt" | "assetId" | "campaign"
> &
  Pick<ContentBrief, "service" | "niche" | "contentType" | "objective">;
```

Cámbiala a:

```typescript
/** Lightweight list projection; detail screens request full records separately. */
export type ContentSummary = Pick<
  ContentItem,
  "id" | "state" | "createdAt" | "assetId" | "campaign"
> &
  Pick<ContentBrief, "service" | "niche" | "contentType" | "objective"> & {
    /**
     * True when at least one publication_target needs a human decision:
     * a PENDING_REVIEW target while content.state === "REVIEW", or any
     * ERROR target regardless of content.state. See
     * docs/superpowers/specs/2026-09-14-navigation-unification-design.md
     * for why this is two independent conditions, not one flat check.
     */
    hasActionableTarget: boolean;
  };
```

- [ ] **Step 2: Confirmar que rompe la compilación (esperado)**

Run: `npx tsc --noEmit`
Expected: FAIL — errores en `lib/supabase/repository.ts`,
`lib/demo/repository.ts`, `tests/content/campaign-view.test.ts`, y
`tests/api/content-read-approval.test.ts` por falta de la propiedad
`hasActionableTarget`.

- [ ] **Step 3: Arreglar el fixture de `campaign-view.test.ts`**

El helper actual (`tests/content/campaign-view.test.ts:6-14`):

```typescript
const item = (state: ContentSummary["state"]): ContentSummary => ({
  id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
  state,
  createdAt: "2026-09-08T00:00:00.000Z",
  service: "bot_whatsapp",
  niche: "clinicas",
  contentType: "venta_directa",
  objective: "agenda_demo",
});
```

Este test solo verifica `campaignNextAction`/`campaignTitle`, que nunca
leen `hasActionableTarget` — un valor fijo es correcto aquí, no hace
falta parametrizarlo:

```typescript
const item = (state: ContentSummary["state"]): ContentSummary => ({
  id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
  state,
  createdAt: "2026-09-08T00:00:00.000Z",
  service: "bot_whatsapp",
  niche: "clinicas",
  contentType: "venta_directa",
  objective: "agenda_demo",
  hasActionableTarget: false,
});
```

- [ ] **Step 4: Arreglar el fixture de `content-read-approval.test.ts`**

El literal actual (`tests/api/content-read-approval.test.ts:51-59`, dentro
de `"uses the lightweight campaign projection when the repository
provides it"`):

```typescript
const summary = {
  id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
  state: "REVIEW" as const,
  createdAt: "2026-09-08T00:00:00.000Z",
  service: "bot_whatsapp" as const,
  niche: "clinicas" as const,
  contentType: "venta_directa" as const,
  objective: "agenda_demo" as const,
};
```

Este test verifica que el handler de la ruta pasa por el objeto tal cual
lo entrega el repositorio (`toEqual({ items: [summary] })`), así que el
valor no importa para lo que este test cubre — usa `true` para no
sugerir que el caso por defecto es "sin atención":

```typescript
const summary = {
  id: "d32c92ce-9e2b-4aa2-9c39-5c5d97746156",
  state: "REVIEW" as const,
  createdAt: "2026-09-08T00:00:00.000Z",
  service: "bot_whatsapp" as const,
  niche: "clinicas" as const,
  contentType: "venta_directa" as const,
  objective: "agenda_demo" as const,
  hasActionableTarget: true,
};
```

- [ ] **Step 5: Confirmar que solo faltan los repositorios reales**

Run: `npx tsc --noEmit`
Expected: FAIL — ahora solo en `lib/supabase/repository.ts` y
`lib/demo/repository.ts` (Tasks 3 y 4 los arreglan). Confirma que ya no
hay errores en los dos archivos de test tocados.

- [ ] **Step 6: Commit**

```bash
git add lib/content/repository.ts tests/content/campaign-view.test.ts tests/api/content-read-approval.test.ts
git commit -m "feat: add required hasActionableTarget field to ContentSummary"
```

---

### Task 3: `lib/supabase/repository.ts` — calcular `hasActionableTarget` con dos consultas planas

**Files:**
- Modify: `lib/supabase/repository.ts:673-726` (`listContentSummaries`)
- Test: `tests/content/supabase-repository.test.ts`

**Contexto importante para el test:** el mock de `from` que ya existe en
este archivo (`tests/content/supabase-repository.test.ts:89-107`) **no
distingue tabla** — la misma cadena `select/eq/order/maybeSingle`
responde igual sin importar si el código llamó
`.from("content_items")` o `.from("publication_targets")`. Para este
test necesitas un mock que sí distinga tabla, porque vas a alimentar
`content_items` y `publication_targets` con datos distintos a propósito
— no reutilices el mock compartido de la línea 89 tal cual para este
caso.

- [ ] **Step 1: Escribir el test que falla (caso completo del bug de ronda 3)**

Agrega a `tests/content/supabase-repository.test.ts`, dentro de
`describe("SupabaseContentRepository", ...)`, un nuevo `it`:

```typescript
  it("computes hasActionableTarget from a REVIEW-gated PENDING_REVIEW and an ungated ERROR", async () => {
    const draftWithPendingTarget = { ...createdRow, id: "11111111-1111-1111-1111-111111111111", state: "DRAFT" };
    const inReviewWithPendingTarget = { ...createdRow, id: "22222222-2222-2222-2222-222222222222", state: "REVIEW" };
    const approvedWithErrorTarget = { ...createdRow, id: "33333333-3333-3333-3333-333333333333", state: "APPROVED" };
    const publishedNoActionableTarget = { ...createdRow, id: "44444444-4444-4444-4444-444444444444", state: "PUBLISHED" };
    const contentRows = [draftWithPendingTarget, inReviewWithPendingTarget, approvedWithErrorTarget, publishedNoActionableTarget];
    const targetRows = [
      { content_item_id: draftWithPendingTarget.id, status: "PENDING_REVIEW" },
      { content_item_id: inReviewWithPendingTarget.id, status: "PENDING_REVIEW" },
      { content_item_id: approvedWithErrorTarget.id, status: "ERROR" },
    ];

    const from = vi.fn((table: string) => {
      if (table === "publication_targets") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => Promise.resolve({ data: targetRows, error: null })),
            })),
          })),
        };
      }
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => Promise.resolve({ data: contentRows, error: null })),
      };
      return chain;
    });
    const repository = createSupabaseRepository({ from, rpc: vi.fn() } as never, organizationA);

    const summaries = await repository.listContentSummaries();

    expect(summaries.find((item) => item.id === draftWithPendingTarget.id)?.hasActionableTarget).toBe(false);
    expect(summaries.find((item) => item.id === inReviewWithPendingTarget.id)?.hasActionableTarget).toBe(true);
    expect(summaries.find((item) => item.id === approvedWithErrorTarget.id)?.hasActionableTarget).toBe(true);
    expect(summaries.find((item) => item.id === publishedNoActionableTarget.id)?.hasActionableTarget).toBe(false);
  });
```

(Ajusta la forma exacta de la cadena mock de `publication_targets`
—`select().eq().in(...)`— para que coincida con la forma exacta de la
consulta real que escribas en el Step 3; lo importante del test es que
`content_items` y `publication_targets` respondan con datos
**independientes**, y que el caso `draftWithPendingTarget` — un `DRAFT`
con target `PENDING_REVIEW` de creación — dé `false`, que es exactamente
el bug de ronda 3 que este test existe para impedir que regrese.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/content/supabase-repository.test.ts`
Expected: FAIL — `hasActionableTarget` no existe todavía en el resultado,
o la llamada a `.from("publication_targets")` nunca ocurre.

- [ ] **Step 3: Implementar la consulta de dos `Set`s**

En `lib/supabase/repository.ts`, la función actual es:

```typescript
  async listContentSummaries(): Promise<ContentSummary[]> {
    const { data, error } = await this.client
      .from("content_items")
      .select("id, asset_id, service, niche, content_type, objective, campaign_name, offer, funnel_stage, destination, destination_value, campaign_code, state, created_at")
      .eq("organization_id", this.organization.organizationId)
      .order("created_at", { ascending: false });

    if (error) throw new Error("Unable to list content summaries.");
    const rows = z.array(contentItemRowSchema.partial({
      business_line: true,
      format: true,
      cta: true,
      human_description: true,
      allowed_facts: true,
    })).safeParse(data);
    if (!rows.success) throw new Error("Supabase returned invalid content summaries.");
    return rows.data.map((row) => {
      // ... builds and returns each ContentSummary
    });
  }
```

Cámbiala para pedir ambas consultas en paralelo y fusionar el resultado:

```typescript
  async listContentSummaries(): Promise<ContentSummary[]> {
    const [contentResult, targetsResult] = await Promise.all([
      this.client
        .from("content_items")
        .select("id, asset_id, service, niche, content_type, objective, campaign_name, offer, funnel_stage, destination, destination_value, campaign_code, state, created_at")
        .eq("organization_id", this.organization.organizationId)
        .order("created_at", { ascending: false }),
      this.client
        .from("publication_targets")
        .select("content_item_id, status")
        .eq("organization_id", this.organization.organizationId)
        .in("status", ["PENDING_REVIEW", "ERROR"]),
    ]);

    if (contentResult.error) throw new Error("Unable to list content summaries.");
    if (targetsResult.error) throw new Error("Unable to list content summaries.");

    const pendingReviewIds = new Set<string>();
    const errorIds = new Set<string>();
    for (const row of (targetsResult.data ?? []) as Array<{ content_item_id: string; status: string }>) {
      if (row.status === "PENDING_REVIEW") pendingReviewIds.add(row.content_item_id);
      if (row.status === "ERROR") errorIds.add(row.content_item_id);
    }

    const rows = z.array(contentItemRowSchema.partial({
      business_line: true,
      format: true,
      cta: true,
      human_description: true,
      allowed_facts: true,
    })).safeParse(contentResult.data);
    if (!rows.success) throw new Error("Supabase returned invalid content summaries.");
    return rows.data.map((row) => {
      // ... keep the existing brief/campaign parsing exactly as-is, then
      // add hasActionableTarget to the returned object:
      const hasActionableTarget =
        (row.state === "REVIEW" && pendingReviewIds.has(row.id)) ||
        errorIds.has(row.id);
      return {
        id: row.id,
        state: row.state,
        createdAt: row.created_at,
        hasActionableTarget,
        ...brief.data,
        ...(row.asset_id ? { assetId: row.asset_id } : {}),
        ...(campaign.success && row.campaign_code
          ? { campaign: { ...campaign.data, campaignCode: row.campaign_code } }
          : {}),
      };
    });
  }
```

No borres ni reescribas el `brief`/`campaign` parsing existente dentro
del `.map()` — solo agrega el cálculo de `hasActionableTarget` y
agrégalo al objeto de retorno.

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/content/supabase-repository.test.ts`
Expected: PASS, incluyendo el test existente de la línea 84 (que sigue
usando el mock compartido — como ese mock no distingue tabla, la segunda
consulta a `publication_targets` recibirá `[createdRow]` reinterpretado,
pero `createdRow` no tiene `content_item_id`/`status`, así que
`targetsResult.data` será `[createdRow]` con esos campos `undefined` —
confirma que tu código no lanza con eso, simplemente no agrega ningún id
a ninguno de los dos `Set`s. Si el test existente falla, ajusta el
manejo para que una fila sin `content_item_id`/`status` reconocible se
ignore en vez de lanzar.)

- [ ] **Step 5: `tsc` limpio en este archivo**

Run: `npx tsc --noEmit`
Expected: solo quedan errores en `lib/demo/repository.ts` (Task 4).

- [ ] **Step 6: Commit**

```bash
git add lib/supabase/repository.ts tests/content/supabase-repository.test.ts
git commit -m "feat: compute hasActionableTarget with a status-aware two-set query"
```

---

### Task 4: `lib/demo/repository.ts` — calcular `hasActionableTarget` en `DemoContentRepository`

**Files:**
- Modify: `lib/demo/repository.ts:205-219` (`listContentSummaries`)
- Test: `tests/api/content-read-approval.test.ts`

`DemoContentRepository` ya guarda los targets en
`this.targetsByContentItem` (un `Map<string, PublicationTarget[]>`,
usado hoy por `listPublicationTargets` en la línea 195-199) — no hace
falta ningún estado nuevo, solo leerlo desde `listContentSummaries()`.

- [ ] **Step 1: Escribir el test que falla**

En `tests/api/content-read-approval.test.ts`, agrega un nuevo `it` cerca
del existente de la línea 22 (`"lists and returns an owner-scoped
content record"`), usando el mismo patrón (`createDemoRepository()` +
`createContentListHandler`):

```typescript
  it("marks hasActionableTarget only once content reaches REVIEW, and always for ERROR targets", async () => {
    const repository = createDemoRepository();
    const draftItem = await repository.createContentItem(brief);
    // draftItem.state is UPLOADED at creation; its two targets are
    // PENDING_REVIEW from creation (mirrors 0006_create_content_item_with_asset.sql).

    const list = await createContentListHandler({ getRepository: async () => repository })();
    const { items } = (await list.json()) as { items: Array<{ id: string; hasActionableTarget: boolean }> };

    expect(items.find((item) => item.id === draftItem.id)?.hasActionableTarget).toBe(false);
  });
```

(Este caso ya alcanza para probar la mitad `PENDING_REVIEW`-gateada del
predicado sin necesitar mover el item hasta `REVIEW` manualmente — un
item recién creado con `state !== "REVIEW"` y targets `PENDING_REVIEW`
debe dar `false`. Si `createDemoRepository`/`createContentItem` exponen
una forma directa de mover el item a `REVIEW` y forzar un target a
`ERROR` sin pasar por HTTP, añade los dos casos restantes
(`REVIEW`+`PENDING_REVIEW` → `true`, cualquier estado+`ERROR` → `true`)
como asserts adicionales en el mismo test; si no, dejar solo el caso de
arriba es suficiente para este repositorio — los otros dos ya están
cubiertos por el test equivalente de Task 3 contra Supabase, y la lógica
del predicado es la misma función compartida (ver Step 3).**)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/api/content-read-approval.test.ts`
Expected: FAIL — `hasActionableTarget` no existe en el resultado o vale
`undefined`.

- [ ] **Step 3: Extraer el predicado a una función compartida (evita duplicar la lógica de la Task 3)**

Crea `lib/content/actionable-target.ts`:

```typescript
import type { ContentState } from "@/lib/content/state-machine";
import type { PublicationTarget } from "@/lib/content/repository";

/**
 * A content item needs human attention when either a PENDING_REVIEW
 * target exists once the item has reached REVIEW (the only state that
 * gates the approve control today), or any target is ERROR regardless
 * of content state (retry never depends on content.state — see
 * docs/superpowers/specs/2026-09-14-navigation-unification-design.md).
 */
export function hasActionableTarget(contentState: ContentState, targets: Pick<PublicationTarget, "status">[]): boolean {
  const hasPendingReview = targets.some((target) => target.status === "PENDING_REVIEW");
  const hasError = targets.some((target) => target.status === "ERROR");
  return (contentState === "REVIEW" && hasPendingReview) || hasError;
}
```

Luego, en `lib/demo/repository.ts:205-219`:

```typescript
  async listContentSummaries(): Promise<ContentSummary[]> {
    return structuredClone(
      [...this.contentItems.values()].map((item) => ({
        id: item.id,
        state: item.state,
        createdAt: item.createdAt,
        service: item.service,
        niche: item.niche,
        contentType: item.contentType,
        objective: item.objective,
        hasActionableTarget: hasActionableTarget(item.state, this.targetsByContentItem.get(item.id) ?? []),
        ...(item.assetId ? { assetId: item.assetId } : {}),
        ...(item.campaign ? { campaign: item.campaign } : {}),
      })),
    );
  }
```

(Agrega el `import { hasActionableTarget } from "@/lib/content/actionable-target";` al inicio del archivo. Cuidado: el parámetro de la función se llama igual que la función — usa un nombre de import distinto si tu linter se queja, p. ej. `import { hasActionableTarget as computeHasActionableTarget } from ...`.)

- [ ] **Step 4: Volver a `lib/supabase/repository.ts` (Task 3) para usar la misma función**

Reemplaza el cálculo inline de la Task 3, Step 3:

```typescript
      const hasActionableTarget =
        (row.state === "REVIEW" && pendingReviewIds.has(row.id)) ||
        errorIds.has(row.id);
```

por una llamada a la función compartida, pasando dos "fake targets"
sintéticos (o, más simple, ajusta la función para aceptar directamente
los dos `Set`s en vez de un arreglo de targets — decide la forma que
mejor encaje; si cambias la firma, actualiza también el uso en
`lib/demo/repository.ts` del Step 3 de este task). Ejemplo si prefieres
mantener una sola firma basada en `targets`:

```typescript
      const targetsForPredicate = [
        ...(pendingReviewIds.has(row.id) ? [{ status: "PENDING_REVIEW" as const }] : []),
        ...(errorIds.has(row.id) ? [{ status: "ERROR" as const }] : []),
      ];
```

y usa `hasActionableTarget(row.state, targetsForPredicate)` — así la
regla vive en un solo lugar y ambos repositorios no pueden divergir por
accidente. Vuelve a correr `npm test -- tests/content/supabase-repository.test.ts` para confirmar que sigue en PASS tras este cambio.

- [ ] **Step 5: Confirmar que pasa**

Run: `npm test -- tests/api/content-read-approval.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: limpio en todo el repositorio (ambas implementaciones y la
interfaz compilan).

- [ ] **Step 6: Commit**

```bash
git add lib/content/actionable-target.ts lib/demo/repository.ts lib/supabase/repository.ts tests/api/content-read-approval.test.ts
git commit -m "feat: share the hasActionableTarget predicate between both repository implementations"
```

---

### Task 5: `useAttentionTargets` — hook nuevo

**Files:**
- Create: `lib/content/use-attention-targets.ts`
- Test: `tests/content/use-attention-targets.test.tsx`

Reemplaza el `Promise.all` que hoy usa `/review` (`review/page.tsx:29-32`)
por `Promise.allSettled` a propósito — un id que falla no debe tumbar los
demás (corrección de ronda 3, ver spec). Acepta un callback
`onTargetResolved` que la página llama para disparar su propio refetch de
`listContentSummaries()` (Task 7) — el hook no conoce esa función
directamente.

- [ ] **Step 1: Escribir el test que falla — carga solo los ids pedidos, aísla errores por id**

```typescript
/** @vitest-environment jsdom */
import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const getContentRecord = vi.fn();
vi.mock("@/lib/content/client", () => ({
  getContentRecord: (...args: unknown[]) => getContentRecord(...args),
}));

import { useAttentionTargets } from "@/lib/content/use-attention-targets";

function record(id: string, targets: Array<{ id: string; status: string }> = []) {
  return { content: { id, state: "REVIEW" }, targets, drafts: [], auditEvents: [], publicationResults: [] };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAttentionTargets", () => {
  it("fetches getContentRecord only for the given ids", async () => {
    getContentRecord.mockImplementation((id: string) => Promise.resolve(record(id)));

    renderHook(() => useAttentionTargets(["a", "b"]));

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(2));
    expect(getContentRecord).toHaveBeenCalledWith("a");
    expect(getContentRecord).toHaveBeenCalledWith("b");
  });

  it("omits only the id that fails, keeps the rest", async () => {
    getContentRecord.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("boom")) : Promise.resolve(record(id)),
    );

    const { result } = renderHook(() => useAttentionTargets(["a", "b"]));

    await waitFor(() => expect(result.current.records.some((r) => r.content.id === "a")).toBe(true));
    expect(result.current.records.some((r) => r.content.id === "b")).toBe(false);
    expect(result.current.failedIds).toContain("b");
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/content/use-attention-targets.test.tsx`
Expected: FAIL — el módulo `@/lib/content/use-attention-targets` no
existe todavía.

- [ ] **Step 3: Implementar el hook**

```typescript
"use client";

import { useCallback, useEffect, useState } from "react";

import { approveContentTarget, getContentRecord, retryContentTarget } from "@/lib/content/client";
import type { ContentRecord, PublicationTarget } from "@/lib/content/repository";

export function useAttentionTargets(contentItemIds: string[], onTargetResolved?: () => void) {
  const [records, setRecords] = useState<ContentRecord[]>([]);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    Promise.allSettled(contentItemIds.map((id) => getContentRecord(id))).then((results) => {
      if (cancelled) return;
      const nextRecords: ContentRecord[] = [];
      const nextFailedIds: string[] = [];
      results.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") nextRecords.push(outcome.value);
        else nextFailedIds.push(contentItemIds[index]);
      });
      setRecords(nextRecords);
      setFailedIds(nextFailedIds);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // contentItemIds is derived from a filtered list each render; compare by
    // its joined value so a same-membership array doesn't re-trigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentItemIds.join(",")]);

  const refreshOne = useCallback(async (contentItemId: string) => {
    const refreshed = await getContentRecord(contentItemId);
    setRecords((current) => current.map((record) => (record.content.id === contentItemId ? refreshed : record)));
  }, []);

  const handleApprove = useCallback(
    async (contentItemId: string, target: PublicationTarget) => {
      const approved = await approveContentTarget(contentItemId, target);
      if (approved.status !== "APPROVED") throw new Error("PUBLICATION_TARGET_NOT_APPROVED");
      await refreshOne(contentItemId);
      onTargetResolved?.();
      return { ...approved, status: "APPROVED" as const };
    },
    [refreshOne, onTargetResolved],
  );

  const handleRetry = useCallback(
    async (contentItemId: string, targetId: string) => {
      const retried = await retryContentTarget(contentItemId, targetId);
      await refreshOne(contentItemId);
      onTargetResolved?.();
      return { ...retried, status: "APPROVED" as const };
    },
    [refreshOne, onTargetResolved],
  );

  return { records, failedIds, isLoading, handleApprove, handleRetry };
}
```

(`approveContentTarget`/`retryContentTarget` ya existen en
`lib/content/client.ts:51-73`, mismas firmas que `review/page.tsx` ya
usa hoy en `handleProductionApprove`/`handleProductionRetry` — este hook
solo centraliza ese mismo patrón.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/content/use-attention-targets.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/content/use-attention-targets.ts tests/content/use-attention-targets.test.tsx
git commit -m "feat: add useAttentionTargets hook with per-id error isolation"
```

---

### Task 6: `app-icon.tsx` — ícono `settings`

**Files:**
- Modify: `components/layout/app-icon.tsx:3,5-17`

No existe un archivo de test dedicado para `app-icon.tsx` hoy — se
verifica indirectamente en la Task 9 (`app-shell.test.tsx`), cuando el
nuevo link de navegación lo usa. No crear un test aislado nuevo aquí
sería consistente con el patrón existente (ningún ícono actual tiene
test propio).

- [ ] **Step 1: Agregar `"settings"` a `IconName` (línea 3)**

```typescript
type IconName = "home" | "campaigns" | "plus" | "review" | "results" | "chevron" | "spark" | "menu" | "close" | "arrow" | "check" | "settings";
```

- [ ] **Step 2: Agregar el path (dentro del record de la línea 5-17, un engranaje simple, mismo estilo `stroke`)**

```typescript
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
```

- [ ] **Step 3: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: limpio.

- [ ] **Step 4: Commit**

```bash
git add components/layout/app-icon.tsx
git commit -m "feat: add settings icon"
```

---

### Task 7: `/library/page.tsx` — vista unificada

**Files:**
- Modify: `app/(app)/library/page.tsx`
- Test: `tests/components/library-page.test.tsx` (nuevo — no existe hoy ningún test de página para `/library`)

Este es el archivo más grande del plan. Se implementa en sub-pasos, cada
uno con su propio ciclo test-primero, todos sobre el mismo archivo.

**Antes de escribir código, lee estos archivos de referencia exactos:**
- `app/(app)/review/page.tsx` (líneas 23-25 para el patrón `refresh()`
  demo, líneas 53-69 para el patrón de sync producción).
- `app/(app)/drafts/page.tsx` (líneas 42-68 para el patrón de polling —
  se traslada aquí, condicionado a `listContentSummaries()` en vez de
  `getContentRecord()` en bulk).
- `lib/demo/draft-store.ts` (`readDemoDrafts`, `approveDemoTarget`).
- `components/content/publication-targets.tsx` (props: `targets`,
  `onApprove`, `onRetry?`, `disabled?`, `retryDisabled?`).

- [ ] **Step 1: Escribir el test que falla — filtro `attention` usa `hasActionableTarget`, dispara fetch acotado**

Crea `tests/components/library-page.test.tsx` siguiendo exactamente el
patrón de mocking de `tests/components/drafts-page.test.tsx` (mock de
`next/link`, `next/image`, `@/lib/supabase/client`, y
`@/lib/content/client`):

```typescript
/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: Record<string, unknown>) => <img {...(props as Record<string, string>)} alt={props.alt as string} />,
}));
vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig: () => true }));

const listContentSummaries = vi.fn();
const getContentRecord = vi.fn();
vi.mock("@/lib/content/client", () => ({
  listContentSummaries: (...args: unknown[]) => listContentSummaries(...args),
  getContentRecord: (...args: unknown[]) => getContentRecord(...args),
}));

import LibraryPage from "@/app/(app)/library/page";

function summary(id: string, state: string, hasActionableTarget: boolean) {
  return { id, state, createdAt: "2026-09-14T00:00:00.000Z", service: "bot_whatsapp", niche: "clinicas", contentType: "venta_directa", objective: "agenda_demo", hasActionableTarget };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("LibraryPage attention filter", () => {
  it("filters by hasActionableTarget, not state, and fetches detail only for the filtered subset", async () => {
    listContentSummaries.mockResolvedValue([
      summary("a", "DRAFT", false),
      summary("b", "REVIEW", true),
    ]);
    getContentRecord.mockResolvedValue({
      content: { id: "b", state: "REVIEW" },
      targets: [{ id: "target-1", contentItemId: "b", platform: "FACEBOOK", status: "PENDING_REVIEW" }],
      drafts: [],
      auditEvents: [],
      publicationResults: [],
    });

    const user = userEvent.setup();
    render(<LibraryPage />);

    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(1));
    expect(getContentRecord).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Por revisar" }));

    await waitFor(() => expect(getContentRecord).toHaveBeenCalledTimes(1));
    expect(getContentRecord).toHaveBeenCalledWith("b");
  });
});

describe("LibraryPage polling", () => {
  it("polls the cheap list while any item is GENERATING, regardless of active filter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listContentSummaries
      .mockResolvedValueOnce([summary("a", "GENERATING", false)])
      .mockResolvedValueOnce([summary("a", "DRAFT", false)]);

    render(<LibraryPage />);
    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4000);
    await waitFor(() => expect(listContentSummaries).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(4000);
    expect(listContentSummaries).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/components/library-page.test.tsx`
Expected: FAIL (el tab "Por revisar" no dispara ningún fetch acotado
todavía; no hay polling).

- [ ] **Step 3: Implementar — predicado + fetch acotado (producción)**

Reescribe `app/(app)/library/page.tsx`. Puntos clave respecto al
archivo actual:

- `matchesFilter`/`attentionStates` (líneas 24-31 hoy) se elimina el uso
  de `content_items.state` para el filtro `ATTENTION` — usa
  `item.hasActionableTarget` en su lugar.
- Importa `useAttentionTargets` (Task 5) y llámalo con los ids que ya
  pasaron el filtro `attention`, pasando un callback que dispare un
  refetch de `listContentSummaries()`:

```typescript
const [items, setItems] = useState<ContentSummary[]>([]);
// ...
const attentionItems = useMemo(() => items.filter((item) => item.hasActionableTarget), [items]);

function loadSummaries() {
  return listContentSummaries().then(setItems).catch(() => setItems([]));
}

useEffect(() => {
  if (!isProductionMode) { /* ... demo branch, Step 4 ... */ return; }
  let cancelled = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  async function load() {
    const next = await listContentSummaries().catch(() => []);
    if (cancelled) return;
    setItems(next);
    setIsLoading(false);
    if (next.some((item) => item.state === "GENERATING")) {
      pollTimer = setTimeout(load, 4000);
    }
  }

  load();
  return () => {
    cancelled = true;
    if (pollTimer) clearTimeout(pollTimer);
  };
}, [isProductionMode]);

const attention = useAttentionTargets(
  filter === "ATTENTION" ? attentionItems.map((item) => item.id) : [],
  () => { void loadSummaries(); },
);
```

Cuando `filter === "ATTENTION"` (modo producción), renderiza
`attention.records` con `PublicationTargets` inline (mismas props que
`review/page.tsx:104-111` usa hoy — `disabled={!latestDraft ||
record.content.state !== "REVIEW"}`, `retryDisabled={!latestDraft}`,
`onApprove`/`onRetry` conectados a `attention.handleApprove`/
`attention.handleRetry`), en vez de las tarjetas simples que hoy
renderiza el filtro `attention`.

- [ ] **Step 4: Implementar — modo demo (fuente `readDemoDrafts()`, sin segundo fetch)**

Reemplaza el uso de `readDemoAssets()`/`DemoBrowserAsset` por
`readDemoDrafts()`/`DemoDraftRecord` (import desde
`@/lib/demo/draft-store`, no `@/lib/demo/browser-assets`):

```typescript
const [drafts, setDrafts] = useState<DemoDraftRecord[]>([]);

function refreshDemo() {
  setDrafts(readDemoDrafts());
}

useEffect(() => {
  if (isProductionMode) return;
  const timer = window.setTimeout(() => { refreshDemo(); setIsLoading(false); }, 0);
  return () => window.clearTimeout(timer);
}, [isProductionMode]);

function demoHasActionableTarget(record: DemoDraftRecord): boolean {
  return (
    (record.content.state === "REVIEW" && record.targets.some((t) => t.status === "PENDING_REVIEW")) ||
    record.targets.some((t) => t.status === "ERROR")
  );
}
```

En modo demo, el filtro `ATTENTION` usa `demoHasActionableTarget(draft)`
directamente sobre el arreglo ya cargado — no invoques
`useAttentionTargets` en esta rama. Renderiza `PublicationTargets` con
`onApprove` conectado a un handler que llama `approveDemoTarget(...)`
seguido de `refreshDemo()` (mismo patrón que `review/page.tsx:43-51`
hoy). Las tarjetas demo ganan `<Link href={`/drafts/${draft.content.id}`}>`
(hoy no enlazan a nada — hallazgo de ronda 1 del spec).

- [ ] **Step 5: Query param `?filter=`**

```typescript
import { useSearchParams } from "next/navigation";
// ...
const searchParams = useSearchParams();
const [filter, setFilter] = useState<CampaignFilter>(() => {
  const param = searchParams.get("filter");
  if (param === "attention") return "ATTENTION";
  if (param === "scheduled") return "SCHEDULED";
  if (param === "published") return "PUBLISHED";
  return "ALL";
});
```

(Inicialización única en el primer render es suficiente — el spec no
pide sincronización continua URL↔estado al hacer clic en un tab, solo
que un link externo con `?filter=attention` abra directamente en ese
filtro.)

- [ ] **Step 6: Confirmar que pasa**

Run: `npm test -- tests/components/library-page.test.tsx`
Expected: PASS.

Run: `npm test -- tests/content/campaign-view.test.ts`
Expected: PASS (sigue sin tocarse su lógica, solo el fixture de Task 2).

- [ ] **Step 7: `tsc`, lint, build**

Run: `npx tsc --noEmit && npm run lint`
Expected: limpio.

- [ ] **Step 8: Commit**

```bash
git add app/\(app\)/library/page.tsx tests/components/library-page.test.tsx
git commit -m "feat: unify /library into the single attention view"
```

---

### Task 8: `/drafts` y `/review` (páginas de LISTA) → redirects

**Files:**
- Modify: `app/(app)/drafts/page.tsx` (reemplaza el contenido completo)
- Modify: `app/(app)/review/page.tsx` (reemplaza el contenido completo)
- Modify: `tests/components/drafts-page.test.tsx` (reemplaza el contenido completo — sus aserciones de polling ya no aplican, ese comportamiento se movió a `library-page.test.tsx` en la Task 7)
- Test: `tests/components/review-page.test.tsx` (nuevo)

**Importante:** `tests/components/drafts-page.test.tsx` hoy prueba el
polling que vivía en `DraftsPage` (ver Task 7 — ese polling ya se
trasladó a `/library`). Una vez que `DraftsPage` sea un redirect puro,
esas dos pruebas (`"polls every 4s..."`, `"does not poll..."`) dejan de
tener sentido — no las dejes junto a las nuevas, **reemplaza el
contenido completo del archivo**, no solo agregues al final.

`/drafts/[id]/page.tsx` (el detalle) no se toca — solo las páginas de
LISTA `/drafts` y `/review`.

- [ ] **Step 1: Escribir los tests que fallan**

Reemplaza `tests/components/drafts-page.test.tsx` completo:

```typescript
import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import DraftsPage from "@/app/(app)/drafts/page";

describe("DraftsPage", () => {
  it("redirects to /library", () => {
    DraftsPage();
    expect(redirect).toHaveBeenCalledWith("/library");
  });
});
```

Crea `tests/components/review-page.test.tsx`:

```typescript
import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import ReviewPage from "@/app/(app)/review/page";

describe("ReviewPage", () => {
  it("redirects to /library?filter=attention", () => {
    ReviewPage();
    expect(redirect).toHaveBeenCalledWith("/library?filter=attention");
  });
});
```

- [ ] **Step 2: Confirmar que fallan**

Run: `npm test -- tests/components/drafts-page.test.tsx tests/components/review-page.test.tsx`
Expected: FAIL — ambas páginas siguen siendo componentes cliente con
fetch, no redirects.

- [ ] **Step 3: Implementar — quitar `"use client"`, reemplazar por `redirect()`**

`app/(app)/drafts/page.tsx` completo:

```typescript
import { redirect } from "next/navigation";

export default function DraftsPage() {
  redirect("/library");
}
```

`app/(app)/review/page.tsx` completo:

```typescript
import { redirect } from "next/navigation";

export default function ReviewPage() {
  redirect("/library?filter=attention");
}
```

- [ ] **Step 4: Confirmar que pasan**

Run: `npm test -- tests/components/drafts-page.test.tsx tests/components/review-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: `tsc`, build**

Run: `npx tsc --noEmit && npm run build`
Expected: limpio — confirma que ningún otro archivo sigue importando
algo de estas dos páginas que ya no exista (por ejemplo, si algún test
o componente importaba un tipo exportado desde `review/page.tsx` —
poco probable, pero el build lo detecta).

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/drafts/page.tsx app/\(app\)/review/page.tsx tests/components/drafts-page.test.tsx tests/components/review-page.test.tsx
git commit -m "feat: redirect /drafts and /review list pages into /library"
```

---

### Task 9: `app-shell.tsx` — nav de Configuración + corrección del copy ADR-008

**Files:**
- Modify: `components/layout/app-shell.tsx:12-19,84`
- Test: `tests/components/app-shell.test.tsx`

- [ ] **Step 1: Escribir los tests que fallan**

Agrega a `tests/components/app-shell.test.tsx` (revisa el archivo
primero para seguir su patrón de mocking exacto de `usePathname`/
`next/link`):

```typescript
  it("includes a Configuración link to /settings/organizations with the settings icon", () => {
    // ... render con el mismo patrón que los demás tests de este archivo
    expect(screen.getByRole("link", { name: /Configuración/i })).toHaveAttribute("href", "/settings/organizations");
  });

  it("no longer claims publication always requires approval", () => {
    // ... render
    expect(screen.queryByText("La publicación siempre requiere tu aprobación.")).not.toBeInTheDocument();
    expect(screen.getByText(/Publicamos automático cuando el diagnóstico no marca riesgo/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Confirmar que fallan**

Run: `npm test -- tests/components/app-shell.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementar**

En `components/layout/app-shell.tsx:12-19`, agrega la 7ª entrada al
arreglo `navigation`:

```typescript
const navigation = [
  { href: "/", label: "Inicio", eyebrow: "Resumen", icon: "home" },
  { href: "/library", label: "Campañas", eyebrow: "Workspace", icon: "campaigns" },
  { href: "/library/new", label: "Nueva campaña", eyebrow: "Crear", icon: "plus" },
  { href: "/review", label: "Revisión", eyebrow: "Tu aprobación", icon: "review" },
  { href: "/history", label: "Resultados", eyebrow: "Aprendizaje", icon: "results" },
  { href: "/pilot", label: "Piloto", eyebrow: "Salida real", icon: "check" },
  { href: "/settings/organizations", label: "Configuración", eyebrow: "Organización", icon: "settings" },
] satisfies Array<{ href: string; label: string; eyebrow: string; icon: IconName }>;
```

**Nota:** el link `/review` se queda en el nav (sigue siendo una URL
válida — ahora redirige, no un 404) — el spec no pide quitarlo, solo
agregar Configuración. Confírmalo releyendo el "Alcance" del spec antes
de quitarlo por tu cuenta.

En la línea 84, cambia el texto:

```typescript
            <p className="mt-1 text-xs leading-5 text-slate-500">Publicamos automático cuando el diagnóstico no marca riesgo; si lo marca, pedimos tu aprobación.</p>
```

- [ ] **Step 4: Confirmar que pasan**

Run: `npm test -- tests/components/app-shell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/layout/app-shell.tsx tests/components/app-shell.test.tsx
git commit -m "feat: add settings nav entry and fix ADR-008 sidebar copy"
```

---

### Task 10: Verificación final end-to-end

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Suite completa**

Run: `npm test`
Expected: todos los tests en PASS, incluidos los 9 tasks anteriores.

- [ ] **Step 2: Tipos, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: limpio.

- [ ] **Step 3: Verificación manual en navegador**

Con el dev server corriendo:
- `/library` — confirma que el tab "Por revisar" solo muestra campañas
  con un target realmente accionable (no un `DRAFT` recién creado).
- `/drafts` redirige a `/library`.
- `/review` redirige a `/library?filter=attention` y ese tab queda
  activo.
- El sidebar muestra el link "Configuración" y el nuevo texto sobre
  ADR-008.
- Aprobar/reintentar un target en el tab "Por revisar" hace que la
  tarjeta desaparezca de ese filtro y el contador baje, sin recargar la
  página.

- [ ] **Step 4: No commit en este task — es solo verificación**

Si algo falla, vuelve a la task correspondiente y corrige ahí, con su
propio commit adicional.

---

## Nota de alcance (del reviewer de ronda 3, advisory)

Codex CLI recomendó que el plan separe claramente contrato/repositorio
(Tasks 1-4), adaptación demo/producción (Task 7, sub-pasos 3-4),
página/polling (Task 7) y redirects/tests (Tasks 8-9) — esta
estructura de 10 tasks ya sigue esa separación.
