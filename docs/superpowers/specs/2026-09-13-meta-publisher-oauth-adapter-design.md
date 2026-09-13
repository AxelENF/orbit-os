# Meta publisher real: OAuth + adaptador Graph API — diseño

**Fecha:** 2026-09-13 (revisión 2, tras ronda de revisión con Codex CLI)
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

**Revisión 2:** la primera versión de este documento se mandó a revisión con
Codex CLI (sandbox de solo lectura, verificando cada afirmación técnica
contra el código real). Encontró 8 problemas reales, todos corregidos en
esta versión: un modelo de assets que no soportaba carrusel, un `preflight`
que seguía apuntando a variables de entorno globales, un worker
hard-codeado para `kind = 'COPY'` sin ruta de despacho para `PUBLISH`, un
ciclo de vida de jobs incompleto (solo enqueue/claim/complete, faltaban
renovación/cancelación/recuperación), un contrato de finalización no
definido, un campo `isSafe` que no existe en el diagnóstico real, un flujo
OAuth de selección de página sin contrato de sesión, y un bug en la
extensión de `approve_publication_target` que no encolaba el job en su
camino de retorno anticipado. Cada corrección se documenta en su sección
correspondiente, no como una lista aparte.

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
- **Video/Reels.** El pipeline de intake (`lib/content/asset-validation.ts`)
  solo acepta PNG/JPG/WEBP; soportar video toca validación de archivo,
  Storage y el paso de análisis por visión de IA de forma distinta a la
  extensión de carrusel de este spec (video no reusa el mismo contrato de
  "N imágenes en orden"). Se diseña como su propio subsistema una vez que
  este publisher esté en producción.
- **Self-host de Postiz o cualquier servicio externo de publicación.**
- **La capa MCP** (roadmap item 4) — se construye después de que el
  publisher exista de verdad.
- **OAuth multi-página por organización** (una organización con varias
  Fanpages). V1 asume una página de Facebook por organización, con su
  cuenta de Instagram Business vinculada si existe.
- **Migrar o remover el callback n8n existente** (`ingest_publish_result_callback`,
  migración `0003`). Esa función asume que un humano ya aprobó el target y
  que n8n hace la llamada real — es un camino que nunca se terminó de
  cablear. Este spec no lo toca, no lo extiende y no lo llama: queda como
  código muerto sin usar. No se puede modificar (migración ya aplicada) y
  removerlo es un cambio aparte, no parte de este trabajo.

## Modelo de assets múltiples (nuevo, necesario para carrusel)

Hoy `content_items.asset_id` es una referencia única — un content item
tiene exactamente una imagen. Esto alcanza para el flujo de imagen única,
pero un carrusel necesita 2-10 imágenes en un orden explícito. Se agrega:

### `content_item_assets`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` (PK) | |
| `organization_id` | `uuid` (FK) | Límite de tenant, igual que el resto del esquema. |
| `content_item_id` | `uuid` (FK `content_items`) | |
| `asset_id` | `uuid` (FK `assets`) | |
| `position` | `smallint` check `0-9` | Orden dentro del carrusel; `0` es la portada. |
| `created_at` | `timestamptz` | |

`unique (content_item_id, position)` y `unique (content_item_id, asset_id)`.
RLS: mismos lectores que `assets`/`content_items` (`is_organization_member`).

**`content_items.asset_id` no se toca** — sigue apuntando al asset en
`position = 0` (la portada) y sigue siendo lo único que el análisis por
visión de IA (`copy-processor.ts`) evalúa, incluso para un carrusel. Esto
es una simplificación deliberada: la IA analiza la imagen de portada como
representativa; no se le pide analizar cada imagen del carrusel.

### Intake

`POST /api/content` cambia el campo `formData` de `asset` (un archivo) a
**`assets`** (1 a 10 archivos, `formData.getAll("assets")`). Cada archivo
pasa por la validación existente `validateAsset()` sin cambios — la validación
es por archivo, no cambia por ser parte de un carrusel. El servidor:
1. Valida cada archivo (mismo `validateAsset()` de hoy).
2. Sube cada uno a Storage y crea su fila en `assets` (sin cambios al
   modelo de `assets` en sí).
3. Crea el `content_item` con `asset_id` = el de `position = 0`.
4. Inserta una fila en `content_item_assets` por archivo, con su `position`.

Como el proyecto todavía no tiene usuarios reales en producción (ver
`docs/vault/05-personal-pilot-production-plan.md`), este cambio de
contrato de `asset` → `assets` no necesita una ruta de compatibilidad hacia
atrás; se actualiza el formulario de intake al mismo tiempo.

## Arquitectura

La publicación real se ejecuta como un **job del worker durable existente**
(`automation_jobs`, `DurableJobRunner`), igual que la generación de copy —
no de forma síncrona dentro de un API route, y no delegada a n8n.

Flujo de extremo a extremo:

1. Al someter el copy final de un `content_item`
   (`submit_final_copy_for_review`, ya existente), el API route corre
   `diagnosePublication()` — función pura, sin red — para cada
   `publication_target` (`FACEBOOK`, `INSTAGRAM`) del content item.
2. El resultado se pasa a una nueva RPC, `apply_publication_diagnosis`
   (ver "Puerta de diagnóstico" abajo).
3. La RPC humana existente `approve_publication_target` se extiende para
   también encolar el job `PUBLISH` al aprobar (ver "Corrección del bug de
   `approve_publication_target`" abajo).
4. Un worker dedicado a `PUBLISH` (proceso descrito en "Despacho del
   worker" abajo) reclama el job, valida la conexión de Meta de la
   organización, junta los assets ordenados vía `content_item_assets`,
   genera signed URLs temporales, llama al adaptador de Graph API
   correspondiente (imagen única si hay 1 asset, carrusel si hay 2-10), y
   registra el resultado.

### Puerta de diagnóstico — mapeo exacto

`diagnosePublication()` (`lib/aias/publication-diagnosis.ts`) no devuelve
ningún campo `isSafe` — devuelve `qualityLevel: 'blocked' | 'needs_review' | 'promising'`,
`findings: PublicationFinding[]`, y `readyForCopy: boolean` (este último es
la puerta para *generar* copy, no para publicar — son gates distintos).

El predicado de auto-publicación de ADR-008 es:

```
isSafeToAutoPublish = diagnosis.qualityLevel === "promising"
```

`needs_review` y `blocked` requieren revisión humana — esto ya corresponde
exactamente a lo que ADR-008 describe como "hallazgo de riesgo" (score bajo,
claim no verificado, dolor/prueba/CTA incompletos son precisamente lo que
baja `qualityLevel` por debajo de `promising`).

```
apply_publication_diagnosis(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid,
  p_quality_level text, -- 'blocked' | 'needs_review' | 'promising', validado por check
  p_findings jsonb, p_idempotency_key uuid
) returns jsonb
```

La RPC deriva `is_safe := p_quality_level = 'promising'` internamente — no
confía en un booleano ya calculado por el llamador, para que la regla viva
en un solo lugar auditable. `service_role`-only. Si `is_safe`: transiciona
`PENDING_REVIEW → APPROVED` (evento `TARGET_AUTO_APPROVED`) y llama
internamente a `enqueue_publish_automation_job`. Si no: el target
permanece `PENDING_REVIEW`; se inserta un evento `TARGET_HELD_FOR_REVIEW`
con `p_findings` como metadata. Idempotente por `p_idempotency_key`, mismo
patrón de doble-chequeo antes/después del lock de fila que
`record_manual_publication_delivery`.

### Corrección del bug de `approve_publication_target`

La versión original de este spec proponía "agregar una línea al final que
encola el job" — pero la función existente **retorna temprano** cuando el
target ya está `APPROVED` (línea `if target.status = 'APPROVED' then return target; end if;`
en `0009_tenantize_content_and_jobs.sql`), antes de llegar a esa línea.

Corrección: la llamada a `enqueue_publish_automation_job` se agrega en
**ambos** caminos de retorno (el de "ya estaba aprobado" y el de "se acaba
de aprobar"), confiando en que `enqueue_publish_automation_job` es
idempotente por `(organization_id, kind, idempotency_key)` — si ya existe
un job para ese target (la idempotency key se deriva determinísticamente
de `publication_target_id`), la llamada no crea un duplicado, solo
devuelve el job existente. Esto es seguro incluso si la función se llama
repetidamente sobre un target ya publicado: nunca se re-encola una
publicación ya completada, solo se evita el bug de "nunca se encoló nada"
en el camino de retorno anticipado.

## Modelo de datos (migración `0018`, aditiva)

Migraciones aplicadas actualmente: `0001`–`0017`. Ninguna se modifica.

### `organization_meta_connections`

Una fila por organización. Contiene el secreto (`page_access_token`).
**Seguridad en dos capas, no solo "sin política":** `alter table ... enable
row level security` sin ninguna política para `authenticated`/`anon`
(deniega por default), **más** `revoke all on organization_meta_connections
from public, anon, authenticated` explícito — igual que el patrón de
revoke/grant ya usado en las funciones sensibles del resto del esquema.

| Columna | Tipo | Notas |
|---|---|---|
| `organization_id` | `uuid` (PK, FK) | Una conexión activa por organización en v1. |
| `facebook_page_id` / `facebook_page_name` | `text` | |
| `instagram_business_account_id` | `text`, nullable | Ausente si la página no tiene IG vinculado. |
| `page_access_token` | `text` | Secreto. Solo lo leen funciones `service_role`. |
| `status` | `text` check `ACTIVE`/`REVOKED`/`ERROR` | `ERROR` cuando Meta rechaza el token (revocado, permisos retirados) o cuando un job de publish falla con `requires_reconnect`. |
| `connected_by` | `uuid` (FK `profiles`) | |
| `connected_at`, `updated_at` | `timestamptz` | |

Acceso controlado por funciones `SECURITY DEFINER`:
- `get_meta_connection_status(p_organization_id, p_actor_id)` — grant a
  `authenticated`, valida membresía internamente; devuelve **solo**
  `facebook_page_name`, `instagram_business_account_id is not null`,
  `status`, `connected_at` — nunca el token.
- `upsert_meta_connection(...)` / `revoke_meta_connection(...)` —
  `service_role` únicamente, usadas por las rutas de OAuth callback/disconnect.

### `organization_meta_oauth_sessions` (temporal, para selección de página)

Cuando el callback OAuth descubre más de una página administrada por el
usuario, no hay todavía dónde elegir cuál conectar. Se agrega una tabla de
sesión temporal:

| Columna | Tipo | Notas |
|---|---|---|
| `nonce` | `uuid` (PK) | El mismo nonce del `state` firmado del paso 1. |
| `organization_id` | `uuid` (FK) | |
| `discovered_pages` | `jsonb` | `[{id, name, hasInstagram}]` — sin tokens. |
| `user_long_lived_token` | `text` | El token de usuario, no el de página; se descarta tras la selección. |
| `created_by` | `uuid` (FK `profiles`) | |
| `expires_at` | `timestamptz` | `now() + interval '10 minutes'`. |

Sin política RLS para `authenticated` (mismo tratamiento que
`organization_meta_connections` — contiene un token). Una fila expirada se
ignora en cualquier lectura (`where expires_at > now()`); no hace falta un
cron de limpieza para v1 dado el volumen esperado (una conexión por
organización, evento raro).

### `automation_jobs.kind`

Se reemplaza el `check (kind = 'COPY')` por
`check (kind in ('COPY', 'PUBLISH'))`.

### Ciclo de vida completo de jobs `PUBLISH`

La migración `0013` no es solo enqueue/claim/complete — agrega renovación
de lease, clasificación de fallas con backoff exponencial, cancelación, y
recuperación de leases expirados, **todo hard-codeado a `kind = 'COPY'`**
(cada función tiene `where kind = 'COPY'` explícito, y
`DurableJobRunner`/`worker/entrypoint.ts` no despachan por `kind` — usan un
único store y un único processor). Siguiendo el mismo patrón que ya usa
este código base (funciones dedicadas por tipo de job, no una capa
genérica), se agregan sus seis equivalentes para `PUBLISH`, calcados
función por función de sus contrapartes de `0010`/`0013`:

- `enqueue_publish_automation_job` — descrito arriba, encolado desde
  `apply_publication_diagnosis` y `approve_publication_target`.
- `claim_next_publish_automation_job(p_provider, p_organization_id)` —
  igual que `claim_next_copy_automation_job` pero, en vez de cargar
  `content_items`+`assets`, carga el `publication_target`, el
  `final_copy_version` del content item, la lista ordenada de
  `content_item_assets` (join con `assets` para `storage_path`), y la
  conexión de Meta de la organización (falla el claim con
  `PUBLISH_JOB_CONNECTION_NOT_FOUND` si no hay una `ACTIVE`).
- `renew_publish_automation_job` — idéntica a `renew_copy_automation_job`
  (renovación de lease, sin lógica específica de Meta).
- `complete_publish_automation_job(p_job_id, p_idempotency_key, p_lease_token, p_result jsonb)`
  — contrato de finalización atómico (ver abajo).
- `fail_publish_automation_job(p_job_id, p_idempotency_key, p_lease_token, p_error, p_retryable, p_requires_reconnect default false)`
  — igual que `fail_copy_automation_job` (clasificación
  `FAILED`/`RETRY_WAIT`/`DEAD_LETTER` con backoff exponencial), más: si
  `p_requires_reconnect`, marca `organization_meta_connections.status = 'ERROR'`;
  y solo en transición a `FAILED`/`DEAD_LETTER` (nunca en `RETRY_WAIT`),
  transiciona el `publication_target` a `ERROR` con `last_error`.
- `cancel_publish_automation_job` / `recover_expired_publish_automation_jobs` /
  `summarize_publish_automation_jobs` — idénticas a sus contrapartes de
  `COPY`, filtrando por `kind = 'PUBLISH'`.

### Contrato atómico de `complete_publish_automation_job`

En una sola transacción:
1. Verifica lease (igual que `complete_copy_automation_job`).
2. Actualiza `publication_targets`: `status = 'PUBLISHED'`,
   `remote_post_id`, `remote_url`, `published_at = now()`, `last_error = null`.
3. Inserta `audit_events` `TARGET_PUBLISHED` (`platform`, `source: 'automated'`, `jobId`).
4. Recalcula el estado agregado de `content_items` — mismo patrón que
   `record_manual_publication_delivery`: si todos los targets del content
   item están `PUBLISHED`, transiciona `content_items.state = 'PUBLISHED'`.
5. Marca el `automation_job` `COMPLETED`.

### Despacho del worker (COPY vs. PUBLISH)

`worker/entrypoint.ts` hoy construye **un** `SupabaseCopyWorkerStore`
(atado a las RPCs de `COPY`) y **un** `DurableJobRunner`. No hay
enrutamiento por `kind`, así que agregar `isPublishJobRetryable()` sin más
no permitiría procesar jobs `PUBLISH` — seguirían encolados para siempre.

Se agrega un segundo store (`lib/automation/supabase-publish-worker-store.ts`,
llamando a las seis RPCs de `PUBLISH` en vez de las de `COPY`) y un segundo
processor (`worker/providers/meta-publish-processor.ts`, mismo patrón de
inyección de dependencias que `copy-processor.ts`). `worker/entrypoint.ts`
se extiende para levantar **dos instancias** de `DurableJobRunner` (una por
`kind`) corriendo concurrentemente dentro del mismo proceso Node
(`Promise.all([copyRunner.runUntilStopped(), publishRunner.runUntilStopped()])`),
compartiendo un único cliente de Supabase — no se duplica el despliegue ni
se agrega un segundo servicio a operar, solo dos loops de polling
independientes en el mismo worker.

## Flujo OAuth

1. **Inicio** — botón "Conectar Facebook" en `Settings → Organización`
   (roles `owner`/`editor`). `GET /api/integrations/meta/connect` genera un
   `state` firmado (HMAC con secreto de servidor) que codifica
   `organization_id` + `nonce` + expiración de 10 minutos, y redirige al
   diálogo OAuth de Meta con scopes `pages_show_list, pages_manage_posts,
   pages_read_engagement, instagram_basic, instagram_content_publish,
   business_management`.
2. **Callback** — `GET /api/integrations/meta/callback` exige una sesión
   autenticada activa con rol `owner`/`editor` en la organización del
   `state` (el nonce por sí solo no es suficiente defensa CSRF — debe
   coincidir con la sesión que lo inició, no solo con la firma y la
   expiración). Intercambia `code` por un token de usuario de corta
   duración, lo extiende a larga duración (`grant_type=fb_exchange_token`),
   y llama `GET /me/accounts`.
3. **Selección de página** — si el usuario administra una sola página, se
   conecta automáticamente (paso 4). Si administra varias, se crea una fila
   en `organization_meta_oauth_sessions` con las páginas descubiertas (sin
   tokens de página, solo id/nombre/si tiene IG) y se redirige a una
   pantalla de selección; `POST /api/integrations/meta/connect/select`
   (misma exigencia de sesión/rol que el callback) recibe `{nonce, pageId}`,
   valida que la sesión temporal no haya expirado, y continúa al paso 4
   para la página elegida.
4. **Persistencia** — `upsert_meta_connection` (`service_role`-only) guarda
   `facebook_page_id/name`, `page_access_token`,
   `instagram_business_account_id`, `status = 'ACTIVE'`; borra la fila de
   `organization_meta_oauth_sessions` si existía. El token nunca forma
   parte de una respuesta JSON al navegador.
5. **Desconexión** — acción en Settings que llama a
   `revoke_meta_connection`: `status = 'REVOKED'`, se limpia el token.
6. **Salud del token** — antes de cada intento de publicación, el worker
   llama al endpoint de depuración de tokens de Meta
   (`GET /debug_token?input_token=...`). Si es inválido, marca la conexión
   `ERROR` y falla el job vía `fail_publish_automation_job(..., p_requires_reconnect := true)`
   en vez de agotar reintentos contra un token muerto.

## Adaptador de publicación

`lib/integrations/meta-publisher.ts` se reorganiza en dos responsabilidades
separadas (el `preflight` original mezclaba una verificación de app global
con una de conexión por organización, que ahora son cosas distintas):

- `preflightApp()` — sin cambios de fondo respecto a hoy, pero **solo**
  verifica `META_APP_ID`/`META_APP_SECRET` (credenciales globales de la
  app, usadas en el intercambio OAuth). Ya no verifica `META_PAGE_ID`/`META_PAGE_ACCESS_TOKEN`
  — esos ahora viven por organización en `organization_meta_connections`,
  no en variables de entorno.
- `getConnectionStatus(organizationId)` — llama a `get_meta_connection_status`;
  devuelve `READY | NOT_CONNECTED | RECONNECT_REQUIRED`.

Las funciones de publicación reciben el token de página/IG por parámetro —
nunca leen variables de entorno para el token de una organización
específica.

### Facebook

- **Imagen única** (`content_item_assets` tiene 1 fila): `POST /{page-id}/photos`
  con `url` (signed URL de Storage, TTL ~10 min), `caption` (headline +
  body + cta + hashtags), `published=true`. `GET /{post_id}?fields=permalink_url`
  para la URL canónica a guardar en `remote_url`.
- **Carrusel** (2-10 filas): cada imagen se sube primero como foto no
  publicada (`published=false`) para obtener su `media_fbid`; luego
  `POST /{page-id}/feed` con `attached_media: [{media_fbid}, ...]` (en el
  orden de `position`) y `message`.

### Instagram

- **Imagen única:** `POST /{ig-user-id}/media` (`image_url`, `caption`) →
  contenedor; poll acotado (máx. ~60s, cada 2s) de su estado hasta que esté
  listo o falle; `POST /{ig-user-id}/media_publish` con el `creation_id`.
  `GET /{ig_media_id}?fields=permalink` para `remote_url`.
- **Carrusel:** cada imagen como contenedor hijo
  (`is_carousel_item=true`, en orden de `position`), un contenedor padre
  (`media_type=CAROUSEL`, `children=[...]`), poll, publish.

### Manejo de errores

Nueva clase `MetaPublishError extends Error` (mismo espíritu que
`CopyGuardrailError`): `readonly retryable: boolean`,
`readonly requiresReconnect: boolean`. Clasificación por código de error de
Meta:

| Situación | `retryable` | `requiresReconnect` |
|---|---|---|
| Rate limit / 5xx transitorio con respuesta HTTP clara | `true` | `false` |
| Token inválido o revocado | `false` | `true` |
| Contenido rechazado por política, imagen inválida/demasiado grande | `false` | `false` |
| Timeout de poll de contenedor de Instagram | `true` | `false` |
| **Timeout o error de red sin respuesta HTTP** (no se sabe si Meta recibió/creó el post) | `false` | `false` — pero ver nota de reconciliación |

**Nota de reconciliación:** Graph API no soporta una idempotency key en la
creación de posts — un reintento ciego tras un timeout ambiguo puede
publicar duplicado. Por eso el último caso de la tabla se marca
explícitamente **no reintentable automáticamente**: el job termina en
`FAILED` con un mensaje "no se pudo confirmar si Meta publicó — verificar
manualmente antes de reintentar", y el target queda en `ERROR`. Un humano
(o una acción explícita futura de "reintentar de todos modos") decide,
nunca el backoff automático.

`worker/entrypoint.ts` gana un `isPublishJobRetryable(error)` análogo a
`isCopyJobRetryable`, conectado al `DurableJobRunner` del runner de
`PUBLISH`.

## Seguridad

- El `page_access_token` y el `user_long_lived_token` temporal nunca llegan
  al navegador — ni en la respuesta de conexión, ni en ninguna lectura vía
  RLS directa (ninguna de las dos tablas que los contienen tiene política
  `authenticated`, y ambas tienen `revoke all` explícito además).
- Las imágenes en Storage privado (ADR-004) se exponen a Meta solo vía
  signed URL de corta duración, generada en el momento exacto de publicar,
  nunca una URL pública permanente.
- `organization_id` sigue siendo el límite de tenant en cada función nueva,
  vía `assert_organization_actor`, igual que el resto del esquema.
- El publisher sigue fallando cerrado: sin una fila `ACTIVE` en
  `organization_meta_connections`, ningún job `PUBLISH` puede completarse.

## Testing

- **Adaptador** (`tests/integrations/meta-publisher.test.ts`): `fetch`
  mockeado, sin red real — casos de éxito (imagen única y carrusel, ambas
  plataformas, verificando orden por `position`) y cada fila de la tabla de
  clasificación de errores de arriba, incluyendo el caso de timeout
  ambiguo → `FAILED` sin reintento.
- **Migración `0018`**: siguiendo el patrón de
  `tests/content/copy-hashtags-migration.test.ts` — `authenticated` no
  puede leer `organization_meta_connections` ni
  `organization_meta_oauth_sessions`; `get_meta_connection_status` no
  expone el token; el `check` de `automation_jobs.kind` acepta `PUBLISH`;
  ciclo completo enqueue/claim/renew/complete/fail/cancel/recover/summarize
  calcado del de `COPY`; `content_item_assets` respeta sus `unique`.
- **`apply_publication_diagnosis`**: `qualityLevel = 'promising'` →
  `APPROVED` + job encolado + evento `TARGET_AUTO_APPROVED`;
  `needs_review`/`blocked` → permanece `PENDING_REVIEW` con `findings` en
  el evento de auditoría.
- **`approve_publication_target`** (regresión): aprobar manualmente encola
  el job `PUBLISH`; llamarlo de nuevo sobre un target ya `APPROVED` no crea
  un segundo job (verifica la corrección del bug de retorno anticipado).
- **Despacho del worker**: un test de integración liviano confirma que
  `worker/entrypoint.ts` reclama jobs `COPY` y `PUBLISH` de forma
  independiente (un `PUBLISH` encolado no se queda esperando porque el
  runner de `COPY` esté ocupado, y viceversa).
- **OAuth**: `state`/sesión inválidos se rechazan en callback y en
  `connect/select`; selección automática de página única; selector cuando
  hay varias vía `organization_meta_oauth_sessions`; expiración de la
  sesión temporal a los 10 minutos; aserción explícita de que ningún token
  aparece en el cuerpo de ninguna respuesta al navegador.

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
  prueba funcionando — no se parte de cero para el desarrollo, aunque
  escalar a múltiples organizaciones cliente eventualmente requerirá que
  esa app pase el App Review de Meta para los permisos avanzados.
