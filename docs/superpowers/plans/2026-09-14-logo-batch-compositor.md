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
- Test: `lib/logo-studio/compose.test.ts`

**Estrategia de testing de canvas (ya resuelta en el spec, no la reinventes):** jsdom no implementa un contexto 2D funcional ni decodifica imágenes reales — `HTMLImageElement.decode()` no existe, así que `new Image()` real en un test nunca tiene `naturalWidth`/`naturalHeight` distintos de `0`. Los tests de `compositeToBlob` usan objetos `{ naturalWidth, naturalHeight } as unknown as HTMLImageElement` en vez de instancias reales de `Image`, y mockean `HTMLCanvasElement.prototype.getContext`/`toBlob` directamente. No instales el paquete `canvas` (binario nativo, innecesario con este enfoque).

- [ ] **Step 1: Escribir los tests que fallan — `computeLogoPlacement` (función pura, sin mocks)**

```typescript
/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { computeLogoPlacement } from "@/lib/logo-studio/compose";

describe("computeLogoPlacement", () => {
  it("places the logo in each of the 4 corners with the given margin", () => {
    const topLeft = computeLogoPlacement(1080, 1350, 200, 100, { corner: "top-left", sizePercent: 15, marginPercent: 4 });
    expect(topLeft.x).toBeCloseTo(1080 * 0.04);
    expect(topLeft.y).toBeCloseTo(1080 * 0.04);

    const bottomRight = computeLogoPlacement(1080, 1350, 200, 100, { corner: "bottom-right", sizePercent: 15, marginPercent: 4 });
    expect(bottomRight.x).toBeCloseTo(1080 - bottomRight.width - 1080 * 0.04);
    expect(bottomRight.y).toBeCloseTo(1350 - bottomRight.height - 1080 * 0.04);
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

- [ ] **Step 5: Escribir el test que falla — `compositeToBlob` (canvas mockeado)**

Agrega al mismo archivo de test:

```typescript
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { compositeToBlob } from "@/lib/logo-studio/compose";

function fakeImage(naturalWidth: number, naturalHeight: number): HTMLImageElement {
  return { naturalWidth, naturalHeight } as unknown as HTMLImageElement;
}

describe("compositeToBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws the creative then the logo at the placement computeLogoPlacement predicts, and resolves with the mocked blob", async () => {
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
    const result = await compositeToBlob(creative, logo, { corner: "bottom-right", sizePercent: 15, marginPercent: 4 }, "image/png");

    expect(result).toBe(fakeBlob);
    expect(drawImageCalls).toHaveLength(2); // creativo, luego logo
    expect(drawImageCalls[0][0]).toBe(creative);
    expect(drawImageCalls[1][0]).toBe(logo);
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

(La primera mitad del archivo — `computeLogoPlacement` — corre en `@vitest-environment node`; esta segunda mitad necesita `jsdom` para tener `HTMLCanvasElement` disponible. Si Vitest no permite mezclar dos `@vitest-environment` en un mismo archivo en la versión instalada, **divide el archivo**: `compose.test.ts` para la función pura y `compose-canvas.test.ts` para `compositeToBlob` — decide cuál aplica corriendo un test rápido primero.)

- [ ] **Step 6: Confirmar que falla**

Run: `npm test -- lib/logo-studio/compose.test.ts` (o `compose-canvas.test.ts` si dividiste el archivo)
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

Run: `npm test -- lib/logo-studio/compose.test.ts` (y `compose-canvas.test.ts` si aplica)
Expected: PASS, todos los tests de este archivo.

- [ ] **Step 9: `tsc`, lint**

Run: `npx tsc --noEmit && npx eslint lib/logo-studio/compose.ts lib/logo-studio/compose.test.ts`
Expected: limpio.

- [ ] **Step 10: Commit**

```bash
git add lib/logo-studio/compose.ts lib/logo-studio/compose.test.ts
git commit -m "feat: add pure logo placement math and canvas compositing"
```

---

### Task 3: `lib/logo-studio/export-zip.ts` — empaquetado ZIP

**Files:**
- Create: `lib/logo-studio/export-zip.ts`
- Test: `lib/logo-studio/export-zip.test.ts`
- Modify: `package.json` (agrega `jszip` a `dependencies`)

- [ ] **Step 1: Instalar `jszip`**

```bash
npm install jszip
```

Confirma que `package.json`/el lockfile quedan actualizados (`git status` debe mostrar ambos modificados).

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
  const withoutExtension = originalFilename.replace(/\.[^./\\]+$/, "");
  return `${withoutExtension}.${extension}`;
}

function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf(".");
    return dot === -1 ? `${name}-${count + 1}` : `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}`;
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

(Ajusta el nombre del lockfile si este proyecto usa `pnpm-lock.yaml` en vez de `package-lock.json` — confirma con `ls` antes de este `git add`.)

---

### Task 4: `app/api/organizations/[id]/logo/route.ts` — proxy same-origin + subida

**Files:**
- Create: `app/api/organizations/[id]/logo/route.ts`
- Test: `tests/api/organization-logo.test.ts`

**Antes de escribir código, lee `app/api/organizations/[id]/profile/route.ts` completo** — esta ruta nueva sigue su misma secuencia base (validar UUID con zod → `supabase.auth.getUser()` → resolver membership vía `organization_members`), pero con un gate de rol distinto y sin el JSON-parsing de esa ruta (esta usa `multipart/form-data` para `POST` y devuelve bytes de imagen para `GET`, no JSON).

**Predicado exacto de "no hay logo todavía" (verificado contra el SDK instalado, `@supabase/storage-js@2.116.0`):** `@supabase/supabase-js` re-exporta `StorageApiError` (`node_modules/@supabase/supabase-js/src/index.ts:16`), que trae un campo `.code` — "Service-specific error code from the Storage API response body, such as `NoSuchKey`, `AccessDenied`...". El predicado correcto es `error instanceof StorageApiError && error.code === "NoSuchKey"` → `404 LOGO_NOT_CONFIGURED`; cualquier otro error → `503 LOGO_LOOKUP_FAILED`.

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
  const membership = await deps.getMembership({ organizationId: parsed.data, userId: session.userId });
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

    const formData = await request.formData();
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
  const supabase = await createSupabaseServerClient();
  const deps = {
    getSession: async () => {
      const { data: { user }, error } = await supabase.auth.getUser();
      return error || !user ? null : { userId: user.id };
    },
    getMembership: async ({ organizationId, userId }: { organizationId: string; userId: string }) => {
      const { data, error } = await supabase.from("organization_members").select("role").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
      if (error || !data) return null;
      return { role: data.role as OrganizationRole };
    },
    download: (path: string) => supabase.storage.from("organization-logos").download(path),
    upload: (path: string, body: ArrayBuffer, options: { upsert: boolean; contentType: string }) => supabase.storage.from("organization-logos").upload(path, body, options),
  };
  return handlerFactory(deps)(request, context);
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
Expected: PASS, los 9 tests.

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
  it("includes a Logo Studio link with the image icon", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("link", { name: /Logo Studio/i })).toHaveAttribute("href", "/tools/logo-studio");
  });

  it("does not overlap the nav with the system-status panel (structural check — see Task 12 for real browser verification)", () => {
    render(<AppShell>content</AppShell>);
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });
    expect(nav.className).toMatch(/flex-1/);
    expect(nav.parentElement?.className).not.toMatch(/absolute/);
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
    const user = userEvent.setup();
    render(<LogoUploadPanel organizationId="org-1" />);
    const input = screen.getByLabelText(/subir logo/i);
    const jpegFile = new File(["fake"], "logo.jpg", { type: "image/jpeg" });
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
});
```

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- components/logo-studio/logo-upload-panel.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

```typescript
"use client";

import { useState } from "react";

export function LogoUploadPanel({ organizationId }: { organizationId: string }) {
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
git add components/logo-studio/logo-upload-panel.tsx components/logo-studio/logo-upload-panel.test.tsx
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
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    await user.upload(input, new File(["a"], "a.pdf", { type: "application/pdf" }));
    expect(screen.getByText(/tipo de archivo no soportado/i)).toBeInTheDocument();
  });

  it(`rejects a batch larger than MAX_BATCH_SIZE (${MAX_BATCH_SIZE})`, async () => {
    const onFilesChange = vi.fn();
    const user = userEvent.setup();
    render(<CreativeBatchDropzone onFilesChange={onFilesChange} />);
    const input = screen.getByLabelText(/cargar creativos/i);
    const tooMany = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) => new File(["a"], `${index}.png`, { type: "image/png" }));
    await user.upload(input, tooMany);
    expect(screen.getByText(new RegExp(`máximo ${MAX_BATCH_SIZE}`, "i"))).toBeInTheDocument();
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

  const onDrop = useCallback((acceptedFiles: File[], fileRejections: { file: File; errors: { code: string }[] }[]) => {
    if (fileRejections.length > 0) {
      setError("Hay archivos con tipo de archivo no soportado o demasiado grande — solo se aceptan .png/.jpg/.jpeg/.webp hasta 10 MB cada uno.");
    } else {
      setError(null);
    }
    if (acceptedFiles.length > MAX_BATCH_SIZE) {
      setError(`Máximo ${MAX_BATCH_SIZE} creativos por lote.`);
      onFilesChange(acceptedFiles.slice(0, MAX_BATCH_SIZE));
      return;
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

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logo-studio/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logo-studio/compose")>();
  return { ...actual, compositeToBlob: vi.fn().mockResolvedValue(new Blob(["fake"], { type: "image/png" })) };
});

import { CompositePreview } from "@/components/logo-studio/composite-preview";

afterEach(() => cleanup());

describe("CompositePreview", () => {
  it("shows a placeholder when there's no creative selected yet", () => {
    render(<CompositePreview creativeFile={null} logoImageUrl="/api/organizations/org-1/logo" options={{ corner: "bottom-right", sizePercent: 15, marginPercent: 4 }} />);
    expect(screen.getByText(/carga al menos un creativo/i)).toBeInTheDocument();
  });
});
```

(Este componente depende de carga real de imágenes en el navegador — su cobertura de test se mantiene deliberadamente mínima, solo el estado vacío; el comportamiento real de composición ya está probado a fondo en `compose.test.ts`, Task 2 — no dupliques esa cobertura aquí con más mocks de canvas.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- components/logo-studio/composite-preview.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

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
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!creativeFile) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;

    async function render() {
      const creativeImage = new Image();
      const logoImage = new Image();
      const creativeUrl = URL.createObjectURL(creativeFile!);
      await Promise.all([
        new Promise<void>((resolve, reject) => { creativeImage.onload = () => resolve(); creativeImage.onerror = reject; creativeImage.src = creativeUrl; }),
        new Promise<void>((resolve, reject) => { logoImage.onload = () => resolve(); logoImage.onerror = reject; logoImage.src = logoImageUrl; }),
      ]);
      URL.revokeObjectURL(creativeUrl);
      if (cancelled) return;

      const blob = await compositeToBlob(creativeImage, logoImage, options, "image/png");
      if (cancelled) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setPreviewUrl(url);
    }

    render().catch(() => setPreviewUrl(null));
    return () => { cancelled = true; };
  }, [creativeFile, logoImageUrl, options]);

  if (!creativeFile) return <p>Carga al menos un creativo para ver el preview.</p>;
  return previewUrl ? <img src={previewUrl} alt="Preview del composite" /> : <p>Generando preview…</p>;
}
```

- [ ] **Step 4: Confirmar que pasa**

Run: `npm test -- components/logo-studio/composite-preview.test.tsx`
Expected: PASS.

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

**Antes de escribir código, lee `app/(app)/settings/organizations/page.tsx` completo** — esta página nueva resuelve `activeOrganizationId` exactamente con el mismo patrón (fetch propio de `GET /api/organizations`, estado local, su propia instancia de `OrganizationSwitcher` con `onOrganizationChange`), no un mecanismo nuevo.

- [ ] **Step 1: Escribir el test que falla**

```typescript
/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logo-studio/export-zip", () => ({
  buildLogoStudioZip: vi.fn().mockResolvedValue(new Blob(["zip"])),
  downloadZip: vi.fn(),
}));

import LogoStudioPage from "@/app/(app)/tools/logo-studio/page";
import { downloadZip } from "@/lib/logo-studio/export-zip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LogoStudioPage", () => {
  it("resolves the active organization from GET /api/organizations, same as settings/organizations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      organizations: [{ id: "org-1", name: "SnapGad" }],
      activeOrganizationId: "org-1",
    }), { status: 200 })));

    render(<LogoStudioPage />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/organizations"));
    expect(await screen.findByText(/SnapGad/i)).toBeInTheDocument();
  });

  it("re-fetches the logo when the active organization changes via the local switcher", async () => {
    // La aserción exacta depende de cómo termine estructurado el switcher local —
    // como mínimo, confirma que cambiar de organización dispara un nuevo
    // GET /api/organizations/{nuevoId}/logo (o el <img src> apunta al nuevo id),
    // no el de la organización anterior.
  });
});
```

(El segundo test queda deliberadamente como esqueleto — complétalo durante la implementación una vez que la estructura real del switcher local esté decidida; no lo dejes vacío en el commit final, es la prueba directa del hallazgo de ronda 2 del spec sobre contexto de organización.)

- [ ] **Step 2: Confirmar que falla**

Run: `npm test -- tests/components/logo-studio-page.test.tsx`
Expected: FAIL — el módulo no existe todavía.

- [ ] **Step 3: Implementar**

Estructura mínima — junta todos los componentes de las Tasks 5-10:

```typescript
"use client";

import { useEffect, useState } from "react";

import { OrganizationSwitcher, type OrganizationOption } from "@/components/aias/organization-switcher";
import { CompositeControls } from "@/components/logo-studio/composite-controls";
import { CompositePreview } from "@/components/logo-studio/composite-preview";
import { CreativeBatchDropzone } from "@/components/logo-studio/creative-batch-dropzone";
import { LogoUploadPanel } from "@/components/logo-studio/logo-upload-panel";
import { compositeToBlob, type CompositeOptions } from "@/lib/logo-studio/compose";
import { buildLogoStudioZip, downloadZip } from "@/lib/logo-studio/export-zip";

export default function LogoStudioPage() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const [creativeFiles, setCreativeFiles] = useState<File[]>([]);
  const [options, setOptions] = useState<CompositeOptions>({ corner: "bottom-right", sizePercent: 15, marginPercent: 4 });
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/organizations")
      .then((response) => response.json())
      .then((payload: { organizations: OrganizationOption[]; activeOrganizationId: string | null }) => {
        if (cancelled) return;
        setOrganizations(payload.organizations);
        setActiveOrganizationId(payload.activeOrganizationId);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function handleExport() {
    if (!activeOrganizationId || creativeFiles.length === 0) return;
    setIsExporting(true);
    try {
      const logoUrl = `/api/organizations/${activeOrganizationId}/logo`;
      const logoImage = new Image();
      await new Promise<void>((resolve, reject) => { logoImage.onload = () => resolve(); logoImage.onerror = reject; logoImage.src = logoUrl; });

      const entries = await Promise.all(creativeFiles.map(async (file) => {
        const creativeImage = new Image();
        const objectUrl = URL.createObjectURL(file);
        await new Promise<void>((resolve, reject) => { creativeImage.onload = () => resolve(); creativeImage.onerror = reject; creativeImage.src = objectUrl; });
        URL.revokeObjectURL(objectUrl);
        const outputFormat = file.type === "image/png" ? "image/png" as const : "image/jpeg" as const;
        const blob = await compositeToBlob(creativeImage, logoImage, options, outputFormat);
        return { originalFilename: file.name, outputFormat, blob };
      }));

      const zipBlob = await buildLogoStudioZip(entries);
      downloadZip(zipBlob, `snapgad-logos-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div>
      <h1>Logo Studio</h1>
      {organizations.length > 0 ? (
        <OrganizationSwitcher
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
          onOrganizationChange={setActiveOrganizationId}
        />
      ) : null}
      {activeOrganizationId ? (
        <>
          <LogoUploadPanel organizationId={activeOrganizationId} />
          <CreativeBatchDropzone onFilesChange={setCreativeFiles} />
          <CompositeControls value={options} onChange={setOptions} />
          <CompositePreview creativeFile={creativeFiles[0] ?? null} logoImageUrl={`/api/organizations/${activeOrganizationId}/logo`} options={options} />
          <button type="button" onClick={() => void handleExport()} disabled={creativeFiles.length === 0 || isExporting}>
            {isExporting ? "Exportando…" : "Exportar ZIP"}
          </button>
        </>
      ) : null}
    </div>
  );
}
```

(Verifica la firma real de `OrganizationSwitcher`/`OrganizationOption` contra `components/aias/organization-switcher.tsx` — el ejemplo de arriba asume la misma forma que ya usa `settings/organizations/page.tsx`, ajusta si difiere.)

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
