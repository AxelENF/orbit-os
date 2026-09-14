# SnapGad Batch Studio — compositor de logo en lote — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir "Logo Studio" — herramienta standalone, 100% client-side, para componer el logo de una organización sobre N creativos en lote y exportarlos como ZIP.

**Architecture:** Matemática de composición pura y testeable (`computeLogoPlacement`) separada del efecto de `<canvas>` (`compositeToBlob`); un logo único por organización persistido en Supabase Storage bajo una ruta fija (`{organization_id}/logo.png`) y servido de vuelta al navegador por un proxy same-origin (nunca una URL firmada directa, para evitar que el canvas quede "tainted" por CORS); los creativos del usuario nunca tocan Supabase.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Supabase Storage, `react-dropzone` (ya instalado, sin uso hoy), `jszip` (dependencia nueva), Vitest + Testing Library.

---

## Antes de empezar

- Rama: `feat/logo-batch-compositor` (ya activa, basada en `feat/personal-pilot-hardening`, commit `84e6b0d`). Próxima migración: `0018`.
- Ignora cualquier cambio en `.codebase-memory/` que aparezca en `git status` — indexador de fondo ajeno, nunca lo agregues a un commit.
- Cada tarea termina en su propio commit (`git add <archivos exactos>`, nunca `git add -A`).
- Regla de seguridad: nunca `git reset --hard`, `git checkout --`, `git clean`, ni nada que descarte trabajo ya commiteado. Si algo falla de forma inesperada, para y reporta.
- Nunca corras dos procesos `codex exec` en paralelo sobre este mismo checkout.
- Después de cada tarea, verifica de forma independiente — no confíes solo en el auto-reporte de quien implementó: vuelve a correr los comandos de verificación tú mismo y revisa el diff real (`git show --stat`, `git diff --cached`).
- Comandos de verificación usados en todo el plan: `npm test -- <archivo>` (Vitest), `npx tsc --noEmit`, `npx eslint <archivo>` (evita `npm run lint` sin argumentos — falla con `EPERM` al recorrer `.codebase-memory/` en este entorno), `npm run build`.

---

### Task 1: Migración — bucket `organization-logos` + políticas RLS

**Files:**
- Create: `supabase/migrations/0018_organization_logos_bucket.sql`

- [ ] **Step 1: Crear la migración**

```sql
-- 0018_organization_logos_bucket.sql
insert into storage.buckets (id, name, public)
values ('organization-logos', 'organization-logos', false)
on conflict (id) do nothing;

create policy "Organization members read organization logos" on storage.objects
  for select to authenticated using (
    bucket_id = 'organization-logos'
    and public.is_organization_member((storage.foldername(name))[1]::uuid)
  );

create policy "Organization owners upload organization logos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
    and name = (storage.foldername(name))[1] || '/logo.png'
  );

create policy "Organization owners replace organization logos" on storage.objects
  for update to authenticated using (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
  ) with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
    and name = (storage.foldername(name))[1] || '/logo.png'
  );
```

`public.is_organization_member`/`public.has_organization_role` ya existen (creadas en `supabase/migrations/0008_tenancy_foundation.sql`, reutilizadas tal cual por `content-assets` en `0009_tenantize_content_and_jobs.sql:355-375`) — no las reinventes.

- [ ] **Step 2: Verificar que sigue el mismo estilo que las políticas existentes**

No hay test de Vitest para RLS pura — verifica manualmente que el SQL sigue el mismo estilo que `supabase/migrations/0009_tenantize_content_and_jobs.sql:355-375` (mismos nombres de función, mismo casteo `::uuid`, mismas convenciones de nombres de política).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0018_organization_logos_bucket.sql
git commit -m "feat: add organization-logos Storage bucket with RLS policies"
```

---

### Task 2: `lib/logo-studio/compose.ts` — matemática de composición + canvas

**Files:**
- Create: `lib/logo-studio/compose.ts`
- Test: `lib/logo-studio/compose.test.ts` (función pura, `@vitest-environment node`)
- Test: `lib/logo-studio/compose-canvas.test.ts` (canvas, `@vitest-environment jsdom`)

**Estrategia de testing de canvas (ya resuelta en el spec, no la reinventes):** jsdom no implementa un contexto 2D funcional ni decodifica imágenes reales — `HTMLImageElement.decode()` no existe, así que `new Image()` real en un test nunca tiene `naturalWidth`/`naturalHeight` distintos de `0`. Los tests de `compositeToBlob` usan objetos `{ naturalWidth, naturalHeight } as unknown as HTMLImageElement` en vez de instancias reales de `Image`, y mockean `HTMLCanvasElement.prototype.getContext`/`toBlob` directamente. No instales el paquete `canvas` (binario nativo, innecesario con este enfoque).

**Corrección tras revisión de Codex CLI ronda 1 (decisión que no debía quedar
pendiente para la implementación):** la versión anterior de este plan dejaba
como "decisión durante la implementación" si hacía falta dividir el archivo
de test en dos, por el conflicto de `@vitest-environment node` vs. `jsdom`
en un mismo archivo (Vitest 4.1.11 aplica el pragma a nivel de archivo
completo, no se pueden mezclar dos en el mismo). Se decide aquí, no se
pospone: **dos archivos separados desde el principio** —
`compose.test.ts` (función pura, `node`) y `compose-canvas.test.ts`
(canvas, `jsdom`) — ambos importan de `lib/logo-studio/compose.ts`, que
sigue siendo un solo archivo fuente (solo el test se divide).

- [ ] **Step 1: Escribir los tests que fallan — `computeLogoPlacement` (función pura, sin mocks) — `lib/logo-studio/compose.test.ts`**

```typescript
/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { computeLogoPlacement } from "@/lib/logo-studio/compose";

describe("computeLogoPlacement", () => {
  it("places the logo in the top-left corner with the given margin", () => {
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "top-left", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(1080 * 0.04);
    expect(placement.y).toBeCloseTo(1080 * 0.04);
  });

  it("places the logo in the top-right corner with the given margin", () => {
    const margin = 1080 * 0.04;
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "top-right", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(1080 - placement.width - margin);
    expect(placement.y).toBeCloseTo(margin);
  });

  it("places the logo in the bottom-left corner with the given margin", () => {
    const margin = 1080 * 0.04;
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "bottom-left", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(margin);
    expect(placement.y).toBeCloseTo(1350 - placement.height - margin);
  });

  it("places the logo in the bottom-right corner with the given margin", () => {
    const margin = 1080 * 0.04;
    const placement = computeLogoPlacement(1080, 1350, 200, 100, { corner: "bottom-right", sizePercent: 15, marginPercent: 4 });
    expect(placement.x).toBeCloseTo(1080 - placement.width - margin);
    expect(placement.y).toBeCloseTo(1350 - placement.height - margin);
  });

  it("preserves the logo's aspect ratio", () => {
    const placement = computeLogoPlacement(1080, 1350, 400, 100, { corner: "top-left", sizePercent: 20, marginPercent: 4 });
    expect(placement.height / placement.width).toBeCloseTo(100 / 400);
  });

  it("clamps size so a very tall/narrow logo never exceeds the creative's own height, not just its width", () => {
    // logo natural 100x1000 (mucho más alto que ancho); sizePercent alto
    const placement = computeLogoPlacement(1080, 1350, 100, 1000, { corner: "top-left", sizePercent: 40, marginPercent: 10 });
    const margin = Math.min(1080, 1350) * 0.10;
    expect(placement.height).toBeLessThanOrEqual(1350 - margin * 2 + 0.01);
    expect(placement.width).toBeLessThanOrEqual(1080 - margin * 2 + 0.01);
  });

  it("throws for non-positive logo dimensions instead of dividing by zero", () => {
    expect(() => computeLogoPlacement(1080, 1350, 0, 100, { corner: "top-left", sizePercent: 15, marginPercent: 4 })).toThrow();
    expect(() => computeLogoPlacement(1080, 1350, 100, 0, { corner: "top-left", sizePercent: 15, marginPercent: 4 })).toThrow();
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- lib/logo-studio/compose.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar `computeLogoPlacement`**

```typescript
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CompositeOptions = { corner: Corner; sizePercent: number; marginPercent: number };
export type OutputFormat = "image/png" | "image/jpeg";

export function computeLogoPlacement(
  creativeWidth: number,
  creativeHeight: number,
  logoNaturalWidth: number,
  logoNaturalHeight: number,
  options: CompositeOptions,
): { x: number; y: number; width: number; height: number } {
  if (logoNaturalWidth <= 0 || logoNaturalHeight <= 0) {
    throw new Error("Logo dimensions must be positive.");
  }
  const shortSide = Math.min(creativeWidth, creativeHeight);
  const margin = shortSide * (options.marginPercent / 100);
  const availableWidth = creativeWidth - margin * 2;
  const availableHeight = creativeHeight - margin * 2;

  let width = shortSide * (options.sizePercent / 100);
  let height = width * (logoNaturalHeight / logoNaturalWidth);

  const scale = Math.min(1, availableWidth / width, availableHeight / height);
  width *= scale;
  height *= scale;

  const x = options.corner.includes("left") ? margin : creativeWidth - width - margin;
  const y = options.corner.includes("top") ? margin : creativeHeight - height - margin;
  return { x, y, width, height };
}
```

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- lib/logo-studio/compose.test.ts`
Expected: PASS (los 4 tests de `computeLogoPlacement`; los de `compositeToBlob` del siguiente step aún no existen).

- [ ] **Step 5: Escribir el test que falla — `compositeToBlob` (canvas mockeado) — `lib/logo-studio/compose-canvas.test.ts` (archivo separado, ver nota arriba)**

```typescript
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { compositeToBlob, computeLogoPlacement } from "@/lib/logo-studio/compose";

function fakeImage(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  return { naturalWidth, naturalHeight } as unknown as HTMLImageElement;
}

describe("compositeToBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws the creative full-size, then the logo at the exact placement computeLogoPlacement predicts, and resolves with the mocked blob", async () => {
    const drawImageCalls: unknown[][] = [];
    const fakeContext = {
      drawImage: (...args: unknown[]) => { drawImageCalls.push(args); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext as unknown as CanvasRenderingContext2D);
    const fakeBlob = new Blob(["fake"], { type: "image/png" });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
      callback(fakeBlob);
    });

    const creative = fakeImage(1080, 1350);
    const logo = fakeImage(200, 100);
    const options = { corner: "bottom-right" as const, sizePercent: 15, marginPercent: 4 };
    const result = await compositeToBlob(creative, logo, options, "image/png");
    const expectedPlacement = computeLogoPlacement(1080, 1350, 200, 100, options);

    expect(result).toBe(fakeBlob);
    expect(drawImageCalls).toHaveLength(2); // creativo, luego logo
    // Corrección ronda 1: antes solo se verificaba QUÉ objeto se dibujó,
    // no las coordenadas/tamaño reales — ahora se comparan contra
    // computeLogoPlacement directamente, no un número inventado.
    expect(drawImageCalls[0]).toEqual([creative, 0, 0, 1080, 1350]);
    expect(drawImageCalls[1]).toEqual([logo, expectedPlacement.x, expectedPlacement.y, expectedPlacement.width, expectedPlacement.height]);
  });

  it("passes the given jpegQuality to toBlob for image/jpeg output", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const toBlobSpy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
      callback(new Blob(["fake"], { type: "image/jpeg" }));
    });

    await compositeToBlob(fakeImage(1080, 1350), fakeImage(200, 100), { corner: "top-left", sizePercent: 15, marginPercent: 4 }, "image/jpeg", 0.8);

    expect(toBlobSpy).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.8);
  });

  it("rejects when toBlob yields null (canvas export failure)", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
      callback(null);
    });

    await expect(
      compositeToBlob(fakeImage(1080, 1350), fakeImage(200, 100), { corner: "top-left", sizePercent: 15, marginPercent: 4 }, "image/png"),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Confirmar que falla**

Run: `npm test -- lib/logo-studio/compose-canvas.test.ts`
Expected: FAIL — `compositeToBlob` no existe todavía.

- [ ] **Step 7: Implementar `compositeToBlob`**

```typescript
export function compositeToBlob(
  creativeImage: HTMLImageElement,
  logoImage: HTMLImageElement,
  options: CompositeOptions,
  outputFormat: OutputFormat,
  jpegQuality = 0.92,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = creativeImage.naturalWidth;
  canvas.height = creativeImage.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to get a 2D canvas context.");

  context.drawImage(creativeImage, 0, 0, canvas.width, canvas.height);
  const placement = computeLogoPlacement(canvas.width, canvas.height, logoImage.naturalWidth, logoImage.naturalHeight, options);
  context.drawImage(logoImage, placement.x, placement.y, placement.width, placement.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error("Canvas export failed.")); return; }
        resolve(blob);
      },
      outputFormat,
      outputFormat === "image/jpeg" ? jpegQuality : undefined,
    );
  });
}
```

- [ ] **Step 8: Confirmar que pasa**

Run: `npm test -- lib/logo-studio/compose.test.ts lib/logo-studio/compose-canvas.test.ts`
Expected: PASS, todos los tests de ambos archivos (7 en `compose.test.ts`, 3 en `compose-canvas.test.ts`).

- [ ] **Step 9: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/logo-studio/compose.ts lib/logo-studio/compose.test.ts lib/logo-studio/compose-canvas.test.ts`
Expected: limpio.

- [ ] **Step 10: Commit**

```bash
git add lib/logo-studio/compose.ts lib/logo-studio/compose.test.ts lib/logo-studio/compose-canvas.test.ts
git commit -m "feat: add pure logo placement math and canvas compositing"
```

---

### Task 3: `lib/logo-studio/export-zip.ts` — empaquetado ZIP

**Files:**
- Create: `lib/logo-studio/export-zip.ts`
- Test: `lib/logo-studio/export-zip.test.ts`
- Modify: `package.json` (agrega `jszip` a `dependencies`)

- [ ] **Step 1: Instalar `jszip`**

**Corrección tras revisión de Codex CLI ronda 1 (ambigüedad de lockfile
resuelta, no dejada para la implementación):** este repositorio tiene
tanto `package-lock.json` como `pnpm-lock.yaml`, pero `pnpm` **no está
instalado** en el entorno donde se ejecuta este trabajo (verificado:
`pnpm --version` falla con "command not found") — todos los comandos de
este plan y de los dos planes anteriores de esta sesión ya se ejecutan
con `npm`. `package-lock.json` es el único lockfile que este entorno
puede mantener actualizado; `pnpm-lock.yaml` es anterior a esta sesión
y se deja intacto, sin tocarlo (no se actualiza ni se borra — no es
parte del alcance de este cambio).

```bash
npm install jszip
```

Confirma que `package.json` y `package-lock.json` quedan actualizados (`git status` debe mostrar ambos modificados; `pnpm-lock.yaml` debe seguir intacto, sin cambios).

- [ ] **Step 2: Escribir el test que falla — nombres finales por extensión de salida, deduplicados DESPUÉS de convertir**

**Orden crítico (hallazgo real de la ronda 3 de revisión del spec):** la deduplicación debe correr sobre los nombres YA convertidos a su extensión de salida, no sobre los nombres originales — si no, `foto.webp` y `foto.jpg` (dos nombres originales distintos, ambos con salida JPEG) colisionarían silenciosamente después de la conversión sin que la deduplicación lo detectara.

```typescript
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { buildLogoStudioZip, resolveOutputFilename } from "@/lib/logo-studio/export-zip";

describe("resolveOutputFilename", () => {
  it("derives the extension from outputFormat, not the original filename", () => {
    expect(resolveOutputFilename("foto.webp", "image/jpeg")).toBe("foto.jpg");
    expect(resolveOutputFilename("foto.png", "image/png")).toBe("foto.png");
    expect(resolveOutputFilename("foto.jpeg", "image/jpeg")).toBe("foto.jpg");
  });

  it("sanitizes the filename the same way lib/supabase/repository.ts:556-559 does (hallazgo ronda 1)", () => {
    expect(resolveOutputFilename("mi foto (final)!.webp", "image/jpeg")).toBe("mi_foto__final__.jpg");
  });
});

describe("buildLogoStudioZip", () => {
  it("deduplicates names that only collide AFTER extension conversion", async () => {
    const entries = [
      { originalFilename: "foto.webp", outputFormat: "image/jpeg" as const, blob: new Blob(["a"]) },
      { originalFilename: "foto.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["b"]) },
    ];
    const zipBlob = await buildLogoStudioZip(entries);
    const zip = await JSZip.loadAsync(zipBlob);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["foto-2.jpg", "foto.jpg"]);
  });

  it("never assigns the same final name twice, even when a generated suffix collides with an existing input name (hallazgo ronda 1 — bug real de dedupe)", async () => {
    // foto.jpg, foto-2.jpg (ya viene con ese nombre), y otro foto.jpg —
    // el tercero no puede resolver a "foto-2.jpg", ya está tomado por el
    // segundo; debe seguir a "foto-3.jpg".
    const entries = [
      { originalFilename: "foto.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["a"]) },
      { originalFilename: "foto-2.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["b"]) },
      { originalFilename: "foto.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["c"]) },
    ];
    const zipBlob = await buildLogoStudioZip(entries);
    const zip = await JSZip.loadAsync(zipBlob);
    expect(Object.keys(zip.files).sort()).toEqual(["foto-2.jpg", "foto-3.jpg", "foto.jpg"]);
  });

  it("packages N blobs into a zip with exactly N entries", async () => {
    const entries = [
      { originalFilename: "a.png", outputFormat: "image/png" as const, blob: new Blob(["a"]) },
      { originalFilename: "b.png", outputFormat: "image/png" as const, blob: new Blob(["b"]) },
      { originalFilename: "c.jpg", outputFormat: "image/jpeg" as const, blob: new Blob(["c"]) },
    ];
    const zipBlob = await buildLogoStudioZip(entries);
    const zip = await JSZip.loadAsync(zipBlob);
    expect(Object.keys(zip.files)).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Confirmar que falla**

Run: `npm test -- lib/logo-studio/export-zip.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 4: Implementar**

```typescript
import JSZip from "jszip";

import type { OutputFormat } from "@/lib/logo-studio/compose";

export type ZipEntryInput = {
  originalFilename: string;
  outputFormat: OutputFormat;
  blob: Blob;
};

export function resolveOutputFilename(originalFilename: string, outputFormat: OutputFormat): string {
  const extension = outputFormat === "image/png" ? "png" : "jpg";
  // Corrección ronda 1: la spec exige el mismo saneamiento que ya usa
  // lib/supabase/repository.ts:556-559 para nombres de archivo — la
  // versión anterior de este plan no lo aplicaba en absoluto.
  const sanitized = originalFilename
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "creative";
  const withoutExtension = sanitized.replace(/\.[^./\\]+$/, "");
  return `${withoutExtension}.${extension}`;
}

function dedupe(names: string[]): string[] {
  // Corrección ronda 1 (bug real): la versión anterior usaba un contador
  // por nombre ORIGINAL, no verificaba si el nombre GENERADO ya estaba en
  // uso — con ["foto.jpg", "foto-2.jpg", "foto.jpg"], producía dos
  // entradas "foto-2.jpg" (una ya presente en el input, otra generada al
  // desambiguar la tercera). Esta versión rastrea el conjunto de nombres
  // ya asignados y sigue incrementando el sufijo hasta encontrar uno
  // realmente libre.
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const base = dot === -1 ? name : name.slice(0, dot);
    const extension = dot === -1 ? "" : name.slice(dot);
    let suffix = 2;
    let candidate = `${base}-${suffix}${extension}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}${extension}`;
    }
    used.add(candidate);
    return candidate;
  });
}

export async function buildLogoStudioZip(entries: ZipEntryInput[]): Promise<Blob> {
  const finalNames = dedupe(entries.map((entry) => resolveOutputFilename(entry.originalFilename, entry.outputFormat)));
  const zip = new JSZip();
  entries.forEach((entry, index) => {
    zip.file(finalNames[index], entry.blob);
  });
  return zip.generateAsync({ type: "blob" });
}

export function downloadZip(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: Confirmar que pasa**

Run: `npm test -- lib/logo-studio/export-zip.test.ts`
Expected: PASS.

- [ ] **Step 6: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/logo-studio/export-zip.ts lib/logo-studio/export-zip.test.ts`
Expected: limpio. Si `jszip` no trae sus propios tipos (versiones recientes sí los incluyen), instala `@types/jszip` como fallback y vuelve a correr.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/logo-studio/export-zip.ts lib/logo-studio/export-zip.test.ts
git commit -m "feat: add ZIP export with output-extension-aware deduplication"
```

---

### Task 4: `app/api/organizations/[id]/logo/route.ts` — proxy same-origin + subida

**Files:**
- Create: `app/api/organizations/[id]/logo/route.ts`
- Test: `tests/api/organization-logo.test.ts`

**Antes de escribir código, lee `app/api/organizations/[id]/profile/route.ts` completo** — esta ruta nueva sigue su misma secuencia base (validar UUID con zod → `supabase.auth.getUser()` → resolver membership vía `organization_members`), pero con un gate de rol distinto y sin el JSON-parsing de esa ruta (esta usa `multipart/form-data` para `POST` y devuelve bytes de imagen para `GET`, no JSON).

**Predicado exacto de "no hay logo todavía" (verificado contra el SDK instalado, `@supabase/storage-js@2.116.0`; corrección de cita tras revisión de Codex CLI ronda 1 — línea `17`, no `16`):** `@supabase/supabase-js` re-exporta `StorageApiError` (`node_modules/@supabase/supabase-js/src/index.ts:17`), que trae un campo `.code` — "Service-specific error code from the Storage API response body, such as `NoSuchKey`, `AccessDenied`...". El predicado correcto es `error instanceof StorageApiError && error.code === "NoSuchKey"` → `404 LOGO_NOT_CONFIGURED`; cualquier otro error → `503 LOGO_LOOKUP_FAILED`.

**Manejo de errores completo (corrección tras revisión de Codex CLI ronda 1
— el ejemplo anterior no distinguía estos casos, calcaba solo la parte
feliz de `profile/route.ts`):** siguiendo el mismo patrón de
`profile/route.ts:130-147` (`resolveMembership`/`MembershipLookupError`)
y `withRouteDependencies` (línea `326-341`, catch-all → `503`), esta
ruta distingue explícitamente:
- Membership **no existe** (la organización es válida pero el usuario no
  pertenece) → `404 ORGANIZATION_NOT_FOUND`.
- La consulta de membership **lanza** una excepción (fallo real de
  Supabase, no "no pertenece") → `503 ORGANIZATION_LOOKUP_FAILED`, nunca
  `404` — un 404 en este caso ocultaría un fallo real detrás de un
  mensaje de "no encontrado".
- `request.formData()` puede lanzar (multipart malformado) → capturado,
  `400 INVALID_REQUEST`.
- La creación del cliente de Supabase server-side puede fallar (falta de
  configuración) → capturado en el nivel más externo, `503
  LOGO_INTEGRATION_NOT_CONFIGURED` (mismo patrón que
  `PROFILE_INTEGRATION_NOT_CONFIGURED` en `profile/route.ts`).

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
import { describe, expect, it, vi } from "vitest";
import { StorageApiError } from "@supabase/supabase-js";

import { createOrganizationLogoGetHandler, createOrganizationLogoPostHandler } from "@/app/api/organizations/[id]/logo/route";

const organizationId = "1e62a32f-64c2-4da4-bad0-2837baad7812";
const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function context() {
  return { params: Promise.resolve({ id: organizationId }) };
}

describe("GET /api/organizations/[id]/logo", () => {
  it("streams the logo bytes with image/png content-type when it exists", async () => {
    const download = vi.fn().mockResolvedValue({ data: new Blob([pngSignature], { type: "image/png" }), error: null });
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "editor" }),
      download,
    });
    const response = await handler(new Request("http://localhost/api/organizations/x/logo"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(download).toHaveBeenCalledWith(`${organizationId}/logo.png`);
  });

  it("responds 404 LOGO_NOT_CONFIGURED when the object doesn't exist (StorageApiError NoSuchKey)", async () => {
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: new StorageApiError("not found", 404, "not_found", "storage", "NoSuchKey"),
    });
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "viewer" }),
      download,
    });
    const response = await handler(new Request("http://localhost/api/organizations/x/logo"), context());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "LOGO_NOT_CONFIGURED" });
  });

  it("responds 503 LOGO_LOOKUP_FAILED for a real Storage error", async () => {
    const download = vi.fn().mockResolvedValue({
      data: null,
      error: new StorageApiError("boom", 500, "internal_error", "storage", "InternalError"),
    });
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "viewer" }),
      download,
    });
    const response = await handler(new Request("http://localhost/api/organizations/x/logo"), context());
    expect(response.status).toBe(503);
  });

  it("does not allow reading a different organization's logo", async () => {
    const handler = createOrganizationLogoGetHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => null, // sin membership en esta organización
      download: vi.fn(),
    });
    const response = await handler(new Request("http://localhost/api/organizations/x/logo"), context());
    expect(response.status).toBe(404); // ORGANIZATION_NOT_FOUND, no expone si el logo existe
  });
});

describe("POST /api/organizations/[id]/logo", () => {
  function formDataRequest(bytes: Uint8Array, filename = "logo.png") {
    const formData = new FormData();
    formData.set("logo", new File([bytes], filename, { type: "image/png" }));
    return new Request("http://localhost/api/organizations/x/logo", { method: "POST", body: formData });
  }

  it("uploads with upsert, forcing contentType image/png regardless of client-supplied type", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload,
    });
    const response = await handler(formDataRequest(pngSignature), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(upload).toHaveBeenCalledWith(
      `${organizationId}/logo.png`,
      expect.anything(),
      expect.objectContaining({ upsert: true, contentType: "image/png" }),
    );
  });

  it("rejects a non-owner with 403", async () => {
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "editor" }),
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(pngSignature), context());
    expect(response.status).toBe(403);
  });

  it("rejects a file whose bytes aren't a real PNG, regardless of declared Content-Type", async () => {
    const notPng = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(notPng), context());
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_LOGO_FORMAT" });
  });

  it("accepts real PNG bytes even when the client falsely declares a different Content-Type (hallazgo ronda 1 — el test anterior solo probaba bytes-no-PNG con MIME correcto, nunca al revés)", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload,
    });
    // Bytes PNG reales, pero el File se etiqueta como image/jpeg — la
    // validación real es por firma de bytes, no por esta etiqueta.
    const formData = new FormData();
    formData.set("logo", new File([pngSignature], "logo.png", { type: "image/jpeg" }));
    const request = new Request("http://localhost/api/organizations/x/logo", { method: "POST", body: formData });

    const response = await handler(request, context());

    expect(response.status).toBe(200);
    expect(upload).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ contentType: "image/png" }));
  });

  it("returns 503 ORGANIZATION_LOOKUP_FAILED (not 404) when the membership lookup itself throws", async () => {
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => { throw new Error("connection reset"); },
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(pngSignature), context());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "ORGANIZATION_LOOKUP_FAILED" });
  });

  it("rejects a file over 5MB with 413", async () => {
    const tooLarge = new Uint8Array(5 * 1024 * 1024 + 1);
    tooLarge.set(pngSignature);
    const handler = createOrganizationLogoPostHandler({
      getSession: async () => ({ userId: "user-1" }),
      getMembership: async () => ({ role: "owner" }),
      upload: vi.fn(),
    });
    const response = await handler(formDataRequest(tooLarge), context());
    expect(response.status).toBe(413);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/api/organization-logo.test.ts`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
import { z } from "zod";
import { StorageApiError } from "@supabase/supabase-js";

import { canManageConnections, type OrganizationRole } from "@/lib/organizations/permissions";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const organizationIdSchema = z.string().uuid();
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

type Session = { userId: string };
type Membership = { role: OrganizationRole };
type RouteContext = { params: Promise<{ id: string }> };

async function resolveAuthAndMembership(
  deps: { getSession: () => Promise<Session | null>; getMembership: (input: { organizationId: string; userId: string }) => Promise<Membership | null> },
  params: { id: string },
): Promise<{ organizationId: string; membership: Membership } | Response> {
  const parsed = organizationIdSchema.safeParse(params.id);
  if (!parsed.success) return jsonError("INVALID_ORGANIZATION_ID", 400);
  const session = await deps.getSession();
  if (!session) return jsonError("AUTHENTICATION_REQUIRED", 401);
  // Corrección ronda 1: distinguir "la consulta de membership lanzó" (falla
  // real, 503) de "la consulta resolvió sin encontrar nada" (no pertenece,
  // 404) — mismo patrón que resolveMembership/MembershipLookupError en
  // profile/route.ts:130-147. La versión anterior mapeaba ambos casos a 404.
  let membership: Membership | null;
  try {
    membership = await deps.getMembership({ organizationId: parsed.data, userId: session.userId });
  } catch {
    return jsonError("ORGANIZATION_LOOKUP_FAILED", 503);
  }
  if (!membership) return jsonError("ORGANIZATION_NOT_FOUND", 404);
  return { organizationId: parsed.data, membership };
}

function isPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

type GetHandlerDependencies = {
  getSession: () => Promise<Session | null>;
  getMembership: (input: { organizationId: string; userId: string }) => Promise<Membership | null>;
  download: (path: string) => Promise<{ data: Blob | null; error: unknown }>;
};

export function createOrganizationLogoGetHandler(deps: GetHandlerDependencies) {
  return async function handleGet(_request: Request, context: RouteContext): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(deps, params);
    if (resolved instanceof Response) return resolved;

    const { data, error } = await deps.download(`${resolved.organizationId}/logo.png`);
    if (error) {
      if (error instanceof StorageApiError && error.code === "NoSuchKey") {
        return jsonError("LOGO_NOT_CONFIGURED", 404);
      }
      return jsonError("LOGO_LOOKUP_FAILED", 503);
    }
    if (!data) return jsonError("LOGO_LOOKUP_FAILED", 503);

    return new Response(data, { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  };
}

type PostHandlerDependencies = {
  getSession: () => Promise<Session | null>;
  getMembership: (input: { organizationId: string; userId: string }) => Promise<Membership | null>;
  upload: (path: string, body: ArrayBuffer, options: { upsert: boolean; contentType: string }) => Promise<{ error: unknown }>;
};

export function createOrganizationLogoPostHandler(deps: PostHandlerDependencies) {
  return async function handlePost(request: Request, context: RouteContext): Promise<Response> {
    const params = await context.params;
    const resolved = await resolveAuthAndMembership(deps, params);
    if (resolved instanceof Response) return resolved;
    if (!canManageConnections(resolved.membership.role)) return jsonError("ORGANIZATION_ACCESS_DENIED", 403);

    // Corrección ronda 1: request.formData() puede lanzar con multipart
    // malformado — la versión anterior lo dejaba sin capturar.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonError("INVALID_REQUEST", 400);
    }
    const file = formData.get("logo");
    if (!(file instanceof File)) return jsonError("INVALID_REQUEST", 400);
    if (file.size > MAX_LOGO_BYTES) return jsonError("REQUEST_TOO_LARGE", 413);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPngSignature(bytes)) return jsonError("INVALID_LOGO_FORMAT", 422);

    const { error } = await deps.upload(`${resolved.organizationId}/logo.png`, bytes.buffer, { upsert: true, contentType: "image/png" });
    if (error) return jsonError("LOGO_UPLOAD_FAILED", 503);

    return Response.json({ success: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  };
}

async function withDependencies<T>(
  request: Request,
  context: RouteContext,
  handlerFactory: (deps: { getSession: () => Promise<Session | null>; getMembership: (input: { organizationId: string; userId: string }) => Promise<Membership | null>; download: GetHandlerDependencies["download"]; upload: PostHandlerDependencies["upload"] }) => (request: Request, context: RouteContext) => Promise<Response>,
): Promise<Response> {
  // Corrección ronda 1: createSupabaseServerClient() puede fallar si la
  // configuración de Supabase falta — sin este try/catch, eso era una
  // excepción sin manejar en vez de un 503, igual que
  // profile/route.ts:326-341 (withRouteDependencies) ya hace.
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return jsonError("LOGO_INTEGRATION_NOT_CONFIGURED", 503);
  }
  const deps = {
    getSession: async () => {
      const { data: { user }, error } = await supabase.auth.getUser();
      return error || !user ? null : { userId: user.id };
    },
    getMembership: async ({ organizationId, userId }: { organizationId: string; userId: string }) => {
      const { data, error } = await supabase.from("organization_members").select("role").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
      // Corrección ronda 1: un error real de la consulta ya NO se trata
      // igual que "no hay membership" — se relanza para que
      // resolveAuthAndMembership lo mapee a 503, no a 404.
      if (error) throw error;
      if (!data) return null;
      return { role: data.role as OrganizationRole };
    },
    download: (path: string) => supabase.storage.from("organization-logos").download(path),
    upload: (path: string, body: ArrayBuffer, options: { upsert: boolean; contentType: string }) => supabase.storage.from("organization-logos").upload(path, body, options),
  };
  // Corrección ronda 3 del plan review (bug real): el `return` anterior
  // no tenía `await` ni try/catch propio — el try/catch de arriba solo
  // cubre `createSupabaseServerClient()`. Un rechazo inesperado dentro
  // del handler (p. ej. `download`/`upload`/`file.arrayBuffer()` o
  // `context.params` lanzando algo que ninguna rama ya mapeada
  // contempla) escapaba como una excepción sin manejar en vez de un 503
  // limpio. Envolver también esta llamada cierra ese hueco como red de
  // seguridad final.
  try {
    return await handlerFactory(deps)(request, context);
  } catch {
    return jsonError("LOGO_LOOKUP_FAILED", 503);
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return withDependencies(request, context, createOrganizationLogoGetHandler);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withDependencies(request, context, createOrganizationLogoPostHandler);
}
```

(Ajusta los nombres exactos de dependencias inyectadas para que coincidan con el patrón real de `profile/route.ts` — ese archivo es la referencia de estilo, no copies literalmente lo de arriba si el patrón real difiere en algún detalle menor. `createSupabaseServerClient` — confirma el import correcto contra `profile/route.ts:17`.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/api/organization-logo.test.ts`
Expected: PASS, los 11 tests (9 originales + 2 agregados en la corrección de ronda 1: MIME falsamente declarado, y membership que lanza).

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint app/api/organizations/\[id\]/logo/route.ts tests/api/organization-logo.test.ts`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add "app/api/organizations/[id]/logo/route.ts" tests/api/organization-logo.test.ts
git commit -m "feat: add same-origin logo proxy API route"
```

---

### Task 5: `components/layout/app-icon.tsx` — ícono `image`

**Files:**
- Modify: `components/layout/app-icon.tsx`

No existe un archivo de test dedicado para `app-icon.tsx` — se verifica indirectamente en la Task 6 (`app-shell.test.tsx`).

- [ ] **Step 1: Agregar `"image"` a `IconName`**

En `components/layout/app-icon.tsx`, la línea actual es:

```typescript
type IconName = "home" | "campaigns" | "plus" | "review" | "results" | "chevron" | "spark" | "menu" | "close" | "arrow" | "check";
```

Cámbiala a:

```typescript
type IconName = "home" | "campaigns" | "plus" | "review" | "results" | "chevron" | "spark" | "menu" | "close" | "arrow" | "check" | "image";
```

- [ ] **Step 2: Agregar el path (dentro del record `paths`, un marco simple con sol/montaña, mismo estilo `stroke`)**

```typescript
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5-11 11" /></>,
```

- [ ] **Step 3: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: limpio.

- [ ] **Step 4: Commit**

```bash
git add components/layout/app-icon.tsx
git commit -m "feat: add image icon"
```

---

### Task 6: `components/layout/app-shell.tsx` — portar el fix de layout + agregar nav de Logo Studio

**Files:**
- Modify: `components/layout/app-shell.tsx`
- Test: `tests/components/app-shell.test.tsx` (nuevo — no existe hoy en esta rama)

**Contexto importante:** esta rama parte de `feat/personal-pilot-hardening`, así que `app-shell.tsx` aquí **no tiene** el fix de layout flex-column que la rama hermana `feat/ia-navigation-unification` ya aplicó (ese fix existe porque un 7º ítem de nav llegó a solapar visualmente el panel "Estado del sistema", posicionado `absolute`, a 768px de alto de viewport — verificación manual en navegador, no un test automatizado, encontró el bug). Agregar aquí el 7º ítem de nav (Logo Studio) sin portar primero ese fix reintroduciría el mismo bug. Este task hace ambas cosas en un solo archivo, en orden: primero el fix de layout, después el nuevo ítem de nav.

- [ ] **Step 1: Escribir los tests que fallan**

Crea `tests/components/app-shell.test.tsx` (revisa `tests/components/drafts-page.test.tsx` para el patrón de mock de `usePathname`/`next/link` de este proyecto, y adáptalo):

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/library" }));
vi.mock("@/lib/supabase/client", () => ({ hasSupabaseBrowserConfig: () => true }));
vi.mock("@/components/aias/organization-switcher", () => ({ OrganizationSwitcher: () => <div data-testid="global-switcher" /> }));

import { AppShell } from "@/components/layout/app-shell";

afterEach(() => cleanup());

describe("AppShell", () => {
  it("includes a Logo Studio link to /tools/logo-studio using the new image icon (not some other icon)", () => {
    render(<AppShell>content</AppShell>);
    const link = screen.getByRole("link", { name: /Logo Studio/i });
    expect(link).toHaveAttribute("href", "/tools/logo-studio");
    // Corrección ronda 1 (hallazgo real): el test anterior nunca verificaba
    // que el ícono fuera específicamente "image" — busca un fragmento del
    // path SVG único de ese ícono (ver Task 5, `cx="8.5" cy="8.5" r="1.5"`,
    // no compartido por ningún otro ícono existente) dentro del link.
    expect(link.innerHTML).toContain('cx="8.5"');
  });

  it("does not overlap the nav with the system-status panel (structural check — see Task 12 for real browser verification)", () => {
    render(<AppShell>content</AppShell>);
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });
    // Corrección ronda 1 (bug real, no cosmético): el fix aplica
    // flex-1/overflow-y-auto al <div> que ENVUELVE a <nav> (nav.parentElement),
    // no a <nav> mismo — <nav> conserva su propia clase original
    // ("space-y-1"). La versión anterior comprobaba nav.className, que
    // nunca contiene "flex-1" pase lo que pase — ese assert no podía pasar
    // ni con el fix bien aplicado.
    expect(nav.parentElement?.className).toMatch(/flex-1/);
    expect(nav.parentElement?.className).toMatch(/overflow-y-auto/);

    // El panel "Estado del sistema" ya no debe estar posicionado `absolute`
    // — se busca el <details> directamente (no es pariente de <nav> ni
    // antes ni después del fix, así que nav.parentElement nunca lo alcanza).
    const statusPanel = screen.getByText("Estado del sistema").closest("details");
    expect(statusPanel?.className).not.toMatch(/\babsolute\b/);
  });
});

describe("AppShell global organization switcher", () => {
  it("does not render the global switcher on /tools/logo-studio (the page renders its own)", async () => {
    vi.doMock("next/navigation", () => ({ usePathname: () => "/tools/logo-studio" }));
    vi.resetModules();
    const { AppShell: FreshAppShell } = await import("@/components/layout/app-shell");
    render(<FreshAppShell>content</FreshAppShell>);
    expect(screen.queryByTestId("global-switcher")).not.toBeInTheDocument();
  });
});
```

(El segundo `describe` usa `vi.doMock`/`vi.resetModules`/import dinámico para cambiar el mock de `usePathname` a mitad de archivo — si el runner de tests de este proyecto no soporta ese patrón con facilidad, sepáralo en su propio archivo de test con su propio `vi.mock` estático de nivel de módulo, más simple. Prioriza que el test sea correcto y legible sobre reusar un solo archivo.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/components/app-shell.test.tsx`
Expected: FAIL — ni el layout flex-column ni el link de Logo Studio existen todavía.

- [ ] **Step 3: Portar el fix de layout (primero)**

En `components/layout/app-shell.tsx`, el `<aside>` actual es:

```typescript
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-white/[0.08] bg-[#091735] px-6 py-7 lg:block">
        <Link href="/" className="group block" aria-label="Ir al inicio de SnapGad Content OS">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.28em] text-[#FF4D00]">SnapGad</p>
          <p className="mt-1 text-xl font-semibold tracking-[-0.03em] text-white group-hover:text-[#A8C7FF]">Content OS</p>
          <p className="mt-2 max-w-[13rem] text-xs leading-5 text-slate-500">Convierte creativos en campañas que puedes controlar.</p>
        </Link>

        <div className="mt-12 rounded-2xl border border-[#2C5ED8]/30 bg-[#12327A]/25 p-4">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-[#A8C7FF]">Workspace</p>
          <p className="mt-2 text-sm font-semibold text-white">SnapGad Technology</p>
          <p className="mt-1 text-xs text-slate-500">1 organización activa</p>
        </div>

        <div className="mt-7"><Navigation pathname={pathname} /></div>

        <details className="absolute inset-x-6 bottom-7 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-300">Estado del sistema</summary>
          <div className="mt-3 border-t border-white/10 pt-3">
            <RuntimeMode />
            <p className="mt-1 text-xs leading-5 text-slate-500">La publicación siempre requiere tu aprobación.</p>
          </div>
        </details>
      </aside>
```

Cámbialo a (idéntico al fix ya aplicado y verificado en `feat/ia-navigation-unification`):

```typescript
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r border-white/[0.08] bg-[#091735] px-6 py-7 lg:flex">
        <Link href="/" className="group block shrink-0" aria-label="Ir al inicio de SnapGad Content OS">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.28em] text-[#FF4D00]">SnapGad</p>
          <p className="mt-1 text-xl font-semibold tracking-[-0.03em] text-white group-hover:text-[#A8C7FF]">Content OS</p>
          <p className="mt-2 max-w-[13rem] text-xs leading-5 text-slate-500">Convierte creativos en campañas que puedes controlar.</p>
        </Link>

        <div className="mt-12 shrink-0 rounded-2xl border border-[#2C5ED8]/30 bg-[#12327A]/25 p-4">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-[#A8C7FF]">Workspace</p>
          <p className="mt-2 text-sm font-semibold text-white">SnapGad Technology</p>
          <p className="mt-1 text-xs text-slate-500">1 organización activa</p>
        </div>

        <div className="mt-7 min-h-0 flex-1 overflow-y-auto"><Navigation pathname={pathname} /></div>

        <details className="mt-4 shrink-0 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <summary className="cursor-pointer list-none text-xs font-semibold text-slate-300">Estado del sistema</summary>
          <div className="mt-3 border-t border-white/10 pt-3">
            <RuntimeMode />
            <p className="mt-1 text-xs leading-5 text-slate-500">La publicación siempre requiere tu aprobación.</p>
          </div>
        </details>
      </aside>
```

**Nota:** el texto "La publicación siempre requiere tu aprobación." se queda tal cual en esta rama — el fix de ese copy (contradice ADR-008) pertenece a la rama hermana de navegación, no a este spec/plan. No lo cambies aquí, sería scope creep.

- [ ] **Step 4: Agregar la 7ª entrada de nav y excluir el switcher global de Logo Studio**

El arreglo `navigation` actual:

```typescript
const navigation = [
  { href: "/", label: "Inicio", eyebrow: "Resumen", icon: "home" },
  { href: "/library", label: "Campañas", eyebrow: "Workspace", icon: "campaigns" },
  { href: "/library/new", label: "Nueva campaña", eyebrow: "Crear", icon: "plus" },
  { href: "/review", label: "Revisión", eyebrow: "Tu aprobación", icon: "review" },
  { href: "/history", label: "Resultados", eyebrow: "Aprendizaje", icon: "results" },
  { href: "/pilot", label: "Piloto", eyebrow: "Salida real", icon: "check" },
] satisfies Array<{ href: string; label: string; eyebrow: string; icon: IconName }>;
```

Agrega la 7ª entrada:

```typescript
const navigation = [
  { href: "/", label: "Inicio", eyebrow: "Resumen", icon: "home" },
  { href: "/library", label: "Campañas", eyebrow: "Workspace", icon: "campaigns" },
  { href: "/library/new", label: "Nueva campaña", eyebrow: "Crear", icon: "plus" },
  { href: "/review", label: "Revisión", eyebrow: "Tu aprobación", icon: "review" },
  { href: "/history", label: "Resultados", eyebrow: "Aprendizaje", icon: "results" },
  { href: "/pilot", label: "Piloto", eyebrow: "Salida real", icon: "check" },
  { href: "/tools/logo-studio", label: "Logo Studio", eyebrow: "Herramientas", icon: "image" },
] satisfies Array<{ href: string; label: string; eyebrow: string; icon: IconName }>;
```

Y la condición que renderiza el switcher global (dentro de `<main>`), actualmente:

```typescript
          {hasSupabaseBrowserConfig() &&
          pathname !== "/onboarding" &&
          !pathname.startsWith("/onboarding/") &&
          !pathname.startsWith("/settings/organizations") ? (
```

Cámbiala a:

```typescript
          {hasSupabaseBrowserConfig() &&
          pathname !== "/onboarding" &&
          !pathname.startsWith("/onboarding/") &&
          !pathname.startsWith("/settings/organizations") &&
          !pathname.startsWith("/tools/logo-studio") ? (
```

- [ ] **Step 5: Confirmar que pasa**

Run: `npm test -- tests/components/app-shell.test.tsx`
Expected: PASS.

- [ ] **Step 6: `tsc`, lint, build**

Run: `npx tsc --noEmit && npx eslint components/layout/app-shell.tsx tests/components/app-shell.test.tsx && npm run build`
Expected: limpio. `npm run build` es la verificación real de que Next compila el layout nuevo sin errores — no te saltes este paso.

- [ ] **Step 7: Commit**

```bash
git add components/layout/app-shell.tsx tests/components/app-shell.test.tsx
git commit -m "feat: port sidebar layout fix and add Logo Studio nav entry"
```

---

### Task 7: `components/logo-studio/logo-upload-panel.tsx`

**Files:**
- Create: `components/logo-studio/logo-upload-panel.tsx`
- Test: `components/logo-studio/logo-upload-panel.test.tsx`
- Modify: `package.json` (agrega `@testing-library/user-event` a `devDependencies`)

**Corrección tras revisión de Codex CLI ronda 1 (hallazgo real y
significativo, no cosmético):** este task es el primero del plan que usa
`userEvent` de `@testing-library/user-event` — verificado que **no está
declarado** en `package.json` ni en `package-lock.json`; está presente
en `node_modules` solo como `extraneous` (`npm ls @testing-library/user-event`
lo confirma), es decir, quedó instalado manualmente en algún momento
fuera del árbol de dependencias declarado. Un `npm ci` limpio (el que
usaría CI o un checkout nuevo) **no lo instalaría**, y todos los tests
de este plan que usan `userEvent` fallarían por un import que no
resuelve. Se instala aquí como dependencia real antes de escribir el
primer test que la usa:

```bash
npm install --save-dev @testing-library/user-event
```

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LogoUploadPanel } from "@/components/logo-studio/logo-upload-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogoUploadPanel", () => {
  it("shows an empty state when the logo image fails to load (404)", () => {
    render(<LogoUploadPanel organizationId="org-1" />);
    const img = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(screen.getByText(/todavía no subiste un logo/i)).toBeInTheDocument();
  });

  it("rejects a non-PNG file client-side without calling the API", async () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<LogoUploadPanel organizationId="org-1" />);
    const input = screen.getByLabelText(/subir logo/i) as HTMLInputElement;
    const jpegFile = new File(["fake"], "logo.jpg", { type: "image/jpeg" });
    // Corrección ronda 2 del plan review (Issue 5 seguía roto): en
    // @testing-library/user-event@14.6.7, `applyAccept` NO es una opción
    // del método de instancia `.upload(element, file, options)` — es una
    // opción de `userEvent.setup({ applyAccept: false })`. Pasarla como
    // tercer argumento de `.upload()` no tiene efecto y el archivo se
    // sigue filtrando por el atributo `accept="image/png"` del input
    // antes de disparar el evento cambio.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, jpegFile);
    expect(screen.getByText(/debe ser un png/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads a PNG and refreshes the image with a cache-busting param on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })));
    const user = userEvent.setup();
    render(<LogoUploadPanel organizationId="org-1" />);
    const input = screen.getByLabelText(/subir logo/i);
    const pngFile = new File(["fake"], "logo.png", { type: "image/png" });
    await user.upload(input, pngFile);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/organizations/org-1/logo", expect.objectContaining({ method: "POST" })));
    const img = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
    expect(img.src).toMatch(/\/api\/organizations\/org-1\/logo\?t=\d+/);
  });

  it("calls onUploadSuccess after a successful upload, so a parent page can refresh anything else that shows the logo (hallazgo ronda 1 del plan review — ver Task 11)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })));
    const onUploadSuccess = vi.fn();
    const user = userEvent.setup();
    render(<LogoUploadPanel organizationId="org-1" onUploadSuccess={onUploadSuccess} />);
    const input = screen.getByLabelText(/subir logo/i);
    await user.upload(input, new File(["fake"], "logo.png", { type: "image/png" }));

    await waitFor(() => expect(onUploadSuccess).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- components/logo-studio/logo-upload-panel.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
"use client";

import { useState } from "react";

export function LogoUploadPanel({
  organizationId,
  onUploadSuccess,
}: {
  organizationId: string;
  // Corrección ronda 1 (gap real): sin esto, CompositePreview (Task 10) y
  // el <img> de este panel podían mostrar dos versiones distintas del
  // logo tras un reemplazo — el panel refresca su propio <img> con un
  // cache-bust interno, pero nada le avisaba al resto de la página. Ver
  // Task 11, donde el page usa este callback para su propio cache-bust
  // compartido con CompositePreview.
  onUploadSuccess?: () => void;
}) {
  const [hasLogo, setHasLogo] = useState(true); // optimista; onError lo corrige
  const [cacheBust, setCacheBust] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png") {
      setError("El logo debe ser un PNG con fondo transparente.");
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.set("logo", file);
      const response = await fetch(`/api/organizations/${organizationId}/logo`, { method: "POST", body: formData });
      if (!response.ok) throw new Error("UPLOAD_FAILED");
      setHasLogo(true);
      setCacheBust(Date.now());
      onUploadSuccess?.();
    } catch {
      setError("No se pudo subir el logo. Inténtalo de nuevo.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div>
      {hasLogo ? (
        <img
          src={`/api/organizations/${organizationId}/logo${cacheBust ? `?t=${cacheBust}` : ""}`}
          alt="Logo de la organización"
          onError={() => setHasLogo(false)}
        />
      ) : (
        <p>Todavía no subiste un logo.</p>
      )}
      <label htmlFor="logo-upload-input">Subir logo</label>
      <input id="logo-upload-input" type="file" accept="image/png" onChange={handleFileChange} disabled={isUploading} />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
```

(Este es el esqueleto funcional mínimo — mejora el markup/estilos para que coincida con el resto de la app durante la implementación real, usando las clases de Tailwind que ya usan componentes vecinos como `asset-dropzone.tsx`, sin cambiar la lógica de arriba.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- components/logo-studio/logo-upload-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint components/logo-studio/logo-upload-panel.tsx components/logo-studio/logo-upload-panel.test.tsx`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json components/logo-studio/logo-upload-panel.tsx components/logo-studio/logo-upload-panel.test.tsx
git commit -m "feat: add logo upload panel"
```

---

### Task 8: `components/logo-studio/creative-batch-dropzone.tsx`

**Files:**
- Create: `components/logo-studio/creative-batch-dropzone.tsx`
- Test: `components/logo-studio/creative-batch-dropzone.test.tsx`

**Decisión del spec, no la reviertas:** usa `react-dropzone` (ya en `package.json`, sin uso hoy) en vez de extender el patrón hecho-a-mano de `components/content/asset-dropzone.tsx`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreativeBatchDropzone, MAX_BATCH_SIZE, MAX_FILE_BYTES } from "@/components/logo-studio/creative-batch-dropzone";

afterEach(() => cleanup());

describe("CreativeBatchDropzone", () => {
  it("accepts multiple valid image files", async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    await user.upload(input, [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.jpg", { type: "image/jpeg" }),
    ]);
    expect(onFilesChange).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: "a.png" }), expect.objectContaining({ name: "b.jpg" })]));
  });

  it("rejects a file with an unsupported type", async () => {
    const onFilesChange = vi.fn();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    // Corrección ronda 2 del plan review (mismo hallazgo que Task 7):
    // `applyAccept` va en `userEvent.setup(...)`, no como tercer
    // argumento de `.upload()` — ahí no tiene efecto en
    // @testing-library/user-event@14.6.7.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input, new File(["a"], "a.pdf", { type: "application/pdf" }));
    expect(screen.getByText(/tipo de archivo no soportado/i)).toBeInTheDocument();
  });

  it(`rejects a batch larger than MAX_BATCH_SIZE (${MAX_BATCH_SIZE}) with its own distinct message`, async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) => new File(["a"], `${index}.png`, { type: "image/png" }));
    await user.upload(input, tooMany);
    // Corrección ronda 1 (bug real): con `maxFiles` configurado,
    // react-dropzone ya mete los archivos sobrantes en `fileRejections`
    // con code "too-many-files" — `acceptedFiles.length` nunca puede
    // superar MAX_BATCH_SIZE por sí solo. El mensaje debe distinguirse del
    // genérico "tipo no soportado" de la prueba anterior.
    expect(screen.getByText(new RegExp(`máximo ${MAX_BATCH_SIZE}`, "i"))).toBeInTheDocument();
    expect(screen.queryByText(/tipo de archivo no soportado/i)).not.toBeInTheDocument();
  });

  it(`rejects an individual file larger than MAX_FILE_BYTES`, async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    const bigFile = new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.png", { type: "image/png" });
    await user.upload(input, bigFile);
    expect(screen.getByText(/demasiado grande/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- components/logo-studio/creative-batch-dropzone.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

export const MAX_BATCH_SIZE = 30;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function CreativeBatchDropzone({ onFilesChange }: { onFilesChange: (files: File[]) => void }) {
  const [error, setError] = useState<string | null>(null);

  // Corrección ronda 1 (bug real): con `maxFiles` configurado abajo,
  // react-dropzone YA pone los archivos sobrantes en `fileRejections`
  // (code "too-many-files") — nunca llegan a `acceptedFiles`, así que la
  // rama vieja `acceptedFiles.length > MAX_BATCH_SIZE` era código muerto,
  // jamás se ejecutaba. Distingue el motivo del rechazo por su `code` en
  // vez de asumirlo por longitud (verifica el string exacto de
  // ErrorCode.TooManyFiles contra la versión instalada de react-dropzone,
  // 20.1.2, al implementar).
  const onDrop = useCallback((acceptedFiles: File[], fileRejections: { file: File; errors: { code: string }[] }[]) => {
    const hasTooManyFiles = fileRejections.some((rejection) => rejection.errors.some((error) => error.code === "too-many-files"));
    const hasOtherRejection = fileRejections.some((rejection) => rejection.errors.some((error) => error.code !== "too-many-files"));

    if (hasTooManyFiles) {
      setError(`Máximo ${MAX_BATCH_SIZE} creativos por lote.`);
    } else if (hasOtherRejection) {
      setError("Hay archivos con tipo de archivo no soportado o demasiado grande — solo se aceptan .png/.jpg/.jpeg/.webp hasta 10 MB cada uno.");
    } else {
      setError(null);
    }
    onFilesChange(acceptedFiles);
  }, [onFilesChange]);

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    multiple: true,
    maxFiles: MAX_BATCH_SIZE,
    maxSize: MAX_FILE_BYTES,
    accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] },
  });

  return (
    <div {...getRootProps()}>
      <input {...getInputProps()} aria-label="Cargar creativos" />
      <p>Arrastra tus creativos aquí, o haz click para elegir archivos.</p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- components/logo-studio/creative-batch-dropzone.test.tsx`
Expected: PASS.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint components/logo-studio/creative-batch-dropzone.tsx components/logo-studio/creative-batch-dropzone.test.tsx`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add components/logo-studio/creative-batch-dropzone.tsx components/logo-studio/creative-batch-dropzone.test.tsx
git commit -m "feat: add multi-file creative batch dropzone using react-dropzone"
```

---

### Task 9: `components/logo-studio/composite-controls.tsx`

**Files:**
- Create: `components/logo-studio/composite-controls.tsx`
- Test: `components/logo-studio/composite-controls.test.tsx`

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositeControls } from "@/components/logo-studio/composite-controls";

afterEach(() => cleanup());

describe("CompositeControls", () => {
  it("defaults to bottom-right, 15% size, 4% margin", () => {
    render(<CompositeControls value={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /inferior derecha/i })).toBeChecked();
    expect(screen.getByLabelText(/tamaño/i)).toHaveValue("15");
    expect(screen.getByLabelText(/margen/i)).toHaveValue("4");
  });

  it("calls onChange with the selected corner", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<CompositeControls value={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /superior izquierda/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ corner: "top-left" }));
  });

  it("clamps the size slider to the 5-40 range", () => {
    render(<CompositeControls value={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} onChange={vi.fn()} />);
    const slider = screen.getByLabelText(/tamaño/i);
    expect(slider).toHaveAttribute("min", "5");
    expect(slider).toHaveAttribute("max", "40");
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- components/logo-studio/composite-controls.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
"use client";

import type { CompositeOptions, Corner } from "@/lib/logo-studio/compose";

const CORNER_LABELS: Record<Corner, string> = {
  "top-left": "Superior izquierda",
  "top-right": "Superior derecha",
  "bottom-left": "Inferior izquierda",
  "bottom-right": "Inferior derecha",
};

export function CompositeControls({ value, onChange }: { value: CompositeOptions; onChange: (next: CompositeOptions) => void }) {
  return (
    <fieldset>
      <legend>Posición del logo</legend>
      {(Object.keys(CORNER_LABELS) as Corner[]).map((corner) => (
        <label key={corner}>
          <input
            type="radio"
            name="corner"
            checked={value.corner === corner}
            onChange={() => onChange({ ...value, corner })}
          />
          {CORNER_LABELS[corner]}
        </label>
      ))}
      <label htmlFor="size-percent">Tamaño
        <input id="size-percent" type="range" min={5} max={40} value={value.sizePercent} onChange={(event) => onChange({ ...value, sizePercent: Number(event.target.value) })} />
      </label>
      <label htmlFor="margin-percent">Margen
        <input id="margin-percent" type="range" min={0} max={10} value={value.marginPercent} onChange={(event) => onChange({ ...value, marginPercent: Number(event.target.value) })} />
      </label>
    </fieldset>
  );
}
```

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- components/logo-studio/composite-controls.test.tsx`
Expected: PASS.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint components/logo-studio/composite-controls.tsx components/logo-studio/composite-controls.test.tsx`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add components/logo-studio/composite-controls.tsx components/logo-studio/composite-controls.test.tsx
git commit -m "feat: add corner/size/margin composite controls"
```

---

### Task 10: `components/logo-studio/composite-preview.tsx`

**Files:**
- Create: `components/logo-studio/composite-preview.tsx`
- Test: `components/logo-studio/composite-preview.test.tsx`

**Corrección tras revisión de Codex CLI ronda 1 (gap real, no una
simplificación aceptable):** la versión anterior de este task cubría
solo el estado vacío (`creativeFile={null}`), evitando por completo el
camino real de orquestación (`new Image()` + `onload`/`onerror` +
`compositeToBlob` + limpieza de `blob:` URLs) — y con razón aparente,
porque en jsdom 29.1.1 asignar `.src` a un `new Image()` real **no
dispara `onload` ni `onerror` nunca**, así que un test que esperara eso
se quedaría colgado. Pero eso deja sin probar exactamente la lógica más
delicada del componente: si en el navegador real la carga del logo
falla (por ejemplo, el proxy same-origin de Task 4 responde `404`
porque la organización no tiene logo todavía), la versión anterior de
la implementación entra en un estado en el que `previewUrl` nunca se
asigna y el componente se queda mostrando "Generando preview…" para
siempre — un cuelgue silencioso real. La solución no es evitar probar
esto, es **mockear el constructor global `Image`** para controlar
cuándo/cómo se resuelve la carga, y agregar un estado de error explícito
a la implementación (que la versión anterior tampoco tenía).

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logo-studio/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-studio/compose")>();
  return { ...actual, compositeToBlob: vi.fn().mockResolvedValue(new Blob(["fake"], { type: "image/png" })) };
});

import { CompositePreview } from "@/components/logo-studio/composite-preview";
import { compositeToBlob } from "@/lib/logo-studio/compose";

// jsdom no dispara onload/onerror al asignar Image.src — se sustituye el
// constructor global por uno controlable: cualquier src que contenga
// "fail" dispara onerror, el resto dispara onload en el siguiente microtask.
class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  naturalWidth = 1080;
  naturalHeight = 1350;
  #src = "";
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => {
      if (value.includes("fail")) this.onerror?.(new Event("error"));
      else this.onload?.();
    });
  }
  get src() { return this.#src; }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CompositePreview", () => {
  it("shows a placeholder when there's no creative selected yet", () => {
    render(<CompositePreview creativeFile={null} logoImageUrl="/api/organizations/org-1/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    expect(screen.getByText(/carga al menos un creativo/i)).toBeInTheDocument();
  });

  it("renders the composited preview once both images 'load' successfully", async () => {
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:fake"), revokeObjectURL: vi.fn() });
    const file = new File(["a"], "a.png", { type: "image/png" });

    render(<CompositePreview creativeFile={file} logoImageUrl="/api/organizations/org-1/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);

    expect(screen.getByText(/generando preview/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument());
    expect(compositeToBlob).toHaveBeenCalled();
  });

  it("shows a visible error instead of hanging on 'Generando preview…' forever when the logo image fails to load", async () => {
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:fake"), revokeObjectURL: vi.fn() });
    const file = new File(["a"], "a.png", { type: "image/png" });

    render(<CompositePreview creativeFile={file} logoImageUrl="/api/organizations/org-1/logo-fail" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText(/generando preview/i)).not.toBeInTheDocument();
  });

  it("revokes the previous preview's object URL when a new creative replaces it, and on unmount", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:fake"), revokeObjectURL });
    const fileA = new File(["a"], "a.png", { type: "image/png" });
    const fileB = new File(["b"], "b.png", { type: "image/png" });

    const { rerender, unmount } = render(<CompositePreview creativeFile={fileA} logoImageUrl="/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument());

    rerender(<CompositePreview creativeFile={fileB} logoImageUrl="/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: /preview/i })).toBeInTheDocument());

    // Corrección ronda 2 del plan review (Issue 7 — test no hermético):
    // para el reemplazo de fileA por fileB ya ocurrieron 2 revocaciones
    // (la URL intermedia del creativo de fileA, y la del preview
    // compuesto anterior) — comprobar `>= 2` DESPUÉS de desmontar no
    // probaba que el cleanup de unmount específicamente corriera, porque
    // ya se cumplía antes de llamar unmount(). Se captura el conteo justo
    // antes de desmontar y se exige que aumente en exactamente 1 —
    // la única revocación que puede venir del cleanup de unmount.
    const callsBeforeUnmount = revokeObjectURL.mock.calls.length;
    unmount();
    expect(revokeObjectURL.mock.calls.length).toBe(callsBeforeUnmount + 1);
  });
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- components/logo-studio/composite-preview.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar (con estado de error explícito y limpieza en unmount — corrección de la versión anterior)**

```typescript
"use client";

import { useEffect, useRef, useState } from "react";

import { compositeToBlob, type CompositeOptions } from "@/lib/logo-studio/compose";

export function CompositePreview({
  creativeFile,
  logoImageUrl,
  options,
}: {
  creativeFile: File | null;
  logoImageUrl: string;
  options: CompositeOptions;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!creativeFile) {
      setPreviewUrl(null);
      setHasError(false);
      return;
    }
    let cancelled = false;
    setHasError(false);
    // Corrección ronda 2 del plan review: limpia el preview anterior de
    // inmediato al empezar una carga nueva — antes se quedaba mostrando
    // la imagen VIEJA mientras la nueva componía, en vez de pasar a
    // "Generando preview…" de una vez.
    setPreviewUrl(null);

    async function render() {
      const creativeImage = new Image();
      const logoImage = new Image();
      const creativeUrl = URL.createObjectURL(creativeFile!);
      try {
        await Promise.all([
          new Promise<void>((resolve, reject) => { creativeImage.onload = () => resolve(); creativeImage.onerror = reject; creativeImage.src = creativeUrl; }),
          new Promise<void>((resolve, reject) => { logoImage.onload = () => resolve(); logoImage.onerror = reject; logoImage.src = logoImageUrl; }),
        ]);
      } finally {
        // Corrección ronda 2 (fuga real de recursos): revocar SIEMPRE,
        // incluso si una de las dos cargas falla — la versión anterior
        // solo revocaba en el camino feliz, dejando el blob: URL vivo si
        // el logo (o el creativo) fallaba al cargar.
        URL.revokeObjectURL(creativeUrl);
      }
      if (cancelled) return;

      const blob = await compositeToBlob(creativeImage, logoImage, options, "image/png");
      if (cancelled) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPreviewUrl(url);
    }

    render().catch(() => {
      if (cancelled) return;
      setPreviewUrl(null);
      setHasError(true);
    });

    return () => {
      cancelled = true;
    };
  }, [creativeFile, logoImageUrl, options]);

  // Limpieza en unmount — la versión anterior solo revocaba la URL previa
  // cuando una NUEVA llegaba, nunca al desmontar el componente.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  if (!creativeFile) return <p>Carga al menos un creativo para ver el preview.</p>;
  if (hasError) return <p role="alert">No se pudo generar el preview. Verifica que el creativo sea una imagen válida.</p>;
  return previewUrl ? <img src={previewUrl} alt="Preview del composite" /> : <p>Generando preview…</p>;
}
```

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- components/logo-studio/composite-preview.test.tsx`
Expected: PASS, los 4 tests.

- [ ] **Step 5: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint components/logo-studio/composite-preview.tsx components/logo-studio/composite-preview.test.tsx`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add components/logo-studio/composite-preview.tsx components/logo-studio/composite-preview.test.tsx
git commit -m "feat: add live composite preview"
```

---

### Task 11: `app/(app)/tools/logo-studio/page.tsx` — integración final

**Files:**
- Create: `app/(app)/tools/logo-studio/page.tsx`
- Test: `tests/components/logo-studio-page.test.tsx`

**Antes de escribir código, lee `app/(app)/settings/organizations/page.tsx` completo** — esta página nueva resuelve `activeOrganizationId` exactamente con el mismo patrón (fetch propio de `GET /api/organizations` vía un `loadOrganizations()` que verifica `response.ok` y valida con `parseOrganizationsResponse`, estado local, su propia instancia de `OrganizationSwitcher` con `onOrganizationChange`), no un mecanismo nuevo.

**Corrección tras revisión de Codex CLI ronda 1 — cuatro hallazgos reales
en este task, ninguno cosmético:**
1. El fetch anterior no comprobaba `response.ok` ni usaba
   `parseOrganizationsResponse` — una respuesta `401`/`403` real (sesión
   expirada, por ejemplo) habría dejado `organizations`/`activeOrganizationId`
   en un estado no validado, rompiendo `organizations.length` u otra
   lectura downstream.
2. `LogoUploadPanel` no reseteaba su estado `hasLogo` al cambiar de
   organización — mostraría el logo (o la ausencia de logo) de la
   organización ANTERIOR hasta que el nuevo `<img>` disparara su propio
   `onError`. Se soluciona con `key={activeOrganizationId}` en el uso de
   `<LogoUploadPanel>` — fuerza un remount completo del componente al
   cambiar de organización, sin tocar su implementación interna (Task 7).
3. `CompositePreview` y `LogoUploadPanel` no compartían ningún mecanismo
   de cache-busting — tras reemplazar el logo, el preview en vivo podía
   seguir usando la versión cacheada anterior. Se soluciona levantando un
   contador de cache-bust a este nivel, incrementado vía el
   `onUploadSuccess` que Task 7 ya expone.
4. `handleExport` usaba `Promise.all`, que aborta TODO el export si un
   solo creativo falla al cargar como imagen — contradice el manejo de
   errores de la spec ("un archivo corrupto... se omite... sin abortar el
   resto del lote") y el patrón ya establecido en la rama de navegación
   (`useAttentionTargets`, aislamiento de errores por id vía
   `Promise.allSettled`). Se corrige de la misma forma aquí.

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logo-studio/export-zip", () => ({
  buildLogoStudioZip: vi.fn().mockResolvedValue(new Blob(["zip"])),
  downloadZip: vi.fn(),
}));
vi.mock("@/lib/logo-studio/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-studio/compose")>();
  return { ...actual, compositeToBlob: vi.fn().mockResolvedValue(new Blob(["fake"])) };
});

import LogoStudioPage from "@/app/(app)/tools/logo-studio/page";
import { buildLogoStudioZip } from "@/lib/logo-studio/export-zip";
import { compositeToBlob } from "@/lib/logo-studio/compose";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  naturalWidth = 1080;
  naturalHeight = 1350;
  #src = "";
  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => {
      if (value.includes("corrupt")) this.onerror?.(new Event("error"));
      else this.onload?.();
    });
  }
  get src() { return this.#src; }
}

function organizationsResponse() {
  return new Response(JSON.stringify({
    organizations: [
      { id: "org-1", name: "SnapGad", role: "owner" },
      { id: "org-2", name: "Otra organización", role: "owner" },
    ],
    activeOrganizationId: "org-1",
  }), { status: 200 });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogoStudioPage", () => {
  it("resolves the active organization from GET /api/organizations using response.ok + parseOrganizationsResponse, same as settings/organizations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(organizationsResponse()));
    render(<LogoStudioPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/organizations", expect.anything()));
    expect(await screen.findByText(/SnapGad/i)).toBeInTheDocument();
  });

  it("shows an error instead of crashing when GET /api/organizations responds with a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "AUTHENTICATION_REQUIRED" }), { status: 401 })));
    render(<LogoStudioPage />);
    await waitFor(() => expect(screen.getByText(/no se pudieron cargar tus organizaciones/i)).toBeInTheDocument());
  });

  it("remounts the logo panel (and its stale hasLogo state) when the active organization changes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(organizationsResponse()));
    const user = userEvent.setup();
    render(<LogoStudioPage />);
    await screen.findByText(/SnapGad/i);

    const img1 = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
    expect(img1.src).toContain("/api/organizations/org-1/logo");

    // Corrección ronda 2 del plan review (Issue 8 — test efectivamente
    // vacío): asignar `.value` directamente no dispara `onChange` en un
    // <select> controlado de React — `userEvent.selectOptions` sí dispara
    // el evento real que OrganizationSwitcher escucha.
    await user.selectOptions(screen.getByLabelText("Organización activa"), "org-2");

    await waitFor(() => {
      const img2 = screen.getByRole("img", { name: /logo/i, hidden: true }) as HTMLImageElement;
      expect(img2.src).toContain("/api/organizations/org-2/logo");
      expect(img2.src).not.toContain("org-1");
    });
  });

  it("exports successfully composited creatives even when one fails to load, instead of aborting the whole ZIP (Promise.allSettled, not Promise.all)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(organizationsResponse()));
    vi.stubGlobal("Image", FakeImage);
    // Corrección ronda 2 del plan review (Issue 8 — el mock anterior no
    // podía funcionar): createObjectURL devolvía siempre el mismo string
    // "blob:fake" sin importar el archivo, así que FakeImage nunca podía
    // distinguir cuál era "corrupt". Aquí la URL incluye el nombre del
    // archivo, que es justo lo que FakeImage.src revisa.
    const createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const user = userEvent.setup();
    render(<LogoStudioPage />);
    await screen.findByText(/SnapGad/i);

    const goodFile = new File(["a"], "good.png", { type: "image/png" });
    const corruptFile = new File(["b"], "corrupt.png", { type: "image/png" });
    await user.upload(screen.getByLabelText(/cargar creativos/i), [goodFile, corruptFile]);
    await user.click(screen.getByRole("button", { name: /exportar/i }));

    await waitFor(() => expect(buildLogoStudioZip).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ originalFilename: "good.png" })]),
    ));
    expect(buildLogoStudioZip).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ originalFilename: "corrupt.png" })]),
    );
    // Error visible, no silencioso — contradiría el manejo de errores de la spec.
    expect(await screen.findByText(/no se pudo procesar/i)).toHaveTextContent("corrupt.png");
  });

  it("shows a visible error (not a silent rejected promise) when the logo itself fails to load during export", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(organizationsResponse()));
    // Corrección ronda 3 del plan review (Issue 6 seguía roto — el
    // comentario anterior decía "ajusta después" sin ajustar nada):
    // logoImageUrl es una ruta real (`/api/organizations/org-1/logo`),
    // nunca contiene "corrupt", así que el `FakeImage` compartido nunca
    // habría fallado para el logo. Un contador de orden de instancias
    // tampoco sirve aquí: CompositePreview (Task 10) crea sus propias
    // instancias de Image de forma independiente y puede adelantarse a
    // handleExport. La señal confiable es estructural: los creativos
    // siempre cargan desde un `blob:` URL (ver createObjectURL abajo); el
    // logo carga directamente desde la ruta del proxy, nunca un `blob:`
    // URL — se distingue por eso, no por contenido de texto ni orden.
    class LogoFailsFakeImage {
      onload: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      naturalWidth = 1080;
      naturalHeight = 1350;
      #src = "";
      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => {
          if (!value.startsWith("blob:")) this.onerror?.(new Event("error"));
          else this.onload?.();
        });
      }
      get src() { return this.#src; }
    }
    vi.stubGlobal("Image", LogoFailsFakeImage);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn((file: File) => `blob:${file.name}`), revokeObjectURL: vi.fn() });
    const user = userEvent.setup();
    render(<LogoStudioPage />);
    await screen.findByText(/SnapGad/i);

    await user.upload(screen.getByLabelText(/cargar creativos/i), new File(["a"], "good.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: /exportar/i }));

    // Corrección ronda 2 del plan review (bug real, Issue nuevo): el botón
    // llama `() => void handleExport()` — sin un try/catch de nivel
    // superior en handleExport, un rechazo aquí (falla del logo, o de
    // buildLogoStudioZip) desaparece en silencio, sin ningún mensaje
    // visible. Debe aparecer un error, no un cuelgue silencioso.
    //
    // Corrección ronda 3 (bug real: posibles múltiples role="alert"):
    // CompositePreview también recibe el mismo logoImageUrl y fallará su
    // propia carga de forma independiente, mostrando SU PROPIO alert —
    // correcto, no es un bug, son dos componentes reportando el mismo
    // problema real por separado. Por eso se busca por el TEXTO
    // específico del mensaje de handleExport, no por
    // getByRole("alert") (singular, lanzaría con más de un match).
    expect(await screen.findByText(/no se pudo generar el zip/i)).toBeInTheDocument();
  });
});
```

(El mecanismo de arriba (`LogoFailsFakeImage`, distinción por `blob:`
vs. ruta real) es la implementación final para forzar el fallo del
logo, no un placeholder pendiente de completar — no dejes esto
comentado ni a medias en el commit final. Lo que no debe cambiar es la
aserción final: cualquier fallo no capturado dentro de `handleExport`
debe terminar en un mensaje visible, nunca en una promesa rechazada sin
manejar.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/components/logo-studio-page.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

Estructura mínima — junta todos los componentes de las Tasks 5-10:

```typescript
"use client";

import { useEffect, useMemo, useState } from "react";

import { OrganizationSwitcher, parseOrganizationsResponse, type OrganizationOption } from "@/components/aias/organization-switcher";
import { CompositeControls } from "@/components/logo-studio/composite-controls";
import { CompositePreview } from "@/components/logo-studio/composite-preview";
import { CreativeBatchDropzone } from "@/components/logo-studio/creative-batch-dropzone";
import { LogoUploadPanel } from "@/components/logo-studio/logo-upload-panel";
import { compositeToBlob, type CompositeOptions, type OutputFormat } from "@/lib/logo-studio/compose";
import { buildLogoStudioZip, downloadZip } from "@/lib/logo-studio/export-zip";

// Mismo patrón que settings/organizations/page.tsx:26-32 — corrección
// ronda 1: la versión anterior llamaba fetch().then(r => r.json()) sin
// comprobar response.ok ni validar la forma de la respuesta.
async function loadOrganizations(): Promise<{ organizations: OrganizationOption[]; activeOrganizationId: string | null }> {
  const response = await fetch("/api/organizations", { cache: "no-store" });
  if (!response.ok) throw new Error("ORGANIZATION_LOOKUP_FAILED");
  const payload = parseOrganizationsResponse(await response.json());
  if (!payload) throw new Error("INVALID_ORGANIZATIONS_RESPONSE");
  return payload;
}

type ExportFailure = { filename: string };

export default function LogoStudioPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creativeFiles, setCreativeFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<CompositeOptions>({ corner: "bottom-right", sizePercent: 15, marginPercent: 4 });
  const [isExporting, setIsExporting] = useState(false);
  const [exportFailures, setExportFailures] = useState<ExportFailure[]>([]);
  // Corrección ronda 2 (recomendación aplicada): error de nivel superior,
  // distinto de exportFailures (que es por creativo) — cubre fallos que
  // no son culpa de ningún archivo individual (el logo mismo no carga, o
  // buildLogoStudioZip falla).
  const [topLevelExportError, setTopLevelExportError] = useState<string | null>(null);
  // Corrección ronda 1: contador de cache-bust compartido — se incrementa
  // vía LogoUploadPanel.onUploadSuccess (Task 7) para que CompositePreview
  // (Task 10) también deje de usar la versión cacheada del logo anterior.
  // Corrección ronda 2 (recomendación aplicada): contador monotónico en
  // vez de Date.now() — evita, aunque sea de forma remota, dos subidas en
  // el mismo milisegundo produciendo el mismo valor de cache-bust.
  const [logoCacheBust, setLogoCacheBust] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadOrganizations()
      .then((payload) => {
        if (cancelled) return;
        setOrganizations(payload.organizations);
        setActiveOrganizationId(payload.activeOrganizationId);
      })
      .catch(() => {
        if (!cancelled) setLoadError("No se pudieron cargar tus organizaciones.");
      });
    return () => { cancelled = true; };
  }, []);

  const logoImageUrl = useMemo(
    () => activeOrganizationId ? `/api/organizations/${activeOrganizationId}/logo${logoCacheBust ? `?t=${logoCacheBust}` : ""}` : null,
    [activeOrganizationId, logoCacheBust],
  );

  async function handleExport() {
    if (!activeOrganizationId || !logoImageUrl || creativeFiles.length === 0) return;
    setIsExporting(true);
    setExportFailures([]);
    setTopLevelExportError(null);
    // Corrección ronda 2 del plan review (bug real): el botón dispara
    // `() => void handleExport()` — sin este try/catch envolviendo TODA
    // la función, un fallo al cargar el logo mismo o en
    // buildLogoStudioZip rechazaba la promesa devuelta por handleExport,
    // que el `void` del botón descarta sin más: ningún mensaje visible,
    // contradiciendo el manejo de errores de la spec. El
    // Promise.allSettled de abajo sigue aislando fallos POR CREATIVO
    // (exportFailures); este try/catch cubre todo lo demás.
    try {
      const logoImage = new Image();
      await new Promise<void>((resolve, reject) => { logoImage.onload = () => resolve(); logoImage.onerror = reject; logoImage.src = logoImageUrl; });

      // Corrección ronda 1 (bug real): Promise.all abortaba TODO el export
      // si un solo creativo fallaba al cargar — Promise.allSettled aísla
      // cada fallo, igual que useAttentionTargets ya hace en la rama de
      // navegación para getContentRecord.
      const outcomes = await Promise.allSettled(creativeFiles.map(async (file) => {
        const creativeImage = new Image();
        const objectUrl = URL.createObjectURL(file);
        try {
          // Corrección ronda 3 del plan review (bug real, misma clase de
          // fuga ya arreglada en CompositePreview/Task 10 pero que faltaba
          // aplicar aquí): si la carga de la imagen rechaza, la línea de
          // revokeObjectURL de abajo nunca se ejecutaba — el objectUrl de
          // cada creativo que falla se quedaba vivo indefinidamente.
          await new Promise<void>((resolve, reject) => { creativeImage.onload = () => resolve(); creativeImage.onerror = reject; creativeImage.src = objectUrl; });
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
        const outputFormat: OutputFormat = file.type === "image/png" ? "image/png" : "image/jpeg";
        const blob = await compositeToBlob(creativeImage, logoImage, options, outputFormat);
        return { originalFilename: file.name, outputFormat, blob };
      }));

      const entries = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
      const failures = creativeFiles
        .filter((_, index) => outcomes[index].status === "rejected")
        .map((file) => ({ filename: file.name }));

      // Corrección ronda 3 del plan review (bug real: dos role="alert"
      // simultáneos posibles): cuando TODOS los creativos fallan, antes se
      // seteaban exportFailures Y topLevelExportError a la vez, generando
      // dos elementos role="alert" al mismo tiempo — findByRole("alert")
      // (singular) en un test lanzaría por encontrar más de uno. Ahora son
      // mutuamente excluyentes por construcción: el caso "todos fallaron"
      // solo setea topLevelExportError y sale antes de tocar
      // exportFailures; exportFailures solo se setea en el camino donde sí
      // hay algo que exportar (puede ser fallos parciales, o vacío si todo
      // salió bien).
      if (entries.length === 0) {
        setTopLevelExportError(`No se pudo procesar ningún creativo del lote (${failures.length} fallaron).`);
        return;
      }
      setExportFailures(failures);
      const zipBlob = await buildLogoStudioZip(entries);
      downloadZip(zipBlob, `snapgad-logos-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch {
      setTopLevelExportError("No se pudo generar el ZIP. Verifica que la organización tenga un logo subido e inténtalo de nuevo.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div>
      <h1>Logo Studio</h1>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {organizations.length > 0 ? (
        <OrganizationSwitcher
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
          onOrganizationChange={setActiveOrganizationId}
        />
      ) : null}
      {activeOrganizationId && logoImageUrl ? (
        <>
          {/*
            Corrección ronda 1 (bug real): key={activeOrganizationId} fuerza
            un remount completo de LogoUploadPanel al cambiar de
            organización — sin esto, su estado interno hasLogo se queda con
            el valor de la organización anterior hasta que el <img> nuevo
            dispara su propio onError.
          */}
          <LogoUploadPanel
            key={activeOrganizationId}
            organizationId={activeOrganizationId}
            onUploadSuccess={() => setLogoCacheBust((value) => value + 1)}
          />
          <CreativeBatchDropzone onFilesChange={setCreativeFiles} />
          <CompositeControls value={options} onChange={setOptions} />
          <CompositePreview creativeFile={creativeFiles[0] ?? null} logoImageUrl={logoImageUrl} options={options} />
          <button type="button" onClick={() => void handleExport()} disabled={creativeFiles.length === 0 || isExporting}>
            {isExporting ? "Exportando…" : "Exportar ZIP"}
          </button>
          {exportFailures.length > 0 ? (
            <p role="alert">No se pudo procesar: {exportFailures.map((failure) => failure.filename).join(", ")}. El resto del lote sí se exportó.</p>
          ) : null}
          {topLevelExportError ? <p role="alert">{topLevelExportError}</p> : null}
        </>
      ) : null}
    </div>
  );
}
```

(Verifica la firma real de `OrganizationSwitcher`/`OrganizationOption`/`parseOrganizationsResponse` contra `components/aias/organization-switcher.tsx` — el ejemplo de arriba ya se verificó contra ese archivo real durante la revisión de este plan, debería coincidir sin ajustes, pero confírmalo antes de dar por buena la implementación.)

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- tests/components/logo-studio-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: `tsc`, lint, build**

Run: `npx tsc --noEmit && npx eslint "app/(app)/tools/logo-studio/page.tsx" tests/components/logo-studio-page.test.tsx && npm run build`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/tools/logo-studio/page.tsx" tests/components/logo-studio-page.test.tsx
git commit -m "feat: add Logo Studio page integrating upload, batch, controls, preview, export"
```

---

### Task 12: Verificación final end-to-end

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Suite completa**

Run: `npm test`
Expected: todos los tests en PASS, incluidas las 11 tasks anteriores.

- [ ] **Step 2: Tipos, lint, build**

Run: `npx tsc --noEmit && npm run build`
Expected: limpio. (Para lint completo, usa `npx eslint . --ignore-pattern ".codebase-memory/**"` en vez de `npm run lint` sin argumentos, que falla por `EPERM` en ese directorio en este entorno.)

- [ ] **Step 3: Verificación manual en navegador (obligatoria — jsdom no prueba layout/CORS/canvas real)**

Con el dev server corriendo:
- `/tools/logo-studio` aparece en el nav con el ícono nuevo; el panel "Estado del sistema" no se solapa con el nav en un viewport de 768px de alto (repite la verificación que encontró el bug original en la rama de navegación — reduce el alto de la ventana y confirma que el nav se vuelve scrolleable en vez de solapar).
- Solo un switcher de organización visible en `/tools/logo-studio` (no el global + uno local a la vez).
- Subir un logo PNG real, confirmar que aparece; subir un JPEG, confirmar que se rechaza en el cliente.
- Cargar 2-3 creativos reales, ver el preview en vivo actualizarse al cambiar esquina/tamaño/margen.
- Exportar el ZIP, confirmar que descarga y que al abrirlo contiene los archivos esperados con el logo compuesto correctamente (sin canvas tainted — si esto falla con un error de seguridad en la consola del navegador, es la señal de que el proxy same-origin no está funcionando como se diseñó, revisar Task 4).

- [ ] **Step 4: No commit en este task — es solo verificación**

Si algo falla, vuelve a la task correspondiente y corrige ahí, con su propio commit adicional.
