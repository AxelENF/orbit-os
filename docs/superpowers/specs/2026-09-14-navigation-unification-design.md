# Unificación de navegación y vista de campaña — diseño

**Fecha:** 2026-09-14
**Estado:** Aprobado por Axel de forma anticipada — sesión autónoma ("delega más activamente, haz más cosas para llevar esto al mejor nivel"). Decisiones documentadas con su razonamiento para revisión posterior.
**Roadmap:** Segundo ítem del orden de 4 partes acordado el 2026-09-14 (intake ✅ → **arquitectura de información/navegación** → compositor de logo → capa MCP). El dashboard de resultados (otro hallazgo de la misma sesión) se separa como su propio spec siguiente — es una capacidad nueva (renderizar datos que hoy no se muestran en ningún lado), no una corrección de navegación fragmentada, y merece su propio ciclo de diseño en vez de inflar este.

## Contexto

Análisis directo del código (no supuesto) de las 6 páginas de navegación
principal más 2 páginas alcanzables solo por URL directa, hecho en esta
misma sesión:

- **`/library`, `/drafts`, `/review` son tres listas separadas del mismo
  `content_items`** — cada una hace su propio fetch (`listContentItems` +
  `getContentRecord` por item), su propio filtro, y su propio lenguaje
  visual. `/library` muestra todas; `/drafts` muestra prácticamente lo
  mismo con otra tarjeta; `/review` muestra solo las accionables
  (`PENDING_REVIEW`/`ERROR`) con los controles de aprobar/reintentar
  inline. Las tres enlazan al mismo destino de detalle, `/drafts/[id]`.
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

**Una sola fuente de datos, reusada por la única página de lista.**
`lib/content/client.ts` ya tiene `listContentItems`/`getContentRecord` —
el patrón `Promise.all(items.map(getContentRecord))` que hoy se repite
tres veces (en `library`, `drafts`, `review`) se extrae a un hook
compartido `useContentRecords()` (nuevo, `lib/content/use-content-records.ts`
o similar — un hook porque las tres páginas ya usan el mismo patrón de
`useState`+`useEffect`+polling, extraerlo elimina la triplicación real,
no es abstracción prematura).

`/library/page.tsx` se reescribe para:
- Leer un query param `?filter=` (`all` | `attention` | `scheduled` | `published`), default `all` — mismo set de valores que ya usan los tabs actuales, ahora también accesible por URL directa (necesario para que `/review` pueda redirigir a `?filter=attention` conservando la intención del link viejo).
- Cuando el filtro es `attention` (equivalente al `/review` de hoy), cada tarjeta de campaña con un target `PENDING_REVIEW`/`ERROR` muestra el componente `PublicationTargets` (ya existe, `components/content/publication-targets.tsx`) inline, igual que `/review` lo hace hoy — mismas props, mismo componente, no se reescribe esa pieza.
- El resto de los filtros se comportan como hoy en `/library`.

`app/(app)/drafts/page.tsx` y `app/(app)/review/page.tsx` (las páginas de
LISTA) se reemplazan por un `redirect()` de servidor a
`/library` y `/library?filter=attention` respectivamente — no se borran
los archivos de golpe sin dejar rastro para links viejos que alguien
tenga guardados.

`components/layout/app-shell.tsx`:
- Se agrega `{ href: "/settings/organizations", label: "Configuración", eyebrow: "Organización", icon: "..." }` al arreglo `navigation`.
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

Sin cambios de comportamiento de error respecto a lo que cada página ya
hace hoy — se está consolidando la MISMA lógica de fetch/estado de
carga/estado vacío que las tres páginas ya implementan por separado, no
inventando una nueva. El hook compartido expone el mismo shape
(`isLoading`, `records`, `error`) que cada página ya maneja hoy con su
propio `useState`.

## Testing

- Test del hook `useContentRecords` (nuevo): carga inicial, polling
  mientras hay algún registro `GENERATING` (mismo comportamiento que
  `/drafts` ya tiene hoy — revisar `app/(app)/drafts/page.tsx:44-68` como
  referencia exacta de la lógica de polling a extraer), modo demo vs.
  producción.
- Tests de `/library` extendidos: el filtro `attention` muestra
  `PublicationTargets` inline y permite aprobar/reintentar (mismas
  aserciones de comportamiento que hoy tiene el test de `/review`,
  movidas).
- Tests de redirect: `/drafts` → `/library`, `/review` → `/library?filter=attention`.
- Test de `app-shell.tsx`: el nuevo link de Configuración aparece en el nav; el texto del sidebar ya no dice "siempre requiere".
