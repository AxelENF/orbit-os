# Meta publisher real: OAuth + adaptador Graph API — diseño

**Fecha:** 2026-09-13
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
- Publicación real de imagen única y carrusel de imágenes en Facebook e
  Instagram.
- Integración del diagnóstico determinista (ADR-008) como puerta antes de
  publicar, con retención para revisión humana cuando marca riesgo.

**Explícitamente fuera de alcance de este spec** (decisión tomada en el
brainstorm, no un olvido):
- **Video/Reels.** El pipeline de intake (`lib/content/asset-validation.ts`)
  solo acepta PNG/JPG/WEBP; soportar video toca validación de archivo,
  Storage y el paso de análisis por visión de IA, no solo el publisher. Se
  diseña como su propio subsistema una vez que este publisher esté en
  producción.
- **Self-host de Postiz o cualquier servicio externo de publicación.**
- **La capa MCP** (roadmap item 4) — se construye después de que el
  publisher exista de verdad, para tener algo real que exponer como
  herramienta de agente.
- **OAuth multi-página por organización** (una organización con varias
  Fanpages). V1 asume una página de Facebook por organización, con su
  cuenta de Instagram Business vinculada si existe.

## Arquitectura

La publicación real se ejecuta como un **job del worker durable existente**
(`automation_jobs`, `DurableJobRunner`), igual que la generación de copy —
no de forma síncrona dentro de un API route, y no delegada a n8n.

Flujo de extremo a extremo:

1. Al someter el copy final de un `content_item`
   (`submit_final_copy_for_review`, ya existente), el API route corre
   `diagnosePublication()` — función pura, sin red — para cada
   `publication_target` (`FACEBOOK`, `INSTAGRAM`) del content item.
2. El resultado se pasa a una nueva RPC, `apply_publication_diagnosis`:
   - Si el diagnóstico no marca riesgo → transiciona el target
     `PENDING_REVIEW → APPROVED` (evento `TARGET_AUTO_APPROVED`) y encola un
     job `PUBLISH` para ese target, en la misma transacción.
   - Si marca riesgo → el target se queda en `PENDING_REVIEW`; los
     `findings` del diagnóstico se graban en `audit_events` para que el
     humano vea *por qué* se detuvo, no solo que se detuvo.
3. La RPC humana existente `approve_publication_target` se extiende para
   también encolar el job `PUBLISH` al aprobar — así el job de publicación
   siempre se dispara cuando un target llega a `APPROVED`, sin importar si
   aprobó la IA o un humano.
4. El worker (`worker/providers/meta-publish-processor.ts`, nuevo, mismo
   patrón que `copy-processor.ts`) reclama el job `PUBLISH`, valida la
   conexión de Meta de la organización, genera una signed URL temporal del
   asset en Storage, llama al adaptador de Graph API correspondiente, y
   registra el resultado (éxito con `remote_post_id`/`remote_url`, o error
   clasificado como reintentable o no).

Este diseño reutiliza `automation_jobs` (lease, retry, backoff),
`publication_targets.status` y sus transiciones existentes, y el patrón de
`audit_events` — no se introduce un segundo modelo de estados paralelo.

## Modelo de datos (migración `0018`, aditiva)

Migraciones aplicadas actualmente: `0001`–`0017`. Ninguna se modifica.

### `organization_meta_connections`

Una fila por organización. Contiene el secreto (`page_access_token`), por
lo que **no tiene política RLS para `authenticated`** — ningún rol de
navegador puede hacer `select` directo sobre esta tabla, sin excepción.

| Columna | Tipo | Notas |
|---|---|---|
| `organization_id` | `uuid` (PK, FK) | Una conexión activa por organización en v1. |
| `facebook_page_id` / `facebook_page_name` | `text` | |
| `instagram_business_account_id` | `text`, nullable | Ausente si la página no tiene IG vinculado. |
| `page_access_token` | `text` | Secreto. Solo lo leen funciones `service_role`. |
| `status` | `text` check `ACTIVE`/`REVOKED`/`ERROR` | `ERROR` cuando Meta rechaza el token (revocado, permisos retirados). |
| `connected_by` | `uuid` (FK `profiles`) | |
| `connected_at`, `updated_at` | `timestamptz` | |

Acceso controlado por dos funciones `SECURITY DEFINER`:
- `get_meta_connection_status(p_organization_id, p_actor_id)` — grant a
  `authenticated`, internamente valida membresía; devuelve **solo**
  `facebook_page_name`, `instagram_business_account_id is not null`,
  `status`, `connected_at` — nunca el token.
- Funciones de escritura (`upsert_meta_connection`, `revoke_meta_connection`)
  — `service_role` únicamente, usadas por las rutas de OAuth callback/disconnect.

### `automation_jobs.kind`

Se reemplaza el `check (kind = 'COPY')` por
`check (kind in ('COPY', 'PUBLISH'))`, y se agregan tres funciones calcadas
de las de `COPY` (`enqueue_publish_automation_job`,
`claim_publish_automation_job`, `complete_publish_automation_job`), mismo
patrón de lease de 10 minutos, `attempt_count`, e idempotencia por
`(organization_id, kind, idempotency_key)`.

### `apply_publication_diagnosis`

```
apply_publication_diagnosis(
  p_organization_id uuid, p_content_item_id uuid, p_publication_target_id uuid,
  p_is_safe boolean, p_findings jsonb, p_idempotency_key uuid
) returns jsonb
```
`service_role`-only (el diagnóstico corre en el API route con el service
role, no expuesto al cliente). Idempotente por `p_idempotency_key`, mismo
patrón de doble-chequeo antes/después del lock de fila que
`record_manual_publication_delivery`.

### `approve_publication_target`

Se extiende (mismo signature, `create or replace` es seguro aquí porque no
cambia parámetros) para que, tras marcar `APPROVED`, llame internamente a
`enqueue_publish_automation_job` con una idempotency key derivada de
`publication_target_id` — un mismo target nunca encola dos jobs de publish.

## Flujo OAuth

1. **Inicio** — botón "Conectar Facebook" en `Settings → Organización`
   (roles `owner`/`editor`). `GET /api/integrations/meta/connect` genera un
   `state` firmado (HMAC con secreto de servidor) que codifica
   `organization_id` + nonce + expiración de 10 minutos, y redirige al
   diálogo OAuth de Meta con scopes `pages_show_list, pages_manage_posts,
   pages_read_engagement, instagram_basic, instagram_content_publish,
   business_management`.
2. **Callback** — `GET /api/integrations/meta/callback` valida la firma y
   expiración de `state` (rechaza sin ella — es la única defensa CSRF),
   intercambia `code` por un token de usuario de corta duración, lo
   extiende a larga duración (`grant_type=fb_exchange_token`), y llama
   `GET /me/accounts` — los tokens de página que regresa esa llamada ya son
   de larga duración al derivar de un token de usuario largo.
3. **Selección de página** — si el usuario administra una sola página, se
   conecta automáticamente. Si administra varias, se listan temporalmente
   (no se persisten) y el usuario elige una antes de guardar. Para la
   página elegida se consulta `GET /{page-id}?fields=instagram_business_account`.
4. **Persistencia** — una función `service_role`-only guarda
   `facebook_page_id/name`, `page_access_token`,
   `instagram_business_account_id` y `status = 'ACTIVE'`. El token nunca
   forma parte de una respuesta JSON al navegador.
5. **Desconexión** — acción en Settings que llama a
   `revoke_meta_connection`: `status = 'REVOKED'`, se limpia el token.
6. **Salud del token** — antes de cada intento de publicación, el worker
   llama al endpoint de depuración de tokens de Meta
   (`GET /debug_token?input_token=...`). Si es inválido, marca la conexión
   `ERROR` y el target de publicación falla con un mensaje explícito de
   "reconectar Meta" en vez de agotar reintentos contra un token muerto.

## Adaptador de publicación

`lib/integrations/meta-publisher.ts` se extiende (conservando `preflight`)
con dos funciones nuevas, ambas recibiendo el token de página/IG por
parámetro — nunca leen variables de entorno para el token de una
organización específica, solo para configuración global de la app (`META_APP_ID`/`META_APP_SECRET`, usados en el intercambio OAuth).

### Facebook

- **Imagen única:** `POST /{page-id}/photos` con `url` (signed URL de
  Storage, TTL ~10 min), `caption` (headline + body + cta + hashtags),
  `published=true`. `GET /{post_id}?fields=permalink_url` para la URL
  canónica a guardar en `remote_url`.
- **Carrusel:** cada imagen se sube primero como foto no publicada
  (`published=false`) para obtener su `media_fbid`; luego
  `POST /{page-id}/feed` con `attached_media: [{media_fbid}, ...]` y
  `message`.

### Instagram

- **Imagen única:** `POST /{ig-user-id}/media` (`image_url`, `caption`) →
  contenedor; poll acotado (máx. ~60s, cada 2s) de su estado hasta que esté
  listo o falle; `POST /{ig-user-id}/media_publish` con el `creation_id`.
  `GET /{ig_media_id}?fields=permalink` para `remote_url`.
- **Carrusel:** cada imagen como contenedor hijo
  (`is_carousel_item=true`), un contenedor padre
  (`media_type=CAROUSEL`, `children=[...]`), poll, publish.

### Manejo de errores

Nueva clase `MetaPublishError extends Error` (mismo espíritu que
`CopyGuardrailError`): `readonly retryable: boolean`,
`readonly requiresReconnect: boolean`. Clasificación por código de error de
Meta:

| Situación | `retryable` | `requiresReconnect` |
|---|---|---|
| Rate limit / 5xx transitorio | `true` | `false` |
| Token inválido o revocado | `false` | `true` |
| Contenido rechazado por política, imagen inválida/demasiado grande | `false` | `false` |
| Timeout de poll de contenedor de Instagram | `true` | `false` |

`worker/entrypoint.ts` gana un `isPublishJobRetryable(error)` análogo a
`isCopyJobRetryable`, conectado al `DurableJobRunner` para el `kind = 'PUBLISH'`.

## Seguridad

- El `page_access_token` nunca llega al navegador — ni en la respuesta de
  conexión, ni en ninguna lectura vía RLS directa (la tabla no tiene
  política `authenticated`).
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
  plataformas) y cada fila de la tabla de clasificación de errores de
  arriba.
- **Migración `0018`**: siguiendo el patrón de
  `tests/content/copy-hashtags-migration.test.ts` — `authenticated` no
  puede leer `organization_meta_connections`; `get_meta_connection_status`
  no expone el token; el `check` de `automation_jobs.kind` acepta
  `PUBLISH`; ciclo enqueue/claim/complete calcado del de `COPY`.
- **`apply_publication_diagnosis`**: diagnóstico limpio → `APPROVED` + job
  encolado + evento `TARGET_AUTO_APPROVED`; diagnóstico con riesgo →
  permanece `PENDING_REVIEW` con `findings` en el evento de auditoría.
- **`approve_publication_target`** (regresión): aprobar manualmente también
  encola el job `PUBLISH`.
- **OAuth callback**: `state` inválido/expirado se rechaza; selección
  automática de página única; selector cuando hay varias; aserción
  explícita de que el token nunca aparece en el cuerpo de la respuesta al
  navegador.

## Preguntas resueltas durante el brainstorm (para no repetir la discusión)

- Alcance: Facebook + Instagram desde el día uno, imagen única y carrusel;
  video/Reels es un spec futuro aparte.
- Conexión: flujo OAuth completo por organización desde v1 (no token
  pegado a mano), porque el objetivo es ser replicable a muchos clientes.
- Postiz: evaluado y descartado como servicio a correr (sin Docker, Axel ya
  lo probó standalone y no le convenció); usado solo como referencia de
  diseño de los endpoints de Graph API.
- Meta App: Axel ya tiene una app configurada y un token de página de
  prueba funcionando — no se parte de cero para el desarrollo, aunque
  escalar a múltiples organizaciones cliente eventualmente requerirá que
  esa app pase el App Review de Meta para los permisos avanzados.
