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
- `app/api/organizations/` ya tiene tres rutas: `route.ts` (listado),
  `active/route.ts`, y `[id]/profile/route.ts` — esta última es el
  patrón más cercano a lo que esta feature necesita (una ruta
  `[id]/algo` con verificación de membership y rol). Su secuencia exacta
  (`app/api/organizations/[id]/profile/route.ts:149-189`): valida el
  UUID de la organización con zod, resuelve la sesión vía
  `supabase.auth.getUser()`, resuelve membership vía
  `organization_members` (`organization_id` + `user_id` → `role`), y
  solo entonces aplica el gate de rol específico de la operación
  (`canEditCampaign` en ese caso). Responde con `jsonError`/`jsonOk` y
  headers `Cache-Control: no-store`. La nueva ruta de logo sigue esta
  misma secuencia.
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

**Corrección tras revisión de Codex CLI ronda 1 (gap real de testing):**
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
sin necesitar un canvas real. `computeLogoPlacement` se prueba aparte,
sin ningún mock, como función pura.
- `lib/logo-studio/export-zip.ts` — envuelve `jszip` (dependencia nueva) para empaquetar N blobs en un ZIP y disparar la descarga (`URL.createObjectURL` + un `<a download>` sintético — patrón estándar, sin librería adicional).
- `app/api/organizations/[id]/logo/route.ts` — `POST` (subir/reemplazar) y `GET` (obtener URL firmada actual, o 404 si no hay logo todavía). Mismo patrón de auth/scoping por organización que las demás rutas de `app/api/organizations/`.
- `supabase/migrations/0018_organization_logos_bucket.sql` — crea el bucket `organization-logos` (privado, igual que `content-assets`) + políticas RLS equivalentes a las de ese bucket, escopeadas por organización.

### Persistencia del logo — sin tabla nueva (decisión YAGNI)

El logo de cada organización vive en una ruta **fija y predecible**: `{organization_id}/logo.png` dentro del bucket `organization-logos`, con `upsert: true` (a diferencia de `content-assets`, que es inmutable — un logo sí debe poder reemplazarse). No hace falta una tabla ni columna nueva para "saber" si una organización tiene logo: el cliente simplemente intenta `createSignedUrl` sobre esa ruta fija; un error de "objeto no encontrado" se interpreta como "todavía no hay logo" (estado inicial normal, no un error real). Esto evita una migración con tabla nueva para lo que es fundamentalmente un mapeo 1:1 organización→archivo ya expresable por convención de ruta — pero **sí** hace falta una migración para el bucket y sus políticas RLS.

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
  );

create policy "Organization owners replace organization logos" on storage.objects
  for update to authenticated using (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
  ) with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
  );
```

Lectura abierta a cualquier miembro de la organización (ver el logo actual no es sensible); subir/reemplazar restringido a `owner` — el logo es una decisión de marca a nivel organización, afecta todas las publicaciones futuras, así que se trata con el mismo nivel de restricción que gestionar la conexión de Meta (`canManageConnections`, también owner-únicamente), no con el nivel más permisivo de editar una campaña individual (`canEditCampaign`, owner|editor).

### Ruta de API

`app/api/organizations/[id]/logo/route.ts` sigue exactamente la secuencia de `app/api/organizations/[id]/profile/route.ts:149-189` (validar UUID con zod → `supabase.auth.getUser()` → resolver membership vía `organization_members` → aplicar el gate de rol → `jsonError`/`jsonOk` con `Cache-Control: no-store`), con estas diferencias específicas de esta feature:

- `POST` (subir/reemplazar): `Content-Type: multipart/form-data`, no JSON — se lee vía `request.formData()`, no `request.text()`/`JSON.parse`. Límite de tamaño: **5 MB** por archivo (un logo PNG razonable nunca se acerca a eso; es una cota de seguridad, no un límite ajustado a un caso real — igual que el límite de 30 creativos por lote, advisory, la revisión de plan puede ajustarlo). Validación server-side del MIME type real del archivo (no solo confiar en la extensión o el `Content-Type` declarado por el cliente) antes de subir a Storage. Rol requerido: `canManageConnections(membership.role)` (owner-únicamente — reutilizada tal cual de `lib/organizations/permissions.ts`; el nombre referencia "connections" porque se escribió para el caso de Meta OAuth, pero la restricción real que expresa — owner-únicamente para configuración a nivel organización — aplica igual de bien aquí; no se crea una función de permiso nueva solo para diferenciar el nombre, sería una duplicación sin diferencia funcional).
- `GET` (obtener la URL firmada actual): sin gate de rol adicional más allá de la membership — cualquier miembro puede ver el logo actual. Debe distinguir explícitamente "no hay logo todavía" (`404` con un código de error específico, p. ej. `LOGO_NOT_CONFIGURED` — un estado esperado, no un fallo) de un error real de Storage (`503`).

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

### URL firmada del logo — expiración durante la sesión (tradeoff aceptado)

Igual que `content-assets`, la URL firmada del logo se re-obtiene en cada carga de página (sin caché especial) — si expira mientras la página sigue abierta (10 minutos), el `<img>` del logo dejaría de cargar hasta refrescar. Se acepta este tradeoff deliberadamente por consistencia con el patrón ya establecido, en vez de construir un mecanismo de renovación automática solo para este caso — la ventana de 10 minutos es suficiente para una sesión típica de "revisar/reemplazar el logo y seguir".

## Manejo de errores

- Falla al cargar el logo actual (bucket vacío para esa organización): estado normal "todavía no subiste un logo", no un error — ver "Persistencia del logo" arriba.
- Un archivo corrupto o no soportado dentro de un lote de N: se omite ese archivo con un mensaje visible por archivo, sin abortar el resto del lote — igual que el patrón de aislamiento de errores por id ya usado en `useAttentionTargets` (rama de navegación) para `getContentRecord`.
- Subida de un logo que no es PNG: rechazo inmediato en el cliente antes de llamar a la API, con mensaje claro.
- Falla al exportar el ZIP (memoria, navegador no soporta `Blob`/`URL.createObjectURL`): mensaje de error visible, no un cuelgue silencioso.

## Testing

- `computeLogoPlacement()` (lib/logo-studio/compose.ts): tests puros por cada una de las 4 esquinas, tamaños/márgenes distintos, y un caso de aspect ratio no cuadrado del logo (confirma que se preserva).
- Test de API route (`app/api/organizations/[id]/logo/route.ts`): auth/scoping por organización (un usuario no puede subir/leer el logo de otra organización), `upsert: true` permite reemplazar, `GET` sin logo previo responde de forma distinguible de un error real.
- Test de componente: `CreativeBatchDropzone` acepta múltiples archivos, rechaza tipos no soportados; `LogoUploadPanel` rechaza un logo no-PNG; el flujo completo (cargar logo + N creativos + exportar) dispara la descarga del ZIP con el número correcto de archivos dentro (se puede inspeccionar el `Blob` del ZIP generado con `jszip` mismo, en el test, para confirmar cuántas entradas tiene).
- Test de `app-shell.tsx`: el nuevo link "Logo Studio" aparece con el ícono `image`; el layout flex-column (portado desde la rama de navegación) no solapa el panel "Estado del sistema" con las 7 entradas de nav de esta rama — replicar el mismo test/verificación manual en navegador que encontró el bug original.
