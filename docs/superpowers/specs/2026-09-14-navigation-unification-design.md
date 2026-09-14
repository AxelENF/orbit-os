# Unificación de navegación y vista de campaña — diseño

**Fecha:** 2026-09-14 (revisión 3, tras ronda 2 de revisión con Codex CLI — corrigió el ciclo de vida del predicado de "por revisar", la fuente de datos demo, el polling y la sincronización tras aprobar/reintentar; ver notas inline)
**Estado:** Aprobado por Axel de forma anticipada — sesión autónoma ("delega más activamente, haz más cosas para llevar esto al mejor nivel"). Decisiones documentadas con su razonamiento para revisión posterior.
**Roadmap:** Segundo ítem del orden de 4 partes acordado el 2026-09-14 (intake ✅ → **arquitectura de información/navegación** → compositor de logo → capa MCP). El dashboard de resultados (otro hallazgo de la misma sesión) se separa como su propio spec siguiente — es una capacidad nueva (renderizar datos que hoy no se muestran en ningún lado), no una corrección de navegación fragmentada, y merece su propio ciclo de diseño en vez de inflar este.

## Contexto

Análisis directo del código (no supuesto) de las 6 páginas de navegación
principal más 2 páginas alcanzables solo por URL directa, hecho en esta
misma sesión:

- **`/library`, `/drafts`, `/review` son tres listas separadas del mismo
  `content_items`, pero con arquitecturas de datos realmente distintas**
  (corregido tras revisión de Codex CLI ronda 1 — la versión anterior de
  este párrafo decía que las tres hacían el mismo fetch pesado, es falso):
  - `/library` llama `listContentSummaries()` — un fetch liviano, sin
    `targets` ni detalle por item, sin polling. Filtra "por revisar"
    usando `content_items.state` (`DRAFT`/`REVIEW`/`REJECTED`/`ERROR`).
    En modo demo, sus tarjetas **no enlazan** a ningún detalle.
  - `/drafts` llama `getContentRecord()` por cada item (fetch completo,
    con `targets`) y hace **polling cada 4 segundos** mientras algún item
    esté `GENERATING`. Enlaza a `/drafts/[id]` en ambos modos.
  - `/review` también llama `getContentRecord()` por item (fetch
    completo), sin polling. Filtra usando `publication_targets[].status`
    (`PENDING_REVIEW`/`ERROR` en producción; **solo `PENDING_REVIEW` en
    demo**, una inconsistencia demo/producción que ya existe hoy). Muestra
    `PublicationTargets` inline para aprobar/reintentar, pero **no enlaza**
    al detalle en producción.
  - Es decir: "por revisar" no es un único concepto hoy — `/library` lo
    define a nivel *content item* (incluye borradores sin enviar a
    revisión y rechazados, que no son realmente accionables) y `/review`
    lo define a nivel *target* (una decisión pendiente o un error real por
    plataforma). Este spec tiene que elegir **una** definición, no solo
    "juntar el código" — ver "Predicado único de 'por revisar'" abajo.
- **`app-shell.tsx`** (el nav principal) tiene 6 links: Inicio, Campañas
  (`/library`), Nueva campaña (`/library/new`), Revisión (`/review`),
  Resultados (`/history` — un log de auditoría, no una vista de
  resultados/métricas), Piloto (`/pilot`). `/drafts` y
  `/settings/organizations` **no están en el menú** — solo son
  alcanzables por link directo desde otra pantalla o URL manual. Esto
  incluye la UI de conexión de Meta que se construyó en la rama paralela
  `feat/meta-publisher-oauth-adapter` (base de esta rama) — hoy no tiene
  ninguna forma de descubrirse desde la navegación principal.
- **El copy del sidebar contradice ADR-008:** `app-shell.tsx` dice
  literalmente *"La publicación siempre requiere tu aprobación"* — eso es
  ADR-005, ya superseded. Es mentira operativa en la UI ahora mismo.

## Alcance

**Incluido:**
1. Unificar `/library`, `/drafts` y `/review` en una sola lista real —
   `/library` (ya es el nombre en el nav principal, "Campañas", se
   conserva). Filtros por tab (Todas / Por revisar / Programadas /
   Publicadas — los mismos 4 que `/library` ya tiene) siguen existiendo,
   pero ahora "Por revisar" muestra los controles de aprobar/reintentar
   inline en cada tarjeta, en vez de forzar navegar a una página aparte.
   `/drafts` y `/review` (las páginas de LISTA — no `/drafts/[id]`, que
   sigue siendo el detalle y no se toca) redirigen a `/library` con el
   filtro correspondiente.
2. Agregar `/settings/organizations` al nav principal (hoy solo alcanzable
   por link indirecto) — es donde ya vive la conexión de Meta.
3. Corregir el copy del sidebar para reflejar ADR-008.

**Explícitamente fuera de alcance:**
- El dashboard de resultados/métricas reales — spec aparte, siguiente.
- Cualquier cambio a `/drafts/[id]` (el detalle) — sigue siendo el mismo componente, solo cambia quién enlaza a él y cómo.
- Vista de calendario — hallazgo real de la sesión, pero no estaba en el orden de 4 partes acordado; se anota como candidato futuro, no se construye aquí.
- Modo demo — se mantiene el mismo patrón dual demo/producción que ya usa cada página hoy, no se unifica ni se elimina en este spec (sería una segunda reestructuración mezclada con esta).

## Arquitectura

### Predicado único de "por revisar" (decisión de producto, no solo de código)

**Corrección tras revisión de Codex CLI ronda 2 (bloqueador real):** la
versión anterior de esta sección proponía un predicado plano —
"tiene al menos un `publication_target` en `PENDING_REVIEW` o
`ERROR`" — verificado contra el código real, es incorrecto. La función
`create_content_item_with_asset` (`supabase/migrations/0006_create_content_item_with_asset.sql:53-57`)
inserta los dos `publication_targets` en `PENDING_REVIEW` en el momento
mismo en que se crea el content item — es decir, **todo content item no
terminal (`UPLOADED`, `GENERATING`, `DRAFT`, `REVIEW`) ya tiene targets
`PENDING_REVIEW` desde el primer instante**, no solo los que llegaron a
revisión. Un predicado plano marcaría como "por revisar" prácticamente
cualquier campaña en curso, incluida una que apenas se subió y que nadie
puede aprobar todavía — exactamente el bug que ambas páginas actuales
evitan hoy con un chequeo adicional: tanto `/review` en producción
(`app/(app)/review/page.tsx:107`, `disabled={... || record.content.state
!== "REVIEW"}`) como en demo (línea 139, mismo chequeo) deshabilitan el
control de aprobar mientras `content.state !== "REVIEW"`, aunque el
target ya esté `PENDING_REVIEW`.

**Predicado corregido, con dos condiciones independientes, no una sola:**

```
hasActionableTarget =
  (content.state === "REVIEW" && targets.some(t => t.status === "PENDING_REVIEW"))
  || targets.some(t => t.status === "ERROR")
```

- La mitad `PENDING_REVIEW` requiere `content.state === "REVIEW"` porque
  eso es exactamente lo que ya gatea el botón de aprobar hoy — antes de
  ese estado, el target existe pero no hay nada que un humano pueda
  decidir todavía (el copy ni siquiera se generó o no se envió a
  revisión).
- La mitad `ERROR` **no** requiere `content.state === "REVIEW"` a
  propósito: un target llega a `ERROR` después de haber sido aprobado y
  fallar su intento de publicación (vía el worker de `PUBLISH`, ver
  `worker/providers/meta-publish-processor.ts` en la rama base), momento
  en el que `content.state` ya avanzó a `APPROVED` — la máquina de
  estados de content items (`lib/content/state-machine.ts:16`) no tiene
  ninguna transición de vuelta a `REVIEW` para reflejar esto. Por eso
  `retryDisabled` en producción (`review/page.tsx:108`) solo depende de
  `!latestDraft`, nunca de `content.state`: reintentar un target en
  `ERROR` debe funcionar sin importar en qué estado quedó el content item.

**Sobre `DRAFT`/`REJECTED` — corrección de la razón dada en la revisión
anterior:** la afirmación "`DRAFT`/`REJECTED` no son accionables" era
imprecisa. `campaignNextAction()` (`lib/content/campaign-view.ts:16-27`)
les asigna una acción real: `DRAFT` → "Elegir copy", `REJECTED` →
"Corregir campaña" (vuelve a `DRAFT` por
`lib/content/state-machine.ts:19`). La razón correcta para excluirlos de
"por revisar" no es que no haya nada que hacer, sino que **no son una
decisión de aprobación pendiente** — su acción vive en `/drafts/[id]`
(elegir o reeditar copy), no en el flujo de aprobar/rechazar un target.
Bajo el predicado corregido siguen apareciendo sin marca especial en
"Todas", con su propio texto de siguiente-acción — no se pierde
información, se corrige la etiqueta.

**Modo demo — los targets nunca llegan a `ERROR`:** revisado
`lib/demo/draft-store.ts` completo: ninguna función local
(`approveDemoTarget`, `recordDemoManualPublicationDelivery`,
`recordDemoPublicationResult`) asigna `status: "ERROR"` a un target — no
existe un worker de publicación real en modo demo que pueda fallar. La
mitad `ERROR` del predicado es correcta de incluir por simetría con
producción, pero en la práctica siempre será `false` en demo — no hace
falta ninguna ruta de "reintentar" local nueva, porque no hay ningún
target en `ERROR` que reintentar. Si en el futuro se simula un fallo de
publicación en demo, esa ruta se añadiría entonces.

La inconsistencia demo/producción que ya existe en `/review` (demo solo
consideraba `PENDING_REVIEW`, producción también `ERROR`) se corrige de
paso: ambos modos usan el mismo predicado de dos condiciones.

### Dos niveles de datos, no uno — corrección tras revisión de Codex CLI

La versión anterior de este spec asumía que las tres páginas ya pagaban el
mismo costo de fetch y que bastaba con "unificar el hook". Falso:
`/library` es barata a propósito (`listContentSummaries()`, sin
`targets`). Forzar TODA la vista unificada a usar `getContentRecord()` por
item — el fetch caro — para poder aplicar el nuevo predicado de "por
revisar" (que necesita `targets[].status`) sería una regresión de
rendimiento real para el caso común (ver "Todas"/"Programadas"/
"Publicadas", que no necesitan `targets` en absoluto).

En vez de eso:

1. **`ContentSummary`** (`lib/content/repository.ts:46-50`) gana un campo
   nuevo, **requerido**, `hasActionableTarget: boolean`.
   **Corrección tras revisión de Codex CLI ronda 2:** el `exists(...)`
   propuesto en la revisión anterior no corresponde a ningún patrón real
   de este repositorio — verificado: `listContentSummaries()`
   (`lib/supabase/repository.ts:673-678`) es un único `select` plano
   contra `content_items`, sin joins ni subconsultas correlacionadas, y
   PostgREST (el cliente Supabase) no expresa ese tipo de subconsulta
   como columna calculada de todas formas. El patrón que este archivo sí
   usa para combinar datos de tablas relacionadas es el de
   `getContentRecord()` (`lib/supabase/repository.ts:732-776`): varias
   consultas planas en paralelo (`Promise.all`), unidas después en
   JavaScript. `listContentSummaries()` se extiende con el mismo patrón:
   una segunda consulta plana, en paralelo con la de `content_items`,
   contra `publication_targets` —
   `select content_item_id from publication_targets where
   organization_id = :org and status in ('PENDING_REVIEW', 'ERROR')` —
   cuyo resultado se reduce a un `Set<string>` de `content_item_id`s y se
   usa para poblar `hasActionableTarget` al mapear cada fila de
   `content_items`. Sin RPC nueva, sin vista SQL nueva — dos `select`s
   planos es exactamente el nivel de complejidad que este archivo ya usa
   en otros lados.
   - **Índice nuevo:** el único índice existente sobre esta tabla es
     `publication_targets_organization_content_item_id_idx` — cubre
     `(organization_id, content_item_id, platform)`
     (`supabase/migrations/0009_tenantize_content_and_jobs.sql:48`), no
     `status`. La nueva consulta filtra por `(organization_id, status)`,
     un prefijo distinto — se agrega una migración nueva y aditiva con
     `create index if not exists
     publication_targets_organization_status_idx on
     public.publication_targets (organization_id, status);`.
   - **Costo del campo requerido:** hacerlo requerido (no opcional) es
     intencional — evita que un futuro caller de `listContentSummaries()`
     olvide poblarlo silenciosamente. El costo real, verificado por
     grep: 7 archivos referencian `ContentSummary` hoy —
     `lib/supabase/repository.ts`, `lib/demo/repository.ts`,
     `lib/content/repository.ts` (la interfaz, se actualiza junto con el
     tipo), `lib/content/client.ts`, `app/(app)/library/page.tsx`,
     `lib/content/campaign-view.ts` (solo consume el tipo, no construye
     literales) y `tests/content/campaign-view.test.ts` (fixtures que sí
     construyen literales y necesitan el campo nuevo). La implementación
     en `lib/demo/repository.ts` (`DemoContentRepository`, usada por
     `createContentRepository()` vía `lib/content/repository-factory.ts`
     — el repositorio demo *server-side*, distinto del par
     `readDemoAssets()`/`readDemoDrafts()` de localStorage que usan las
     páginas directamente) también debe poblar el campo para seguir
     compilando contra la interfaz — se revisa su propio almacén interno
     de targets al implementarlo.
2. `/library/page.tsx` sigue llamando `listContentSummaries()` como hoy
   para los cuatro filtros — "por revisar" ahora filtra sobre
   `hasActionableTarget` en vez de `state`.
3. **Solo cuando el filtro activo es `attention`**, la página hace un
   segundo fetch, `getContentRecord()`, pero limitado a los ids que ya
   pasaron el filtro (no a todas las campañas) — para obtener sus
   `targets` reales y renderizar `PublicationTargets` (ya existe,
   `components/content/publication-targets.tsx`, mismas props que usa
   `/review` hoy — incluye `retryDisabled`, independiente de
   `content.state`, ver predicado arriba — no se reescribe ese
   componente) inline en cada tarjeta.
4. Se extrae un hook compartido, `useAttentionTargets(contentItemIds)`
   (nuevo, `lib/content/use-attention-targets.ts`) que encapsula el paso 3
   — es el único fetch que de verdad se duplicaba entre `/drafts` y
   `/review` (ambos hacían `Promise.all(getContentRecord)` con distinta
   forma de uso); no se crea un hook genérico "unificado" para
   `listContentSummaries()`, que ya es simple y no se duplica en ningún
   otro lado tras los redirects.

**Polling — corrección tras revisión de Codex CLI ronda 2 (bloqueador
real):** la revisión anterior afirmaba que el polling de 4s de
`/drafts` (mientras algún item está `GENERATING`) "se conserva" dentro
de `useAttentionTargets`. Es incorrecto: con el predicado corregido, un
item `GENERATING` nunca tiene `content.state === "REVIEW"`, así que
nunca entra al subconjunto de `attention` — si el polling solo viviera
ahí, dejaría de dispararse y la UI dejaría de reflejar cuándo termina la
generación. El polling se conserva en el nivel correcto: en el fetch
**base** de `/library/page.tsx` (el de `listContentSummaries()`, no el
de `useAttentionTargets`). Es correcto porque `ContentSummary.state` ya
incluye `GENERATING` sin necesitar `targets` — el fetch barato ya tiene
toda la información necesaria. Regla: si la respuesta de
`listContentSummaries()` incluye algún item con `state === "GENERATING"`,
se reprograma un refetch del mismo `listContentSummaries()` en 4s (mismo
intervalo y misma condición de parada que ya usa
`app/(app)/drafts/page.tsx:52-54` hoy, solo movido de `getContentRecord()`
en bulk a la consulta barata). Esto aplica independientemente del filtro
activo — igual que hoy, donde `/drafts` hace poll sin importar qué esté
mirando el usuario.

**Sincronización tras aprobar/reintentar — corrección tras revisión de
Codex CLI ronda 2 (bloqueador real):** no definida en la revisión
anterior. Cuando el approve/retry que expone `useAttentionTargets`
resuelve con éxito, deben pasar dos cosas, en este orden:
1. `useAttentionTargets` actualiza su propio estado local para ese
   `contentItemId` (mismo patrón que ya usa `handleProductionApprove` en
   `review/page.tsx:53-62` hoy: refetch de
   `getContentRecord(contentItemId)` y reemplazo puntual en el arreglo
   local) — así la tarjeta refleja el nuevo estado del target sin
   esperar nada más.
2. `/library/page.tsx` vuelve a llamar `listContentSummaries()` completo
   (el mismo fetch barato, no uno nuevo) — esto recalcula
   `hasActionableTarget` para todos los items y por lo tanto el contador
   "por revisar", y si la campaña aprobada ya no califica (su último
   target dejó de estar `PENDING_REVIEW`/`ERROR`), desaparece del filtro
   `attention` en el siguiente render sin necesidad de invalidación
   manual — el filtro ya deriva de `hasActionableTarget`, que ya viene
   recalculado.
No se introduce ninguna librería de cache/invalidación nueva (este
codebase no usa React Query ni SWR en ningún lado — confirmado en todas
las páginas leídas, todas usan `useState`/`useEffect` planos) — un
refetch completo tras una acción humana poco frecuente (aprobar/
reintentar, nunca por keystroke) es consistente con el patrón ya usado y
suficientemente barato.

`/library/page.tsx` acepta el filtro también como query param
`?filter=` (`all` | `attention` | `scheduled` | `published`) además del
estado de tab en memoria que ya tiene — necesario para que `/review`
pueda redirigir a `?filter=attention` conservando la intención del link
viejo.

`app/(app)/drafts/page.tsx` y `app/(app)/review/page.tsx` (las páginas de
LISTA, no `/drafts/[id]`) se reemplazan por un `redirect()` de servidor
(`next/navigation`) a `/library` y `/library?filter=attention`
respectivamente. **Nota:** este codebase no tiene un precedente de
`redirect()` de `next/navigation` en una página — los redirects
existentes son `Response` 302 (callback de OAuth de Meta) y
`NextResponse.redirect()` (middleware, `proxy.ts`). Es una convención
nueva pero estándar de Next.js App Router, no un patrón inventado.

**Modo demo — corrección tras revisión de Codex CLI ronda 2 (bloqueador
real):** la revisión anterior no especificaba la fuente demo de la vista
unificada, y asumir `getContentRecord()` como sustituto habría sido un
error — verificado: en modo demo esa función llama al repositorio
server-side en memoria (`DemoContentRepository`), completamente separado
del `localStorage` del navegador que usan hoy `/library`
(`readDemoAssets()`), `/drafts` y `/review` (ambas `readDemoDrafts()`).
Fuente unificada elegida: **`readDemoDrafts()`**, no `readDemoAssets()`
— verificado en `lib/demo/draft-store.ts:184-190`, `readDemoDrafts()` ya
es un superconjunto: internamente llama `readDemoAssets()` y
"materializa" un `DemoDraftRecord` (que incluye `targets`) para
cualquier asset que todavía no tenga uno. Consecuencia práctica buena:
en modo demo **no hace falta ningún segundo fetch** — a diferencia de
producción, `readDemoDrafts()` ya trae `targets` para cada item en una
sola llamada síncrona a `localStorage`, así que `useAttentionTargets` no
se invoca en modo demo; `hasActionableTarget` y el render de
`PublicationTargets` para el filtro `attention` se calculan directamente
del mismo arreglo ya cargado (mismo predicado de dos condiciones de
arriba, evaluado en el cliente). Las tarjetas demo de `/library` ganan
el link a `/drafts/${id}` que hoy les falta (hallazgo de ronda 1) —
natural ahora que la fuente es `readDemoDrafts()`, la misma que ya usan
`/drafts` y `/review` para ese link.

`components/layout/app-icon.tsx`: se agrega un ícono nuevo, `settings`
(engranaje simple, mismo estilo `stroke`/`viewBox 0 0 24 24` que los
demás), a `IconName` y al record `paths` — ningún ícono existente
(`home`, `campaigns`, `plus`, `review`, `results`, `chevron`, `spark`,
`menu`, `close`, `arrow`, `check`) es semánticamente correcto para
"Configuración".

`components/layout/app-shell.tsx`:
- Se agrega `{ href: "/settings/organizations", label: "Configuración", eyebrow: "Organización", icon: "settings" }` al arreglo `navigation`.
- Se corrige el texto fijo `"La publicación siempre requiere tu aprobación."` a algo consistente con ADR-008 (ver "Contenido exacto" abajo).

## Contenido exacto de los textos a corregir

Actual (línea ~84 de `app-shell.tsx`):
```
La publicación siempre requiere tu aprobación.
```
Nuevo:
```
Publicamos automático cuando el diagnóstico no marca riesgo; si lo marca, pedimos tu aprobación.
```
(Mismo tono conciso que el resto del sidebar, refleja ADR-008 con precisión sin prometer de más — "cuando el diagnóstico no marca riesgo" es literal, no una simplificación falsa.)

## Manejo de errores

`listContentSummaries()` conserva su manejo de error actual de `/library`
(estado vacío + mensaje) sin cambios — es la ruta por defecto y no se
toca su comportamiento de falla. `useAttentionTargets` (el fetch nuevo,
acotado) sigue el mismo patrón que `/review` ya usa hoy para su fetch de
detalle: si `getContentRecord()` falla para algún id, ese id se omite de
la vista de "por revisar" con un error visible, sin tumbar el resto de la
lista (que ya cargó por `listContentSummaries()` de forma independiente).

## Testing

**Corrección tras revisión de Codex CLI:** no existe hoy ningún test de
`/review` **ni de `/library`** como página — solo tests del componente
`PublicationTargets` en aislamiento y de `/drafts`
(`tests/components/drafts-page.test.tsx`). **Corrección adicional tras
ronda 2:** la frase "tests de `/library` extendidos" de la revisión
anterior también era falsa, por la misma razón — no hay ningún archivo
de test de página para `/library` hoy tampoco. Los tests nuevos de abajo
se escriben desde cero para ambas páginas, siguiendo el mismo patrón de
test de página que ya usa `tests/components/drafts-page.test.tsx` (mock
de `fetch`, modo demo vs. producción).

- Test de repositorio: `listContentSummaries()` incluye
  `hasActionableTarget` correctamente calculado, cubriendo explícitamente
  los casos del predicado corregido (no el plano descartado):
  - target `PENDING_REVIEW` + `content.state === "REVIEW"` → `true`.
  - target `PENDING_REVIEW` + `content.state` en `UPLOADED`/`GENERATING`/
    `DRAFT` → `false` (el caso que el predicado plano original marcaba
    mal — es la regresión que esta corrección existe para prevenir).
  - target `ERROR` + `content.state === "APPROVED"` (o cualquier estado
    distinto de `REVIEW`) → `true` (retry no depende de `content.state`).
  - sin ningún target `PENDING_REVIEW`/`ERROR` → `false`.
- Test de fixtures: actualizar `tests/content/campaign-view.test.ts` y
  cualquier otro literal `ContentSummary` encontrado por grep para
  incluir el campo nuevo (ver "Costo del campo requerido" arriba).
- Test del hook `useAttentionTargets` (nuevo): dado un arreglo de ids,
  hace `getContentRecord()` solo para esos ids (no para todos); tras un
  approve/retry exitoso, actualiza su estado local para ese id sin
  refetch de los demás.
- Test de polling: `/library/page.tsx` reprograma `listContentSummaries()`
  cada 4s mientras la respuesta incluya algún item `GENERATING`,
  independientemente del filtro activo; deja de hacerlo cuando ninguno
  lo está.
- Test de sincronización (nuevo, cubre el hallazgo de ronda 2): aprobar
  el último target `PENDING_REVIEW`/`ERROR` de una campaña dispara un
  refetch de `listContentSummaries()`; en el resultado siguiente esa
  campaña ya no aparece en el filtro `attention` y el contador "por
  revisar" baja en uno, sin recargar la página.
- Tests de `/library`: filtro `attention` usa `hasActionableTarget` (no
  `state`); al activarlo, dispara el fetch de detalle solo para esos ids
  y muestra `PublicationTargets` inline, permitiendo aprobar/reintentar;
  los otros tres filtros siguen usando solo `listContentSummaries()`, sin
  el fetch de detalle. En modo demo, la fuente es `readDemoDrafts()` (no
  `readDemoAssets()`) y no dispara ningún fetch adicional al activar
  `attention` — los `targets` ya están cargados.
- Tests de redirect: `/drafts` → `/library`, `/review` → `/library?filter=attention`.
- Test de `app-shell.tsx`: el nuevo link de Configuración aparece en el nav con el ícono `settings`; el texto del sidebar ya no dice "siempre requiere".
