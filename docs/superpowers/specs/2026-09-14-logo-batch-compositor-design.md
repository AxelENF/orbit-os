# SnapGad Batch Studio — compositor de logo en lote — diseño

**Fecha:** 2026-09-14
**Estado:** Aprobado por Axel de forma anticipada — sesión autónoma ("hazme las putas cosas... no quiero que pares ni preguntes mamadas... delega mas activamente, haz mas cosas"). Decisiones documentadas con su razonamiento para revisión posterior.
**Roadmap:** Tercer ítem del orden de 4 partes acordado el 2026-09-14 (intake ✅ → navegación/IA ✅ → **compositor de logo** → capa MCP).
**Rama:** `feat/logo-batch-compositor`, creada sobre `feat/personal-pilot-hardening` (commit `84e6b0d`) — independiente de las ramas de Meta publisher/intake/navegación, no depende de ninguna de ellas. Próxima migración de esta rama: `0018` (otro significado distinto de "0018" en una cuarta rama hermana — patrón ya aceptado y documentado esta sesión).

## Contexto

Memoria de una sesión de brainstorming previa (2026-09-10, `[[project-logo-batch-studio]]`), releída y verificada contra el código actual antes de escribir este spec:

- Axel genera creativos finales ("imágenes bonitas") con un proceso **externo** a Orbit OS (una sesión de Codex propia, con vault y prompts entrenados) — esas imágenes llegan **sin logo**. La herramienta que falta aquí es puramente un **compositor**: N creativos sin logo + un logo PNG transparente por organización → aplicar el logo en una esquina elegida, un tamaño % y un margen de seguridad → exportar un ZIP.
- Ya existe un mockup HTML concreto que Axel compartió, nombrado "SnapGad Batch Studio": carga en lote de creativos (ejemplo 1080×1350), preview del logo contra un checkerboard de transparencia, slider de tamaño, selector de 4 esquinas, control de margen de seguridad, botón de exportar ZIP. Copy del mockup: *"Procesamiento local · tus imágenes no salen de tu navegador"* — una promesa de privacidad explícita que este spec debe honrar literalmente (compositing 100% client-side, los creativos nunca se suben a Supabase).
- Explícitamente rechazado por Axel: un generador de imágenes con IA dentro de Orbit OS ("no quiero un generador de imagen dentro") — la generación ya vive en su flujo externo de Codex, fuera de alcance aquí.

**Verificado contra el código real de esta rama (no asumido):**
- No existe ningún compositor de imágenes en el proyecto hoy — ni cliente ni servidor.
- `components/content/asset-dropzone.tsx` es la única UI de carga de archivos existente — **un solo archivo**, drag-and-drop hecho a mano con eventos HTML5 nativos (`acceptFile(file: File | undefined)`, singular), **no usa** el paquete `react-dropzone` a pesar de que `react-dropzone@^20.1.1` ya está en `package.json` como dependencia — está instalado pero sin uso real en el código hoy.
- No existe ninguna librería de ZIP en `package.json` (`jszip` u otra) — es una dependencia nueva que este spec introduce.
- El patrón de Storage existente (`lib/supabase/repository.ts:560-566`, bucket `content-assets`) sube cada asset a
  `{organization_id}/{asset_id}/{filename_saneado}` con `upsert: false` (los content assets son inmutables una vez creados) y sirve el contenido vía `createSignedUrl(..., 10 * 60)` (URLs firmadas de 10 minutos, nunca públicas — **corrección tras revisión de Codex CLI ronda 1: esa llamada vive en `lib/supabase/repository.ts:756-757` dentro de `getContentRecord`, no en el rango 550-566, que solo cubre la subida**).
- Las políticas RLS reales del bucket `content-assets`
  (`supabase/migrations/0009_tenantize_content_and_jobs.sql:355-375`) usan
  `storage.foldername(name)` para leer segmentos de la ruta, y dos
  funciones Postgres ya existentes y reutilizables:
  `public.is_organization_member(organization_id uuid)` y
  `public.has_organization_role(organization_id uuid, roles organization_role[])`.
  Esas políticas están escritas para una ruta de **3 segmentos**
  (`{organization_id}/{asset_id}/{filename}`) y además exigen (vía
  `EXISTS`) que el segundo segmento coincida con una fila real en
  `public.assets` — **no son reutilizables tal cual** para la ruta de 2
  segmentos que este spec propone (`{organization_id}/logo.png`); ver
  "Políticas RLS del bucket nuevo" más abajo, donde se corrige esto.
- `app/api/organizations/` ya tiene tres rutas: `route.ts` (listado, con
  `GET` devolviendo `{ organizations, activeOrganizationId }` — este
  último derivado server-side de una cookie firmada vía
  `verifyActiveOrganizationCookieValue`, `app/api/organizations/route.ts:55-67`),
  `active/route.ts`, y `[id]/profile/route.ts` — esta última es el
  patrón más cercano a lo que esta feature necesita (una ruta
  `[id]/algo` con verificación de membership y rol).
  **Corrección tras revisión de Codex CLI ronda 2 (cita de línea
  incorrecta):** la secuencia base (validar UUID con zod → resolver
  sesión vía `supabase.auth.getUser()` → resolver membership vía
  `organization_members`) es común a ambos handlers de ese archivo y
  vive en `149-189` (el handler `GET`, que en ese caso **no** aplica
  ningún gate de rol adicional — leer un perfil no lo necesita). El gate
  de rol (`canEditCampaign`) está específicamente en el handler `PUT`/`PATCH`,
  línea `222`, dentro del rango `191-288`. La ruta de logo nueva
  reutiliza la secuencia base para ambos métodos, y el gate de rol
  (`canManageConnections`) solo en `POST`, igual que `canEditCampaign`
  solo aparece en el handler de escritura de `profile/route.ts`, no en
  el de lectura.
- `lib/organizations/permissions.ts` define los únicos gates de rol que
  existen hoy: `canEditCampaign` (owner|editor), `canApproveCampaign`
  (owner|reviewer), `canManageConnections` (owner únicamente — usado hoy
  para la conexión OAuth de Meta).

## Alcance

**Incluido:**
1. Página nueva, standalone: un "Logo Studio" donde el usuario:
   - Sube/reemplaza el logo PNG transparente **único** de su organización (persistido en Supabase Storage, reutilizable entre sesiones).
   - Carga en lote N creativos (`.png`/`.jpg`/`.jpeg`/`.webp`) — **100% client-side, nunca tocan Supabase** — esto es la promesa de privacidad del mockup, literal.
   - Elige esquina (4 opciones), tamaño (% del lado más corto del creativo) y margen de seguridad (% del lado más corto).
   - Ve un preview en vivo del composite sobre al menos un creativo de la tanda.
   - Exporta los N creativos compuestos como un solo ZIP, generado enteramente en el navegador.
2. Persistencia del logo: bucket nuevo de Supabase Storage (`organization-logos`), un archivo por organización en una ruta fija y predecible — sin tabla nueva en la base de datos (ver "Persistencia del logo" abajo, es una decisión YAGNI deliberada).
3. Entrada nueva en el nav principal (`app-shell.tsx`) — ver "Navegación" abajo.

**Explícitamente fuera de alcance:**
- Generación de imágenes con IA — ya rechazado por Axel, no se reconsidera.
- Integración automática con el pipeline de campañas (p. ej., estampar el logo automáticamente al crear una campaña en `/library/new`) — se queda como herramienta manual, standalone, por ahora. Candidato futuro explícito, no se construye aquí — igual que el dashboard de resultados quedó fuera del spec de navegación.
- Múltiples logos por organización (variantes estacionales, etc.) — un logo reutilizable por organización, por ahora.
- Compositing server-side — client-side puro, por la promesa de privacidad ya hecha en el copy del mockup.
- Validación de que el PNG del logo realmente tenga transparencia significativa — solo se valida el tipo MIME (`image/png`); detectar transparencia real de forma confiable es frágil y no vale el costo aquí.

## Arquitectura

### Archivos nuevos

- `app/(app)/tools/logo-studio/page.tsx` — la página, `"use client"`.
- `components/logo-studio/logo-upload-panel.tsx` — sube/reemplaza el logo de la organización, muestra el logo actual si existe.
- `components/logo-studio/creative-batch-dropzone.tsx` — carga múltiple de creativos. **Decisión: usa `react-dropzone`** (ya instalado, sin uso hoy) en vez de extender el patrón hecho-a-mano de `asset-dropzone.tsx` — `react-dropzone` ya resuelve `multiple`/`maxFiles`/validación de tipo de forma robusta, y aprovechar una dependencia ya instalada pero dormida es mejor que reimplementar esa lógica por segunda vez a mano.
- `components/logo-studio/composite-controls.tsx` — selector de 4 esquinas, slider de tamaño, slider de margen.
- `components/logo-studio/composite-preview.tsx` — canvas de preview en vivo sobre un creativo representativo.
- `lib/logo-studio/compose.ts` — **matemática pura**, testeable sin canvas real:
  ```typescript
  export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
  export type CompositeOptions = { corner: Corner; sizePercent: number; marginPercent: number };

  export function computeLogoPlacement(
    creativeWidth: number,
    creativeHeight: number,
    logoNaturalWidth: number,
    logoNaturalHeight: number,
    options: CompositeOptions,
  ): { x: number; y: number; width: number; height: number } {
    if (logoNaturalWidth <= 0 || logoNaturalHeight <= 0) {
      throw new Error("Logo dimensions must be positive."); // corrección ronda 2: evita división por cero si el logo no cargó
    }
    const shortSide = Math.min(creativeWidth, creativeHeight);
    const margin = shortSide * (options.marginPercent / 100);
    const availableWidth = creativeWidth - margin * 2;
    const availableHeight = creativeHeight - margin * 2;

    let width = shortSide * (options.sizePercent / 100);
    let height = width * (logoNaturalHeight / logoNaturalWidth); // preserva aspect ratio del logo

    // Corrección tras revisión de Codex CLI ronda 1: sizePercent solo
    // acotaba el ancho — un logo con aspect ratio muy alto (p. ej. un
    // isotipo casi cuadrado o vertical) podía producir un height mayor
    // que el propio creativo. Clamp proporcional contra AMBAS
    // dimensiones disponibles, no solo el ancho derivado del lado corto.
    const scale = Math.min(1, availableWidth / width, availableHeight / height);
    width *= scale;
    height *= scale;

    const x = options.corner.includes("left") ? margin : creativeWidth - width - margin;
    const y = options.corner.includes("top") ? margin : creativeHeight - height - margin;
    return { x, y, width, height };
  }
  ```

**Límites de los controles — corrección tras revisión de Codex CLI ronda 1 (no estaban definidos):** `sizePercent`: rango 5–40, default 15. `marginPercent`: rango 0–10, default 4. Estos rangos, combinados con el clamp de arriba, garantizan que el logo nunca exceda las dimensiones del creativo incluso en combinaciones extremas (tamaño máximo + logo de aspect ratio inusual). Los valores exactos son un punto de partida razonable, no una medición — la revisión del plan puede ajustarlos.
  Esta función no toca el DOM ni `<canvas>` — el efecto de dibujar (`drawImage`) vive en una función separada:
  ```typescript
  export type OutputFormat = "image/png" | "image/jpeg";

  export function compositeToBlob(
    creativeImage: HTMLImageElement,
    logoImage: HTMLImageElement,
    options: CompositeOptions,
    outputFormat: OutputFormat,
    jpegQuality = 0.92,
  ): Promise<Blob> { /* ... */ }
  ```

**Corrección tras revisión de Codex CLI ronda 3 (el "fallback" de ronda
2 estaba mal razonado — se descarta, se reemplaza por un rediseño real):**
la ronda 2 proponía `fetch()` la URL firmada y convertir la respuesta a
un `blob:` URL "sin depender de CORS" — **eso es incorrecto**: `fetch()`
a una URL de otro origen necesita exactamente el mismo permiso CORS que
`<img crossOrigin="anonymous">` para poder LEER el cuerpo de la
respuesta (`response.blob()`); sin CORS, la respuesta llega "opaca" (no
legible) o el fetch falla. No existe ninguna forma de leer bytes
cross-origin en el navegador sin cooperación CORS del servidor — mover
el fetch a JS no evita el problema, solo lo reubica. Y Supabase no
documenta de forma explícita que sus URLs firmadas de Storage envíen
headers CORS permisivos — no es algo para asumir.

**Rediseño real: el logo se sirve por un proxy same-origin, no por una
URL firmada directa al navegador.** `GET /api/organizations/[id]/logo`
(la misma ruta ya descrita en "Ruta de API") no devuelve JSON con un
`logoUrl` — devuelve los **bytes de la imagen directamente**
(`Content-Type: image/png`, sin `Cache-Control` agresivo ya que el
logo puede reemplazarse). El servidor descarga el objeto de Storage
él mismo (server-to-server, sin restricción CORS — CORS es una regla
del navegador, no aplica a `fetch`/al SDK de Supabase corriendo en el
servidor) y lo transmite de vuelta. El `<img>`/`<canvas>` del navegador
entonces apunta a `/api/organizations/{id}/logo` — una ruta **del mismo
origen que la app** por construcción, así que nunca puede manchar el
canvas y `crossOrigin`/CORS deja de ser una pregunta abierta. Esto
también simplifica la detección de "no hay logo todavía": el cliente ya
no necesita una llamada previa para verificar existencia — un `<img>`
apuntando a esa ruta dispara su `onError` de forma nativa si el
servidor responde `404`, sin lógica adicional. Tras subir un logo
nuevo, el cliente vuelve a apuntar el `<img>` a la misma ruta con un
parámetro de cache-busting (`?t=${Date.now()}`) para forzar que el
navegador no sirva la versión anterior desde caché. Los creativos del
usuario (`File` locales, nunca network) no tienen este problema en
absoluto — solo el logo, por venir de una ruta que internamente toca
Storage.

**Corrección tras revisión de Codex CLI ronda 1 (gap real de testing),
ampliada en ronda 2 (jsdom tampoco "carga" imágenes de verdad):**
verificado — `vitest.config.ts` usa `environment: "node"` globalmente
(jsdom se activa por archivo vía el comentario
`/** @vitest-environment jsdom */`, mismo patrón que
`tests/components/library-page.test.tsx` en la rama hermana), y no hay
ningún paquete `canvas` instalado ni configurado. jsdom por sí solo NO
implementa un contexto 2D funcional — `canvasElement.getContext("2d")`
devuelve `null` sin un polyfill. **Decisión: no instalar el paquete
`canvas`** (un binario nativo, dependencia pesada solo para tests) —
en su lugar, los tests de `compositeToBlob` mockean directamente
`HTMLCanvasElement.prototype.getContext` (devolviendo un objeto falso
que registra las llamadas a `drawImage` con sus argumentos) y
`HTMLCanvasElement.prototype.toBlob` (invocando el callback con un
`Blob` falso) — permite verificar QUÉ se dibujó (posición/tamaño
correctos, delegando en `computeLogoPlacement` ya probado por separado)
sin necesitar un canvas real. **Además** — hallazgo real de ronda 2:
jsdom tampoco implementa `HTMLImageElement.decode()` ni decodifica
imágenes de verdad, así que un `new Image()` real en un test nunca
llega a tener `naturalWidth`/`naturalHeight` distintos de `0`. Los
tests no intentan cargar una imagen real en absoluto: construyen un
objeto con la forma mínima que `compositeToBlob` necesita
(`{ naturalWidth, naturalHeight } as HTMLImageElement`, casteado) en
vez de instanciar `new Image()` y esperar a que cargue. El flujo de
exportación de ZIP también necesita mockear
`URL.createObjectURL`/`URL.revokeObjectURL` (no implementados de forma
útil en jsdom) para los tests que verifican que la descarga se dispara.
`computeLogoPlacement` se prueba aparte, sin ningún mock, como función
pura.
- `lib/logo-studio/export-zip.ts` — envuelve `jszip` (dependencia nueva) para empaquetar N blobs en un ZIP y disparar la descarga (`URL.createObjectURL` + un `<a download>` sintético — patrón estándar, sin librería adicional).
- `app/api/organizations/[id]/logo/route.ts` — `POST` (subir/reemplazar) y `GET` (proxy same-origin que transmite los bytes de la imagen directamente — ver "canvas tainted por CORS" arriba para el porqué —, o `404` si no hay logo todavía). Mismo patrón de auth/scoping por organización que las demás rutas de `app/api/organizations/`.
- `supabase/migrations/0018_organization_logos_bucket.sql` — crea el bucket `organization-logos` (privado, igual que `content-assets`) + políticas RLS equivalentes a las de ese bucket, escopeadas por organización.

### Persistencia del logo — sin tabla nueva (decisión YAGNI)

El logo de cada organización vive en una ruta **fija y predecible**: `{organization_id}/logo.png` dentro del bucket `organization-logos`, con `upsert: true` (a diferencia de `content-assets`, que es inmutable — un logo sí debe poder reemplazarse). No hace falta una tabla ni columna nueva para "saber" si una organización tiene logo: el servidor (dentro de la ruta de API, no el cliente directamente — ver el rediseño de proxy same-origin arriba) intenta `.download(path)` sobre esa ruta fija; un error de "objeto no encontrado" se interpreta como "todavía no hay logo" (estado inicial normal, no un error real — responde `404`, que el `<img onError>` del cliente maneja de forma nativa). Esto evita una migración con tabla nueva para lo que es fundamentalmente un mapeo 1:1 organización→archivo ya expresable por convención de ruta — pero **sí** hace falta una migración para el bucket y sus políticas RLS.

**Políticas RLS del bucket nuevo — corrección tras revisión de Codex CLI ronda 1 (las de `content-assets` no son reutilizables tal cual):** las políticas de `content-assets` esperan una ruta de 3 segmentos y una fila coincidente en `public.assets` — esta ruta es de 2 segmentos y no tiene tabla asociada, así que las políticas se escriben desde cero (reutilizando las mismas funciones Postgres ya existentes, `is_organization_member`/`has_organization_role`, no reinventándolas), y a diferencia de `content-assets` (que nunca se reemplaza, `upsert: false`) esta sí necesita una política `UPDATE` explícita para el reemplazo:

```sql
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

**Corrección tras revisión de Codex CLI ronda 2 (invariante de ruta
débil):** las políticas de arriba ya escopean correctamente por
organización (sin fuga cross-tenant), pero sin la cláusula
`name = (storage.foldername(name))[1] || '/logo.png'` un owner podría
técnicamente subir `{organization_id}/cualquier-otra-cosa.png` — no es
una fuga de seguridad (sigue aislado por organización), pero debilita a
propósito el diseño de "un archivo fijo y predecible por organización"
del que depende el resto del spec (el cliente asume que SIEMPRE puede
pedir la URL firmada de `{organization_id}/logo.png` sin necesidad de
listar el bucket). El `with check` de arriba ya lo agrega — defensa en
profundidad barata, una sola cláusula extra.

Lectura abierta a cualquier miembro de la organización (ver el logo actual no es sensible); subir/reemplazar restringido a `owner` — el logo es una decisión de marca a nivel organización, afecta todas las publicaciones futuras, así que se trata con el mismo nivel de restricción que gestionar la conexión de Meta (`canManageConnections`, también owner-únicamente), no con el nivel más permisivo de editar una campaña individual (`canEditCampaign`, owner|editor).

### Ruta de API

`app/api/organizations/[id]/logo/route.ts` sigue la secuencia base de `app/api/organizations/[id]/profile/route.ts:149-189` (validar UUID con zod → `supabase.auth.getUser()` → resolver membership vía `organization_members` → `jsonError`/`jsonOk` con `Cache-Control: no-store`), con estas diferencias específicas de esta feature:

- `POST` (subir/reemplazar): `Content-Type: multipart/form-data`, no JSON — se lee vía `request.formData()`, no `request.text()`/`JSON.parse`.
  **Contrato concreto — corrección tras revisión de Codex CLI ronda 2 (faltaba especificar):**
  - Campo del FormData: `formData.get("logo")` (un solo `File`).
  - Respuesta exitosa: `{ success: true }` (`200`) — **corrección tras revisión de Codex CLI ronda 3:** ya no `{ logoUrl }` con una URL firmada, porque `GET` ahora es un proxy same-origin (ver rediseño arriba), no devuelve una URL para que el cliente la use directamente. Tras un `POST` exitoso, el cliente vuelve a apuntar su `<img>` a `GET /api/organizations/{id}/logo?t=${Date.now()}` (cache-busting) para ver el logo nuevo.
  - Límite de tamaño: **5 MB** por archivo (cota de seguridad, advisory, igual que el límite de 30 creativos — la revisión de plan puede ajustarlo).
  - Validación server-side del PNG — **corrección tras revisión de Codex CLI ronda 2 (no basta con MIME declarado):** valida la firma real de bytes del archivo (los 8 bytes mágicos de PNG: `89 50 4E 47 0D 0A 1A 0A`), no el `file.type` del `FormData` (controlado por el cliente, falsificable) ni la extensión del nombre. Al subir a Storage, se fuerza siempre `contentType: "image/png"` explícito — nunca se reenvía ciegamente el `file.type` recibido.
  - Códigos de error: `400 INVALID_ORGANIZATION_ID` (UUID inválido), `401 AUTHENTICATION_REQUIRED`, `403 ORGANIZATION_ACCESS_DENIED` (no es owner), `404 ORGANIZATION_NOT_FOUND`, `413 REQUEST_TOO_LARGE`, `422 INVALID_LOGO_FORMAT` (no es un PNG real, falla la validación de firma de bytes), `503 LOGO_UPLOAD_FAILED` (falla real de Storage).
  - Rol requerido: `canManageConnections(membership.role)` (owner-únicamente — reutilizada tal cual de `lib/organizations/permissions.ts`, mismo patrón que `profile/route.ts:222` aplica `canEditCampaign` solo en su handler de escritura; el nombre "connections" referencia el caso de uso original de Meta OAuth, pero la restricción real que expresa — owner-únicamente para configuración a nivel organización — aplica igual de bien aquí; no se crea una función de permiso nueva solo para diferenciar el nombre, sería una duplicación sin diferencia funcional).
- `GET` (proxy same-origin de los bytes de la imagen — ver rediseño arriba): sin gate de rol adicional más allá de la membership — cualquier miembro puede ver el logo actual. Respuesta exitosa: el binario de la imagen, `Content-Type: image/png`, `200`. Internamente llama `storage.from('organization-logos').download(path)`. Debe distinguir explícitamente "no hay logo todavía" (`404 LOGO_NOT_CONFIGURED` — un estado esperado, no un fallo — el `<img onError>` del cliente lo interpreta como "sin logo", no como una falla) de un error real de Storage (`503 LOGO_LOOKUP_FAILED`). **Corrección tras revisión de Codex CLI ronda 3 (predicado vago):** el objeto `error` que devuelve `.download()` del SDK de Supabase Storage debe inspeccionarse para el caso específico de "objeto no encontrado" (en versiones recientes del SDK, vía `error.name`/`error instanceof StorageUnknownError` con un `status`/`statusCode` de 404, o el mensaje literal que use la versión instalada) — el valor exacto a verificar contra `@supabase/supabase-js` de este proyecto durante la implementación (no se fija aquí un string que podría no coincidir con la versión real instalada); cualquier otro error se trata como `503`.

### Contexto de organización activa — corrección tras revisión de Codex CLI ronda 2 (gap real, no especificado)

El `<OrganizationSwitcher />` que `app-shell.tsx` renderiza automáticamente en cada página (excepto onboarding/settings) **no expone ningún callback** — es un widget pasivo sin forma de que otra página reaccione a un cambio de organización. Verificado: `app/(app)/settings/organizations/page.tsx` ya resuelve este mismo problema para su propio caso — no depende del switcher global, sino que:
1. Llama `GET /api/organizations` por su cuenta, obteniendo `{ organizations, activeOrganizationId }`.
2. Guarda `activeOrganizationId` en estado local propio.
3. Renderiza su propia instancia de `<OrganizationSwitcher organizations={...} activeOrganizationId={...} onOrganizationChange={setActiveOrganizationId} />`, separada del widget global del `app-shell`.

`app/(app)/tools/logo-studio/page.tsx` sigue exactamente este mismo patrón (no se inventa uno nuevo): resuelve `activeOrganizationId` por su cuenta, y cuando cambia (el usuario elige otra organización desde el switcher local de esta página), se re-dispara el `GET` del logo actual — así nunca se queda mostrando el logo de una organización distinta a la seleccionada.

**Corrección tras revisión de Codex CLI ronda 3 (bug real: dos
switchers a la vez):** el `<main>` de `app-shell.tsx` renderiza el
switcher global automáticamente en cualquier página donde
`hasSupabaseBrowserConfig() && pathname !== "/onboarding" &&
!pathname.startsWith("/onboarding/") &&
!pathname.startsWith("/settings/organizations")` — esa condición
**no excluye** `/tools/logo-studio`, así que sin un cambio ahí, Logo
Studio mostraría el switcher global (pasivo, sin callback) **y** el
switcher local de esta página (con callback) al mismo tiempo — dos
selectores redundantes, y cambiar el global no actualizaría el estado
local de la página. Se agrega
`!pathname.startsWith("/tools/logo-studio")` a esa misma condición en
`app-shell.tsx`, exactamente el mismo patrón de exclusión que ya existe
para `/settings/organizations` — no un mecanismo nuevo.

### Navegación

**Corrección tras revisión de Codex CLI ronda 1:** la versión anterior
de esta sección asumía que `app-shell.tsx` en esta rama ya tenía las 7
entradas de nav de la rama hermana `feat/ia-navigation-unification`
(incluida `settings`) — falso, verificado: esta rama parte de
`feat/personal-pilot-hardening`, anterior a ese trabajo, así que
`app-shell.tsx` aquí todavía tiene solo **6** entradas
(`home, campaigns, plus, review, results, check` — sin `settings`, sin
Configuración) y `IconName` no incluye `settings`. `components/layout/app-shell.tsx`: se agrega una **7ª** entrada al arreglo `navigation`,
`{ href: "/tools/logo-studio", label: "Logo Studio", eyebrow: "Herramientas", icon: "image" }`.
Ningún ícono existente en esta rama (`home`, `campaigns`, `plus`, `review`, `results`, `chevron`, `spark`, `menu`, `close`, `arrow`, `check`) es semánticamente correcto para "herramienta de imagen" — se agrega un ícono nuevo, `image` (un marco simple con un círculo de sol y una montaña, mismo estilo `stroke`/`viewBox 0 0 24 24` que los demás), a `IconName` y al record `paths` de `app-icon.tsx`.

**Nota de continuidad real (no hipotética), confirmada contra el código de esta rama en la ronda 1 de revisión:** la Task 9 de la feature de navegación (rama hermana `feat/ia-navigation-unification`) ya encontró y corrigió un bug real de layout — el `<aside>` de `app-shell.tsx` usaba un panel "Estado del sistema" posicionado `absolute bottom-7` (**confirmado: sigue así en esta rama, `app-shell.tsx:80`**), que un 7º ítem de nav llegó a solapar visualmente a 768px de alto de viewport (un alto común de laptop) en esa otra rama, porque los tests automatizados no renderizan layout/posicionamiento CSS real y no lo detectaron — solo se encontró con verificación manual en navegador. Esa rama ya lo arregló convirtiendo el `<aside>` en un flex-column con el nav en una región `flex-1 overflow-y-auto` (que se vuelve scrolleable si el contenido no cabe) y el panel de estado como hijo de flujo normal después del nav, en vez de posicionado absoluto — así nunca puede solaparse, sin importar cuántos ítems tenga el nav en el futuro. **Esta rama (`feat/logo-batch-compositor`) todavía NO tiene ese fix** — agregar el 7º ítem de nav aquí (Logo Studio), sobre el `app-shell.tsx` viejo (con el panel todavía `absolute`), reintroduciría el mismo bug al mismo conteo de ítems que lo disparó la primera vez. El plan de implementación debe portar ese mismo fix de layout a esta rama como parte de la task que toca `app-shell.tsx` — no es opcional, es un bug real ya diagnosticado y con solución conocida, solo pendiente de reconciliación entre ramas hermanas (el mismo problema de migraciones numeradas de forma independiente, aplicado a un componente compartido en vez de a SQL).

### Tamaño y margen — porcentuales, no en píxeles

El slider de "tamaño" del mockup es un porcentaje, no píxeles absolutos — coherente con soportar creativos de tamaños distintos (feed vs. story vs. cuadrado) sin hardcodear 1080×1350. El tamaño del logo se calcula como % del **lado más corto** del creativo (para que el mismo % se vea proporcional sin importar la orientación), preservando el aspect ratio natural del logo. El margen usa la misma base (% del lado más corto).

### Formato de salida

**Corrección tras revisión de Codex CLI ronda 1:** la versión anterior
no especificaba cómo se propaga el formato de salida a
`compositeToBlob`, ni qué pasa con WEBP (aceptado como entrada por el
dropzone) ni la calidad JPEG. Decisión explícita: la entrada acepta
`.png`/`.jpg`/`.jpeg`/`.webp`, pero la **salida** solo usa dos formatos,
nunca WEBP — un PNG de entrada exporta PNG (sin pérdida, preserva
transparencia si la tuviera), y tanto JPEG como WEBP de entrada exportan
JPEG con calidad `0.92` (evita depender de que el navegador soporte
`canvas.toBlob("image/webp")` en exportación, que no es universal —
convertir WEBP de entrada a JPEG de salida evita ese riesgo por
completo, a cambio de una posible pérdida de calidad mínima que es
aceptable para un creativo de anuncio). El logo en sí **debe** ser PNG (se valida el MIME type en la subida; es un requisito real para que el canal alfa funcione).

### Límite de tamaño de lote

Se propone un límite de 30 creativos por lote (constante nombrada, p. ej. `MAX_BATCH_SIZE`, no un número mágico repetido) — cada composite mantiene la imagen a resolución completa en memoria del navegador durante el procesamiento; sin límite, un lote muy grande podría agotar memoria o congelar la pestaña. 30 es una cifra de partida razonable (una tanda típica de creativos para una sola campaña no debería acercarse a eso) — no es un límite técnico duro derivado de una medición real, así que la revisión de Codex CLI debe confirmar si es sensata o debe ajustarse antes de fijarla en el plan. Se agrega también un límite por archivo individual (p. ej. 10 MB por creativo) — sin esto, un solo archivo enorme dentro de un lote pequeño podría causar el mismo problema de memoria que el límite de cantidad busca evitar.

### Nombres de archivo dentro del ZIP

Los nombres originales (saneados, mismo patrón de sanitización que `lib/supabase/repository.ts:556-559`) se preservan dentro del ZIP — pero dos creativos distintos podrían compartir el mismo nombre de archivo (p. ej. dos capturas descargadas como `imagen.jpg`). Antes de agregar cada entrada al ZIP, se detectan colisiones y se les agrega un sufijo numérico (`imagen.jpg`, `imagen-2.jpg`) para que ningún archivo se sobrescriba silenciosamente dentro del ZIP.

**Corrección tras revisión de Codex CLI ronda 2 (bug real: extensión
inconsistente con el contenido):** dado que la sección "Formato de
salida" define que un WEBP de entrada exporta como JPEG, el nombre
dentro del ZIP debe reflejar el formato real de salida, no el nombre
original — `foto.webp` de entrada se escribe como `foto.jpg` en el ZIP
(la extensión se deriva de `outputFormat`, no del nombre del archivo
original), o el archivo resultante mentiría sobre su propio contenido
byte a byte.

**Orden correcto — corrección tras revisión de Codex CLI ronda 3 (bug
real, no cosmético):** la detección de colisiones debe correr **después**
de convertir cada nombre a su extensión de salida final, no sobre los
nombres originales. Si se detectaran colisiones primero (sobre
`foto.webp` y `foto.jpg`, dos nombres originales distintos, sin
colisión aparente) y solo después se convirtiera la extensión, ambos
terminarían como `foto.jpg` sin que la deduplicación los hubiera
detectado — exactamente la colisión silenciosa que este mecanismo
existe para evitar. `export-zip.ts` primero calcula el nombre de salida
final de cada archivo (extensión según `outputFormat`), y solo entonces
aplica la deduplicación sobre esa lista ya convertida.

### Sin URL firmada expuesta al cliente (obsoleto tras el rediseño de ronda 3)

A diferencia de `content-assets` (donde el cliente sí recibe y usa una URL firmada con expiración de 10 minutos), el rediseño de proxy same-origin de la sección "canvas tainted por CORS" arriba elimina esta preocupación por completo: el navegador nunca ve una URL firmada de Supabase — solo `/api/organizations/{id}/logo`, una ruta propia de la app sin expiración. Cada request a esa ruta resuelve el objeto de Storage server-side, en el momento, sin caché de por medio.

## Manejo de errores

- Falla al cargar el logo actual (bucket vacío para esa organización): estado normal "todavía no subiste un logo", no un error — ver "Persistencia del logo" arriba.
- Un archivo corrupto o no soportado dentro de un lote de N: se omite ese archivo con un mensaje visible por archivo, sin abortar el resto del lote — igual que el patrón de aislamiento de errores por id ya usado en `useAttentionTargets` (rama de navegación) para `getContentRecord`.
- Subida de un logo que no es PNG: rechazo inmediato en el cliente antes de llamar a la API, con mensaje claro.
- Falla al exportar el ZIP (memoria, navegador no soporta `Blob`/`URL.createObjectURL`): mensaje de error visible, no un cuelgue silencioso.

## Testing

- `computeLogoPlacement()` (lib/logo-studio/compose.ts): tests puros por cada una de las 4 esquinas, tamaños/márgenes distintos, un caso de aspect ratio no cuadrado del logo (confirma que se preserva), el clamp de tamaño extremo (logo muy alto/angosto en `sizePercent` máximo no excede el creativo en ninguna dimensión), y el guard nuevo de `logoNaturalWidth`/`logoNaturalHeight` en `0` (lanza, no divide por cero — hallazgo de ronda 2).
- `compositeToBlob()`: tests con `HTMLCanvasElement.prototype.getContext`/`toBlob` mockeados y objetos `{ naturalWidth, naturalHeight }` castedos como `HTMLImageElement` en vez de instancias reales de `Image` (jsdom no las decodifica — hallazgo de ronda 2); confirma que el `drawImage` mockeado recibe las coordenadas que predice `computeLogoPlacement`. **Corrección tras revisión de Codex CLI ronda 3:** `compositeToBlob()` no recibe ni devuelve ningún nombre de archivo (solo un `Blob`) — la aserción sobre la extensión final (WEBP → `.jpg`) no le corresponde a este test, sino al de `export-zip.ts` (ver abajo), que es quien combina cada `Blob` con su nombre de salida.
- Test de API route (`app/api/organizations/[id]/logo/route.ts`): auth/scoping por organización (un usuario no puede subir/leer el logo de otra organización), rol `owner`-únicamente para `POST` (un `editor`/`viewer` recibe `403`), `upsert` permite reemplazar, `GET` sin logo previo responde `404 LOGO_NOT_CONFIGURED` distinguible de un `503` real, subida con bytes que no son un PNG real responde `422 INVALID_LOGO_FORMAT` aunque el `Content-Type` declarado diga `image/png`.
- `export-zip.ts` (nuevo bullet, corrección tras revisión de Codex CLI ronda 3 — la aserción de extensión vivía en el bullet equivocado): dado un nombre original `foto.webp` con `outputFormat: "image/jpeg"`, el nombre final dentro del ZIP es `foto.jpg`, no `foto.webp`; dos archivos que colisionan solo DESPUÉS de convertir su extensión (`foto.webp` y `foto.jpg` de entrada, ambos con salida JPEG) se deduplican correctamente (`foto.jpg`, `foto-2.jpg`) — prueba explícita del orden correcto (conversión de extensión antes que deduplicación).
- Test de componente: `CreativeBatchDropzone` acepta múltiples archivos, rechaza tipos no soportados; `LogoUploadPanel` rechaza un logo no-PNG; el flujo completo (cargar logo + N creativos + exportar) dispara la descarga del ZIP con el número correcto de archivos dentro (se puede inspeccionar el `Blob` del ZIP generado con `jszip` mismo, en el test, para confirmar cuántas entradas tiene; requiere mockear `URL.createObjectURL`/`URL.revokeObjectURL`, no implementados de forma útil en jsdom — hallazgo de ronda 2); cambiar de organización en el switcher local de la página vuelve a pedir el logo de la nueva organización activa (hallazgo de ronda 2); solo se renderiza un switcher de organización en esta página, no dos (hallazgo de ronda 3).
- Test de `app-shell.tsx`: el nuevo link "Logo Studio" aparece con el ícono `image`; el layout flex-column (portado desde la rama de navegación) no solapa el panel "Estado del sistema" con las 7 entradas de nav de esta rama — replicar el mismo test/verificación manual en navegador que encontró el bug original (verificación visual real en navegador, no una aserción jsdom — jsdom no renderiza layout/posicionamiento CSS real).
