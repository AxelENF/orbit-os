# Meta publisher real: OAuth + adaptador Graph API — diseño

**Fecha:** 2026-09-13 (revisión 3, tras dos rondas de revisión con Codex CLI)
**Estado:** Borrador para revisión
**Roadmap:** Item 1 de `docs/vault/06-marketing-automation-handoff.md` (bloqueador de los items 2-4)
**Decisión de producto asumida:** ADR-008 (`docs/vault/02-decisions.md`) — publicación automática con el diagnóstico determinista como red de seguridad.

## Contexto

Hoy `lib/integrations/meta-publisher.ts` es exclusivamente un boundary de
configuración: verifica que existan las variables `META_APP_ID`,
`META_APP_SECRET`, `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN` y no construye
ningún cliente HTTP ni llama a Meta. No existe OAuth por organización, no
existe una llamada real de publicación, y `docs/vault/05-personal-pilot-production-plan.md`
documenta que hoy la única "publicación" real del sistema es que un humano
publique manualmente en Facebook/Instagram y pegue la URL de vuelta
(`record_manual_publication_delivery`, migración `0016`).

Este documento diseña el publisher real: conexión OAuth de Meta por
organización y un adaptador que publica de verdad en Facebook e Instagram,
gateado por el diagnóstico de ADR-008.

**Historial de revisión:** este spec pasó por dos rondas de revisión con
Codex CLI en modo solo-lectura, verificando cada afirmación contra el
código real, no solo la consistencia del texto. La ronda 1 encontró 8
problemas (modelo de assets, preflight, despacho del worker, ciclo de vida
de jobs, contrato de finalización, predicado de diagnóstico, sesión OAuth,
bug de `approve_publication_target`). La ronda 2 verificó esas 8
correcciones y encontró que la mayoría estaban solo parcialmente resueltas,
más 8 problemas nuevos introducidos por los propios arreglos. Esta versión
(revisión 3) corrige todo lo anterior. Por la disciplina de este proyecto
(máximo 3 rondas automatizadas antes de escalar a revisión humana), esta es
la última ronda antes de pedirle a Axel que revise el documento él mismo,
sea cual sea el resultado de la tercera pasada por Codex.

### Alternativa considerada y descartada: Postiz

Durante el brainstorm se evaluó [Postiz](https://github.com/gitroomhq/postiz-app)
(AGPL-3.0), que ya resuelve OAuth + publicación real de Meta y expone un
CLI/MCP pensado para agentes IA. Se descartó por dos razones explícitas de
Axel: ya lo usó como producto standalone y no le convenció, y no quiere
operar un segundo servicio con Docker — Orbit OS debe seguir siendo una
sola interfaz web (Next.js/Supabase, sin contenedores adicionales). El
adaptador de este documento es una implementación propia; el código de
Postiz se usó únicamente como referencia de qué endpoints, códigos de error
y forma de contenedor de medios expone Graph API — no se copia ni se
redistribuye código de Postiz, por lo que no aplica ninguna obligación de
AGPL sobre Orbit OS.

## Alcance

**Incluido:**
- Conexión OAuth de Meta por organización (Facebook Page + cuenta de
  Instagram Business vinculada, si existe).
- Publicación real de imagen única y **carrusel de imágenes** (2-10) en
  Facebook e Instagram — incluye el modelo de datos de múltiples assets por
  publicación (ver "Modelo de assets múltiples" abajo).
- Integración del diagnóstico determinista (ADR-008) como puerta antes de
  publicar, con retención para revisión humana cuando marca riesgo.

**Explícitamente fuera de alcance de este spec** (decisión tomada en el
brainstorm, no un olvido):
- **Video/Reels.** Soportarlo toca validación de archivo, Storage y el
  análisis por visión de forma distinta a la extensión de carrusel de este
  spec. Se diseña como su propio subsistema después.
- **Self-host de Postiz o cualquier servicio externo de publicación.**
- **La capa MCP** (roadmap item 4) — se construye después de que el
  publisher exista de verdad.
- **OAuth multi-página por organización.** V1 asume una página de Facebook
  por organización, con su cuenta de Instagram Business vinculada si existe.
- **Migrar, remover o desactivar en código el callback n8n existente**
  (`ingest_publish_result_callback`, migración `0003`, y las rutas
  `app/api/integrations/n8n/publish*`). Ver "Camino n8n existente" en la
  sección de Seguridad — quedan intactos pero documentados como un riesgo
  operativo a vigilar, no un cambio de este spec.

## Modelo de assets múltiples (nuevo, necesario para carrusel)

Hoy `content_items.asset_id` es una referencia única. Un carrusel necesita
2-10 imágenes en un orden explícito. Se agrega:

### `content_item_assets`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` (PK) | |
| `organization_id` | `uuid` (FK) | |
| `content_item_id` | `uuid` | |
| `asset_id` | `uuid` | |
| `position` | `smallint` check `0-9` | Orden dentro del carrusel; `0` es la portada. |
| `created_at` | `timestamptz` | |

**Integridad de tenant, no solo FKs simples:** `content_items` y `assets`
ganan una restricción `unique (id, organization_id)` cada una (redundante
con su PK, válida en Postgres, y necesaria para lo siguiente). Con eso,
`content_item_assets` declara:
```
foreign key (content_item_id, organization_id) references content_items (id, organization_id),
foreign key (asset_id, organization_id) references assets (id, organization_id)
```
Esto hace imposible a nivel de base de datos que una fila mezcle
`organization_id` con un `content_item_id`/`asset_id` de otra organización
— no basta con que la aplicación lo verifique.

`unique (content_item_id, position)` y `unique (content_item_id, asset_id)`
se mantienen. RLS: mismos lectores que `assets`/`content_items`.

**Invariante "siempre existe una portada":** no es expresable como un
`check` de fila (es una propiedad de conjunto). Se garantiza
procedimentalmente: la función de intake inserta el `content_item` y su
fila `content_item_assets` en `position = 0` **en la misma transacción**;
no existe ningún camino que cree un `content_item` sin su portada.

**Backfill:** la migración `0018` incluye, tras crear la tabla:
```sql
insert into public.content_item_assets (organization_id, content_item_id, asset_id, position)
select organization_id, id, asset_id, 0
from public.content_items
where asset_id is not null
on conflict (content_item_id, position) do nothing;
```
para que los `content_items` creados antes de esta migración tengan su
portada representada.

`content_items.asset_id` no se toca — sigue apuntando al asset en
`position = 0` y sigue siendo lo único que el análisis por visión de IA
(`copy-processor.ts`) evalúa, incluso para un carrusel. Simplificación
deliberada: la IA analiza la portada como representativa.

### Intake

`POST /api/content` cambia el campo `formData` de `asset` (un archivo) a
**`assets`** (1 a 10 archivos, `formData.getAll("assets")`). El proyecto
todavía no tiene usuarios reales en producción, así que este cambio de
contrato no necesita una ruta de compatibilidad hacia atrás — se actualiza
el formulario de intake al mismo tiempo.

**Orden de validación (evita necesitar cleanup transaccional):** los `N`
archivos se validan **todos primero**, en memoria, con la `validateAsset()`
existente sin cambios — recién cuando los `N` pasan, arranca la subida a
Storage. Si cualquiera falla, no se sube nada. Esto evita el problema de
"assets huérfanos en Storage por una validación tardía" sin tocar
`validateAsset()`.

**Límite de tamaño del request:** hoy `MAX_MULTIPART_BYTES = MAX_ASSET_BYTES + 64_000`
asume un solo archivo. Cambia a `MAX_ASSET_BYTES * 10 + 640_000` (10
archivos al tamaño máximo más el overhead proporcional de multipart).

Una vez validados: se sube cada uno a Storage, se crea su fila en `assets`,
se crea el `content_item` con `asset_id` = el de `position = 0`, y se
inserta una fila en `content_item_assets` por archivo — todo en la
transacción de creación existente.

## Arquitectura

La publicación real se ejecuta como un **job del worker durable existente**
(`automation_jobs`, `DurableJobRunner`), igual que la generación de copy —
no de forma síncrona dentro de un API route, y no delegada a n8n.

Flujo de extremo a extremo:

1. Al someter el copy final de un `content_item`
   (`submit_final_copy_for_review`, que ya transiciona
   `content_items.state → 'REVIEW'`), el API route:
   a. Corre `validateFinalCopy()` (ya existente, `lib/content/final-copy.ts`)
      como precondición dura — si falla, la sumisión se rechaza antes de
      llegar a la base de datos, igual que hoy.
   b. Corre `diagnosePublication()` — función pura, sin red — para cada
      `publication_target` del content item, construyendo la señal a
      partir del **copy final recién sometido** (headline + body + cta +
      hashtags unidos), no de la descripción original del intake. Es el
      texto que de verdad se va a publicar, no el brief previo a la
      generación.
2. El resultado se pasa a `apply_publication_diagnosis` (ver "Puerta de
   diagnóstico" abajo).
3. `approve_publication_target` (RPC humana existente, extendida) también
   encola el job `PUBLISH` al aprobar manualmente (ver correcciones abajo).
4. Un worker dedicado a `PUBLISH` reclama el job, valida la conexión de
   Meta de la organización **para la plataforma específica del target**,
   junta los assets ordenados vía `content_item_assets`, genera signed URLs
   temporales, llama al adaptador de Graph API correspondiente, y registra
   el resultado.

### Puerta de diagnóstico — mapeo exacto (corregido en revisión 3)

`diagnosePublication()` devuelve `qualityLevel: 'blocked' | 'needs_review' | 'promising'`,
`findings: PublicationFinding[]` (cada uno con `severity: 'error'|'warning'|'info'`),
y `readyForCopy: boolean` (gate de *generación* de copy, no de publicación
— no se reusa aquí).

La revisión 2 encontró que `qualityLevel === "promising"` por sí solo no
basta: un CTA faltante solo resta 10 puntos (score 90, sigue "promising"),
pero ADR-008 nombra explícitamente un CTA/dolor/prueba incompleto como
hallazgo de riesgo. El predicado correcto excluye **cualquier** finding de
severidad `warning` o `error`, no solo los que bajan el score por debajo de
80:

```
isSafeToAutoPublish =
  diagnosis.qualityLevel === "promising" &&
  diagnosis.findings.every((finding) => finding.severity === "info")
```

Los findings `info` (p. ej. `channel_unspecified`, `objective_unspecified`)
no representan riesgo de contenido — son solo falta de metadata — y no
bloquean la auto-publicación.

```
apply_publication_diagnosis(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid,
  p_quality_level text, -- 'blocked' | 'needs_review' | 'promising'
  p_findings jsonb, -- incluye severity por elemento
  p_idempotency_key uuid
) returns jsonb
```

La RPC deriva `is_safe` internamente aplicando la misma regla de arriba
sobre `p_findings` — no confía en un booleano ya calculado por el llamador.
`service_role`-only. Si `is_safe`: transiciona `PENDING_REVIEW → APPROVED`
(evento `TARGET_AUTO_APPROVED`) y llama internamente a
`enqueue_publish_automation_job`. Si no: el target permanece
`PENDING_REVIEW`; se inserta `TARGET_HELD_FOR_REVIEW` con `p_findings`
como metadata. Idempotente por `p_idempotency_key`.

### Correcciones a `approve_publication_target`

La revisión 2 encontró dos problemas adicionales en la extensión propuesta
para esta función (`0009_tenantize_content_and_jobs.sql`):

1. **Bug del retorno anticipado** (de la revisión 1, aún no bien resuelto):
   se agrega la llamada a `enqueue_publish_automation_job` en **ambos**
   caminos de retorno. `enqueue_publish_automation_job` ya no valida rol
   por sí misma (ver siguiente punto), así que no hay riesgo de rechazar
   una aprobación legítima por un rol distinto.
2. **`enqueue_publish_automation_job` no debe repetir el chequeo de rol de
   `approve_publication_target`.** La revisión 2 notó que
   `approve_publication_target` acepta `owner`/`reviewer`, mientras el
   patrón de `enqueue_copy_automation_job` (la plantilla que se iba a
   copiar) valida `owner`/`editor` — copiarlo tal cual habría rechazado
   aprobaciones de `reviewer`. Corrección: `enqueue_publish_automation_job`
   **no llama a `assert_organization_actor`** — es una función interna,
   invocada únicamente desde `approve_publication_target` y
   `apply_publication_diagnosis`, ambas ya autorizadas antes de llegar a
   este punto. Sigue siendo `service_role`-only (nadie más puede llamarla),
   solo que no repite una autorización que ya ocurrió.
3. **Bug del conteo de "pendientes" agregados:** la lógica actual de
   `approve_publication_target` marca `content_items.state = 'APPROVED'`
   cuando `remaining_pending = 0`, contando con
   `status <> 'APPROVED'`. Como los targets ahora pueden llegar a
   `PUBLISHED` (no solo `APPROVED`) antes de que **otro** target del mismo
   content item termine de aprobarse, ese filtro cuenta un target ya
   `PUBLISHED` como "todavía pendiente" para siempre, y el content item
   nunca llega a `APPROVED` agregado. Corrección: el filtro cambia a
   `status not in ('APPROVED', 'PUBLISHED')`.

Ambas correcciones (2 y 3) se aplican en el mismo `create or replace
function public.approve_publication_target(...)` de la migración `0018` —
mismo signature que la versión de `0009`, por lo que reemplazar (no crear
un overload) es seguro.

## Modelo de datos (migración `0018`, aditiva)

Migraciones aplicadas actualmente: `0001`–`0017`. Ninguna se modifica.

### `organization_meta_connections`

Una fila por organización. Contiene el secreto (`page_access_token`).
**Seguridad en dos capas:** `enable row level security` sin ninguna
política para `authenticated`/`anon`, **más** `revoke all ... from public,
anon, authenticated` explícito.

| Columna | Tipo | Notas |
|---|---|---|
| `organization_id` | `uuid` (PK, FK) | |
| `facebook_page_id` / `facebook_page_name` | `text` | |
| `instagram_business_account_id` | `text`, nullable | |
| `page_access_token` | `text` | Secreto. |
| `status` | `text` check `ACTIVE`/`REVOKED`/`ERROR` | |
| `connected_by` | `uuid` (FK `profiles`) | |
| `connected_at`, `updated_at` | `timestamptz` | |

Funciones `SECURITY DEFINER`:
- `get_meta_connection_status(p_organization_id, p_actor_id)` — grant a
  `authenticated`, valida membresía internamente; nunca expone el token.
- `upsert_meta_connection(...)` / `revoke_meta_connection(...)` /
  `mark_meta_connection_error(p_organization_id)` — `service_role` únicamente.
  La tercera la llama el worker cuando Meta rechaza el token durante una
  publicación (ver "Errores de reconexión" abajo).

### `organization_meta_oauth_sessions` (temporal, selección de página)

| Columna | Tipo | Notas |
|---|---|---|
| `nonce` | `uuid` (PK) | |
| `organization_id` | `uuid` (FK) | |
| `discovered_pages` | `jsonb` | `[{id, name, hasInstagram}]` — sin tokens de página. |
| `user_long_lived_token` | `text` | Token de **usuario**, reutilizado en la selección para volver a pedir `/me/accounts` y extraer el `access_token` de la página elegida — no se persiste un token de página hasta ese momento. |
| `created_by` | `uuid` (FK `profiles`) | |
| `expires_at` | `timestamptz` | `now() + interval '10 minutes'`. |

Sin política RLS para `authenticated`. Filas expiradas se ignoran en toda
lectura (`where expires_at > now()`); sin cron de limpieza en v1 (volumen
bajo, evento raro).

### `automation_jobs` — columnas y kind nuevos

Se reemplaza `check (kind = 'COPY')` por `check (kind in ('COPY', 'PUBLISH'))`.

**Nuevo (hallazgo de revisión 2):** `automation_jobs` solo tenía
`content_item_id` — no distingue Facebook de Instagram para el mismo
content item, y un `PUBLISH` job necesita saber exactamente qué target
está publicando. Se agrega:
```sql
alter table public.automation_jobs
  add column publication_target_id uuid references public.publication_targets(id);
alter table public.automation_jobs
  add constraint automation_jobs_publish_target_check
  check (
    (kind = 'COPY' and publication_target_id is null)
    or (kind = 'PUBLISH' and publication_target_id is not null)
  );
```

### Ciclo de vida completo de jobs `PUBLISH`

Se agregan seis funciones calcadas de `0010`/`0013`/`0014` (no una capa
genérica — mismo estilo de duplicación explícita por `kind` que ya usa este
código base):

- **`enqueue_publish_automation_job(p_organization_id, p_content_item_id, p_publication_target_id)`**
  — sin parámetro de actor (ver corrección de rol arriba). Idempotency key
  derivada determinísticamente de `p_publication_target_id`. Encolado
  desde `apply_publication_diagnosis` y `approve_publication_target`.
- **`claim_next_publish_automation_job(p_provider, p_organization_id)`** —
  igual que `claim_next_copy_automation_job`, pero en vez de cargar
  `content_items`+`assets` carga: el `publication_target` (y su
  `platform`), el `final_copy_version` del content item, la lista ordenada
  de `content_item_assets` (join `assets` para `storage_path`), y la
  conexión de Meta de la organización. **Chequeo de conexión por
  plataforma** (hallazgo de revisión 2): si `platform = 'INSTAGRAM'` exige
  además `instagram_business_account_id is not null`. Si la conexión
  requerida no existe/no está `ACTIVE`, sigue el mismo patrón defensivo que
  ya usa `claim_next_copy_automation_job` para "asset no encontrado":
  marca el job `FAILED` con `sanitized_error = 'PUBLISH_JOB_CONNECTION_NOT_FOUND'`
  (o `'PUBLISH_JOB_INSTAGRAM_NOT_CONNECTED'`) y **devuelve** ese estado —
  nunca lanza una excepción que el runner tendría que interpretar. Esto
  evita que un content item con Instagram no conectado bloquee su target
  de Facebook, y evita que el worker completo se caiga por un claim fallido.
- **`renew_publish_automation_job`** — idéntica a `renew_copy_automation_job`.
- **`complete_publish_automation_job(p_job_id, p_idempotency_key, p_lease_token, p_result jsonb)`**
  — contrato exacto abajo.
- **`fail_publish_automation_job(p_job_id, p_idempotency_key, p_lease_token, p_error, p_retryable, p_requires_reconnect default false)`**
  — igual que la versión de `fail_copy_automation_job` ya vigente desde
  `0014` (no solo la de `0013`): clasificación `FAILED`/`RETRY_WAIT`/`DEAD_LETTER`
  con backoff exponencial, y en transición terminal (`FAILED`/`DEAD_LETTER`)
  también inserta `audit_events` (`PUBLISH_JOB_FAILED`, mismo formato que
  `COPY_JOB_FAILED`) y transiciona el `publication_target` a `ERROR` con
  `last_error`. Además: si `p_requires_reconnect`, llama internamente a
  `mark_meta_connection_error`.
- **`cancel_publish_automation_job` / `recover_expired_publish_automation_jobs` /
  `summarize_publish_automation_jobs`** — idénticas a sus contrapartes de
  `COPY`, filtrando por `kind = 'PUBLISH'`.

### Contrato atómico de `complete_publish_automation_job`

Orden de locks: `automation_jobs` (por idempotency key) → `publication_targets`
→ `content_items` — mismo orden que ya usan las funciones existentes.
`p_result` shape: `{ remotePostId: text, remoteUrl: text, publishedAt: timestamptz }`.
En una transacción:
1. Verifica lease.
2. `publication_targets`: `status = 'PUBLISHED'`, `remote_post_id`,
   `remote_url`, `published_at = p_result.publishedAt`, `last_error = null`.
3. `audit_events` `TARGET_PUBLISHED` (`platform`, `source: 'automated'`, `jobId`).
4. Recalcula agregado de `content_items` (mismo patrón que
   `record_manual_publication_delivery`: todos `PUBLISHED` → `content_items.state = 'PUBLISHED'`).
5. Marca el job `COMPLETED`.

## Despacho del worker (COPY vs. PUBLISH)

Se agrega un segundo store (`lib/automation/supabase-publish-worker-store.ts`,
llamando a las seis RPCs de `PUBLISH`) y un segundo processor
(`worker/providers/meta-publish-processor.ts`, mismo patrón de inyección de
dependencias que `copy-processor.ts`). `worker/entrypoint.ts` levanta
**dos instancias** de `DurableJobRunner` corriendo concurrentemente en el
mismo proceso (`Promise.all([copyRunner.runUntilStopped(), publishRunner.runUntilStopped()])`),
compartiendo un único cliente de Supabase — no se duplica el despliegue.

### Errores de reconexión (hallazgo de revisión 2)

`DurableJobRunner` solo propaga `retryable` a través de `isRetryable`; no
tiene manera de transportar un flag adicional como `requiresReconnect`
hasta la capa de store. En vez de modificar la interfaz genérica y
compartida del runner (usada también por `COPY`), `meta-publish-processor.ts`
maneja esto **dentro de sí mismo**: al capturar un `MetaPublishError` con
`requiresReconnect: true`, llama primero, directamente, a
`mark_meta_connection_error(organizationId)` (antes de que el error
propague al runner), y luego re-lanza el error normalmente.
`isPublishJobRetryable(error)` sigue siendo la única señal que el runner
necesita (`false` para cualquier `MetaPublishError` no reintentable,
incluidos los que requieren reconexión). El runner y su interfaz no
cambian.

## Flujo OAuth

1. **Inicio** — botón "Conectar Facebook" en `Settings → Organización`
   (roles `owner`/`editor`). `GET /api/integrations/meta/connect` genera un
   `nonce`, lo guarda en una **cookie httpOnly, firmada y de corta duración
   (10 min)** además de codificarlo en el `state` firmado (HMAC) junto con
   `organization_id` y expiración, y redirige al diálogo OAuth de Meta con
   scopes `pages_show_list, pages_manage_posts, pages_read_engagement,
   instagram_basic, instagram_content_publish, business_management`.
2. **Callback** — `GET /api/integrations/meta/callback` exige, en este
   orden: (a) una sesión autenticada activa con rol `owner`/`editor` en la
   organización del `state`; (b) que el `nonce` del `state` coincida
   exactamente con el de la cookie httpOnly guardada en el paso 1. La
   revisión 2 señaló correctamente que la firma HMAC y la expiración por sí
   solas no demuestran que quien completa el callback es quien inició el
   flujo — la cookie httpOnly (inaccesible a JavaScript, ligada al mismo
   navegador/sesión) es lo que cierra ese hueco. Sin coincidencia de
   nonce, se rechaza sin excepción. Luego intercambia `code` por un token
   de usuario de corta duración, lo extiende a larga duración
   (`grant_type=fb_exchange_token`), y llama `GET /me/accounts`.
3. **Selección de página** — una sola página → se conecta automáticamente
   (paso 4). Varias páginas → se crea una fila en
   `organization_meta_oauth_sessions` (con el token de usuario, sin tokens
   de página) y se muestra un selector. `POST /api/integrations/meta/connect/select`
   (misma exigencia de sesión/rol + nonce que el callback) recibe
   `{nonce, pageId}`, valida que la sesión temporal no haya expirado, y
   **vuelve a llamar `GET /me/accounts`** con el `user_long_lived_token`
   guardado para extraer el `access_token` de la página elegida (nunca se
   persiste el token de una página no elegida).
4. **Persistencia** — `upsert_meta_connection` (`service_role`-only) guarda
   los datos de la página elegida y `status = 'ACTIVE'`; borra la fila de
   `organization_meta_oauth_sessions` si existía.
5. **Desconexión** — `revoke_meta_connection`: `status = 'REVOKED'`, limpia
   el token.
6. **Salud del token** — antes de publicar, el worker llama
   `GET /debug_token?input_token=...`. Si es inválido, llama
   `mark_meta_connection_error` y falla el job con
   `p_requires_reconnect := true` en vez de agotar reintentos.

## Adaptador de publicación

`lib/integrations/meta-publisher.ts` se reorganiza en dos responsabilidades:

- `preflightApp()` — **solo** verifica `META_APP_ID`/`META_APP_SECRET`
  (credenciales globales de la app, usadas en el intercambio OAuth). Ya no
  verifica `META_PAGE_ID`/`META_PAGE_ACCESS_TOKEN`.
- `getConnectionStatus(organizationId)` — llama a `get_meta_connection_status`;
  devuelve `READY | NOT_CONNECTED | RECONNECT_REQUIRED`, y para Instagram
  específicamente `READY` implica además `instagram_business_account_id is not null`
  (la UI de Settings puede mostrar Facebook e Instagram como dos
  indicadores de estado independientes, no uno solo).

**Nota de implementación:** el plan de implementación debe actualizar
`.env.example` y el test existente de `meta-publisher.ts` que hoy espera
las cuatro variables globales — quedan reducidas a las dos de app.

Las funciones de publicación reciben el token de página/IG por parámetro.

### Facebook

- **Imagen única** (1 fila en `content_item_assets`): `POST /{page-id}/photos`
  con `url` (signed URL, TTL ~10 min), `caption`, `published=true`.
  `GET /{post_id}?fields=permalink_url` para `remote_url`.
- **Carrusel** (2-10 filas): cada imagen como foto no publicada
  (`published=false`) para obtener su `media_fbid`; luego
  `POST /{page-id}/feed` con `attached_media: [{media_fbid}, ...]` en
  orden de `position` y `message`.

### Instagram

- **Imagen única:** `POST /{ig-user-id}/media` (`image_url`, `caption`) →
  contenedor; poll acotado (máx. ~60s, cada 2s); `POST /{ig-user-id}/media_publish`
  con el `creation_id`. `GET /{ig_media_id}?fields=permalink` para `remote_url`.
- **Carrusel:** contenedores hijo (`is_carousel_item=true`, orden de
  `position`), contenedor padre (`media_type=CAROUSEL`, `children=[...]`),
  poll, publish.

**Versión de Graph API:** todas las llamadas fijan una versión explícita
(`v21.0` al momento de escribir este documento) en la URL — nunca la
versión "default" de la cuenta, para que un cambio de default de Meta no
altere el comportamiento sin que el equipo lo decida.

### Manejo de errores

`MetaPublishError extends Error`: `readonly retryable: boolean`,
`readonly requiresReconnect: boolean`.

| Situación | `retryable` | `requiresReconnect` |
|---|---|---|
| Rate limit / 5xx transitorio con respuesta HTTP clara | `true` | `false` |
| Token inválido o revocado | `false` | `true` |
| Contenido rechazado por política, imagen inválida/demasiado grande | `false` | `false` |
| Timeout de poll de contenedor de Instagram | `true` | `false` |
| Timeout o error de red sin respuesta HTTP (no se sabe si Meta creó el post) | `false` | `false` (ver reconciliación) |

**Reconciliación:** Graph API no soporta idempotency key en creación de
posts. El último caso de la tabla termina en `FAILED` sin reintento
automático, con `publication_target` en `ERROR` y mensaje explícito de
verificar manualmente antes de reintentar.

**Subidas intermedias huérfanas (aceptado, no resuelto):** si el worker se
cae después de subir fotos no publicadas (Facebook) o contenedores hijo
(Instagram) pero antes de la llamada final de publicación, esos objetos
quedan huérfanos en Meta — pero **nunca son visibles públicamente** (no
están publicados). Se acepta este desperdicio menor en vez de construir
limpieza activa para v1; el caso que sí importa (post ya publicado pero no
confirmado) está cubierto por la regla de reconciliación de arriba.

## Seguridad

- El `page_access_token` y el `user_long_lived_token` temporal nunca llegan
  al navegador — ninguna de las dos tablas que los contienen tiene política
  `authenticated`, y ambas tienen `revoke all` explícito.
- Las imágenes en Storage privado (ADR-004) se exponen a Meta solo vía
  signed URL de corta duración, generada en el momento exacto de publicar.
- `organization_id` sigue siendo el límite de tenant, ahora reforzado con
  FKs compuestas para `content_item_assets`, no solo con
  `assert_organization_actor` en cada función.
- El publisher sigue fallando cerrado: sin una fila `ACTIVE` (y, para
  Instagram, con `instagram_business_account_id`) en
  `organization_meta_connections`, ningún job `PUBLISH` de esa plataforma
  puede completarse.

### Camino n8n existente (hallazgo de revisión 2)

`ingest_publish_result_callback` (migración `0003`) y las rutas
`app/api/integrations/n8n/publish/route.ts` /
`app/api/integrations/n8n/publish-result/route.ts` siguen activas y
invocables — no es código muerto en el sentido de "inalcanzable", solo no
está conectado a ninguna acción de la UI hoy (confirmado: ningún archivo
de `app/` fuera de `app/api/integrations/n8n/` las referencia). Ese camino
requiere que el target ya esté `APPROVED` y depende de variables de entorno
`N8N_*` que hoy no están configuradas en ningún lugar del repositorio — sin
ellas, la ruta siempre responde `INTEGRATION_NOT_CONFIGURED` y no puede
publicar nada. Si en el futuro alguien configura esas variables mientras el
worker de `PUBLISH` de este spec también está activo, ambos caminos
podrían intentar publicar el mismo target aprobado — una publicación
duplicada real. Este spec no desactiva ni modifica esa ruta (está fuera de
alcance), pero dejar esta nota explícita es intencional: configurar
`N8N_*` para publicación después de que este publisher esté en producción
es una decisión operativa que debe tomarse sabiendo este riesgo, no un
detalle que el código impida por sí solo.

## Testing

- **Adaptador** (`tests/integrations/meta-publisher.test.ts`): `fetch`
  mockeado — éxito imagen única/carrusel ambas plataformas (verificando
  orden por `position`), cada fila de la tabla de errores, timeout ambiguo
  → `FAILED` sin reintento.
- **Migración `0018`**: `authenticated` no puede leer
  `organization_meta_connections` ni `organization_meta_oauth_sessions`;
  `get_meta_connection_status` no expone tokens; `automation_jobs.kind`
  acepta `PUBLISH` y su `check` de `publication_target_id` se cumple; FKs
  compuestas de `content_item_assets` rechazan una fila de otro tenant;
  backfill crea `position = 0` para content items preexistentes; ciclo
  completo enqueue/claim/renew/complete/fail/cancel/recover/summarize
  calcado del de `COPY`; claim con conexión ausente/Instagram no conectado
  falla el job sin lanzar excepción.
- **`apply_publication_diagnosis`**: `qualityLevel = 'promising'` con solo
  findings `info` → `APPROVED` + job encolado; cualquier finding
  `warning`/`error` (incluido `cta_missing`, el caso que motivó la
  corrección del predicado) → permanece `PENDING_REVIEW`.
- **`approve_publication_target`** (regresión): aprobar manualmente encola
  el job; llamarlo de nuevo sobre un target ya `APPROVED` no duplica el
  job; el conteo agregado llega a `content_items.state = 'APPROVED'`
  incluso cuando otro target del mismo item ya está `PUBLISHED`.
- **Despacho del worker**: un `PUBLISH` encolado no espera a que el runner
  de `COPY` esté libre, y viceversa.
- **Intake multi-asset**: subir 2-10 archivos válidos crea sus filas
  ordenadas en `content_item_assets`; si el archivo 3 de 5 falla
  validación, no se sube nada de los otros 4.
- **OAuth**: nonce de cookie y de `state` deben coincidir (rechazo si no);
  selección automática de página única; selector con varias vía
  `organization_meta_oauth_sessions`, incluyendo el segundo llamado a
  `/me/accounts` en la selección; expiración de la sesión temporal;
  ningún token en el cuerpo de ninguna respuesta al navegador.

## Preguntas resueltas durante el brainstorm (para no repetir la discusión)

- Alcance: Facebook + Instagram desde el día uno, imagen única y carrusel
  (con su modelo de múltiples assets); video/Reels es un spec futuro
  aparte.
- Conexión: flujo OAuth completo por organización desde v1 (no token
  pegado a mano), porque el objetivo es ser replicable a muchos clientes.
- Postiz: evaluado y descartado como servicio a correr (sin Docker, Axel ya
  lo probó standalone y no le convenció); usado solo como referencia de
  diseño de los endpoints de Graph API.
- Meta App: Axel ya tiene una app configurada y un token de página de
  prueba funcionando — escalar a múltiples organizaciones cliente
  eventualmente requerirá que esa app pase el App Review de Meta para los
  permisos avanzados.
