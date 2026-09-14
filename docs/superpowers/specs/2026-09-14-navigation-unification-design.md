# Unificación de navegación y vista de campaña — diseño

**Fecha:** 2026-09-14 (revisión 2, tras ronda 1 de revisión con Codex CLI — corrigió una premisa arquitectónica equivocada, ver notas inline)
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

Se elige la definición a **nivel target**, la de `/review` en producción,
no la de `/library`: **un content item aparece en "por revisar" si tiene
al menos un `publication_target` en `PENDING_REVIEW` o `ERROR`.**

Razón: con ADR-008, la mayoría de las publicaciones se auto-aprueban; lo
que de verdad necesita ojos humanos es una decisión pendiente o un error
real por plataforma — exactamente lo que el estado del *target* captura.
El filtro viejo de `/library` (a nivel *content item*: `DRAFT`, `REVIEW`,
`REJECTED`, `ERROR`) mezclaba tres cosas distintas bajo una sola etiqueta:
`DRAFT` es "todavía no se envió a revisión" (trabajo en progreso, no
bloqueado por nadie), `REJECTED` es un estado cerrado (un humano ya
decidió, no hay nada que hacer), y solo `REVIEW`/`ERROR` son
genuinamente accionables. Bajo el nuevo predicado, los content items en
`DRAFT`/`REJECTED` simplemente aparecen en el filtro "Todas" sin ninguna
marca especial de urgencia — es más preciso, no una pérdida de
información.

La inconsistencia demo/producción que ya existe en `/review` (demo solo
considera `PENDING_REVIEW`, producción también `ERROR`) se corrige de
paso: ambos modos usan el mismo predicado (`PENDING_REVIEW` o `ERROR`).

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
   nuevo, `hasActionableTarget: boolean` — calculado del lado del
   servidor en la misma consulta que ya arma el resumen (un
   `exists(...)` contra `publication_targets` filtrando
   `status in ('PENDING_REVIEW', 'ERROR')` para ese `content_item_id`, o
   el equivalente que ya use el repositorio Supabase para consultas
   agregadas — revisar el patrón existente antes de escribir SQL nueva).
   Este campo es la única pieza de información de nivel-target que la
   vista por defecto necesita: le basta para saber CUÁLES campañas
   pertenecen al filtro "por revisar" sin traer el detalle de ninguna.
2. `/library/page.tsx` sigue llamando `listContentSummaries()` como hoy
   para los cuatro filtros — "por revisar" ahora filtra sobre
   `hasActionableTarget` en vez de `state`.
3. **Solo cuando el filtro activo es `attention`**, la página hace un
   segundo fetch, `getContentRecord()`, pero limitado a los ids que ya
   pasaron el filtro (no a todas las campañas) — para obtener sus
   `targets` reales y renderizar `PublicationTargets` (ya existe,
   `components/content/publication-targets.tsx`, mismas props que usa
   `/review` hoy, no se reescribe ese componente) inline en cada tarjeta.
   El polling de 4s que hoy tiene `/drafts` mientras algo está
   `GENERATING` se conserva, pero acotado a ese mismo subconjunto — no a
   toda la lista.
4. Se extrae un hook compartido, `useAttentionTargets(contentItemIds)`
   (nuevo, `lib/content/use-attention-targets.ts`) que encapsula el paso 3
   — es el único fetch que de verdad se duplicaba entre `/drafts` y
   `/review` (ambos hacían `Promise.all(getContentRecord)` con distinta
   forma de uso); no se crea un hook genérico "unificado" para
   `listContentSummaries()`, que ya es simple y no se duplica en ningún
   otro lado tras los redirects.

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
`/review` como página — solo tests del componente `PublicationTargets` en
aislamiento. Los tests nuevos de abajo se escriben desde cero siguiendo el
mismo patrón de test de página que ya usan `tests/` para `/library`/
`/drafts` (mock de `fetch`, modo demo vs. producción), no se "mueven"
aserciones de un archivo que no existe.

- Test de la migración/repositorio: `listContentSummaries()` incluye
  `hasActionableTarget` correctamente calculado (con al menos un caso de
  target `PENDING_REVIEW`, uno `ERROR`, y uno sin ningún target
  accionable).
- Test del hook `useAttentionTargets` (nuevo): dado un arreglo de ids,
  hace `getContentRecord()` solo para esos ids (no para todos), hace
  polling cada 4s mientras alguno esté `GENERATING`, deja de hacer
  polling cuando ninguno lo está.
- Tests de `/library` extendidos: filtro `attention` usa
  `hasActionableTarget` (no `state`); al activarlo, dispara el fetch de
  detalle solo para esos ids y muestra `PublicationTargets` inline,
  permitiendo aprobar/reintentar; los otros tres filtros siguen usando
  solo `listContentSummaries()`, sin el fetch de detalle.
- Tests de redirect: `/drafts` → `/library`, `/review` → `/library?filter=attention`.
- Test de `app-shell.tsx`: el nuevo link de Configuración aparece en el nav con el ícono `settings`; el texto del sidebar ya no dice "siempre requiere".
