# API v1 con claves por organización — diseño

**Fecha:** 2026-09-14 (revisado 2026-09-15 tras ronda 1 de Codex CLI)
**Estado:** Diseñado en vivo con Axel (preguntas de clarificación una a una, decisiones confirmadas en el momento) — no es una sesión autónoma retroactiva como las anteriores. Sesión en modo autónomo por instrucción explícita de Axel para la ejecución posterior ("despliega subagents en codex para la realización").
**Roadmap:** Primera mitad del cuarto ítem del orden de 4 partes acordado el 2026-09-14 (intake ✅ → navegación/IA ✅ → compositor de logo ✅ → **capa MCP**). La capa MCP resultó ser dos sub-proyectos independientes, decisión tomada durante este mismo brainstorm: **(1) esta API v1** y **(2) la envoltura MCP encima de ella**, cada una con su propio ciclo spec→plan→revisión. Este documento cubre solo (1).
**Rama:** `feat/api-v1-tenant-keys`, creada sobre `feat/logo-batch-compositor` (no sobre `feat/personal-pilot-hardening` directamente) — **dependencia real, no arbitraria:** la composición de logo server-side (ver más abajo) reutiliza `lib/logo-studio/compose.ts` y la ruta `app/api/organizations/[id]/logo/route.ts`, que solo existen en esa rama.

**Corrección ronda 1 (hallazgo real):** la siguiente migración de esta rama es `0019`, no `0018` — `supabase/migrations/0018_organization_logos_bucket.sql` ya existe, heredado de `feat/logo-batch-compositor`. El "0018 distinto en cada rama hermana" documentado en memoria aplica a ramas independientes partiendo de `feat/personal-pilot-hardening`; esta rama, al estar apilada sobre la de logo, no repite ese patrón — simplemente continúa la numeración que ya trae.

**Advertencia de dependencia entre ramas, importante para la secuencia de merge (no bloquea este spec, pero Axel debe saberlo):** esta rama NO incluye el publisher real de Meta (`feat/meta-publisher-oauth-adapter` es una rama hermana distinta, no mergeada, no ancestro de `feat/personal-pilot-hardening`). En esta rama, `lib/integrations/meta-publisher.ts` sigue siendo solo un preflight de configuración (`meta-publisher.ts:16-19`, comentario propio: "Deliberately a configuration boundary, not a publisher"). El endpoint de publicación de este spec (ver más abajo) está diseñado para funcionar correctamente hoy Y para heredar automáticamente el comportamiento real de ADR-008 el día que esa rama se mergee — pero no se puede validar contra un publisher real hasta entonces.

## Contexto

`docs/vault/06-marketing-automation-handoff.md` (2026-09-12) ya registraba la intención original de Axel: exponer el pipeline (generar imagen externamente, poner logo, generar copy, publicar) como herramientas orquestables por un agente, con el sistema funcionando "principalmente a través de MCP". Existe además un plan nunca implementado, `docs/superpowers/plans/2026-09-07-operations-and-extensibility.md`, que ya proponía la arquitectura base: una API v1 versionada como contrato estable, con MCP como envoltura delgada sobre un subconjunto de esa API. Esa arquitectura sigue siendo válida; lo que cambió es el contexto que la rodea:

- Ese plan de 2026-09-07 es anterior a **ADR-008** (2026-09-12), que ya permite publicación automática por defecto con el diagnóstico determinista como única red de seguridad. El plan viejo proponía que MCP nunca pudiera aprobar ni publicar — una restricción que hoy sería más estricta que lo que el propio sistema automático ya se permite a sí mismo.
- Ninguna pieza de ese plan viejo (`api_keys`, `/api/v1/*`, MCP) se implementó nunca — se verificó en este brainstorm (`grep` de `api_keys`/`apiKey` en el código real no encontró nada fuera de docs).
- **Corrección ronda 1 (hallazgo real, matiza el punto anterior):** ADR-008 es una decisión de producto adoptada, pero su propio texto (`docs/vault/02-decisions.md:69`) dice explícitamente: *"esta ADR registra la decisión de producto; el diseño técnico de cómo el publisher real de Meta consulta el diagnóstico antes de publicar... todavía no está especificado."* El mecanismo de "publicar automáticamente salvo que el diagnóstico marque riesgo" **no existe como código ejecutable todavía, en ninguna rama** — solo existe la función de diagnóstico (`lib/aias/publication-diagnosis.ts`) de forma aislada, y el flujo de publicación actual (`lib/integrations/n8n-client.ts`) sigue exigiendo que un target ya esté `APPROVED` antes de intentar publicarlo. Este spec se diseña para no bloquearse en esa pieza faltante — ver la sección de publicación más abajo.
- Axel también había mencionado por separado una carpeta local de 8 kits standalone de Claude Code (memoria `project_orbit_os_claude_kits_reference.md`) como posible inspiración para "hacer más cosas con un agente vía MCP". Se preguntó explícitamente si debían incorporarse — **Axel los descartó para este alcance** ("olvidalo, eso lo dejamos out, prioriza el marketer"). No son parte de este documento ni del siguiente.

## Decisiones de alcance (tomadas en el brainstorm, en orden)

1. **¿Quién se conecta?** Cada organización cliente de Orbit OS, no solo Axel — implica el sistema completo de claves por tenant, no una conexión local personal.
2. **¿Qué nivel de acción tiene un agente conectado?** El mismo que el pipeline automático de ADR-008 tendrá una vez que exista — ver la advertencia sobre esa pieza pendiente arriba. No hay una capa de permisos más restrictiva que la que el sistema ya se permite a sí mismo.
3. **¿Entran los 8 kits locales?** No. Fuera de alcance, descartado explícitamente. El foco es el pipeline de marketing existente ("el marketer").
4. **¿Un spec o dos?** Dos — API v1 primero (este documento), capa MCP después, cada uno con su propio ciclo de revisión.
5. **¿Scopes finos por acción o clave con acceso completo?** Clave con acceso completo por organización. Los scopes finos (`campaigns:read`, `publish:execute`, etc.) se descartan por ahora — no hay ninguna restricción real que estén protegiendo, dado el punto 2. Se documenta como decisión deliberada, no como omisión.
6. **¿Compositor de logo incluido?** Sí, con dos ajustes de tamaño confirmados por Axel: el logo de la organización baja de 5MB a **2MB** de límite; el creativo adjunto usa el límite que **ya rige el pipeline compartido** (`MAX_ASSET_BYTES` en `lib/content/asset-validation.ts`, 20MB) — no un número nuevo inventado para esta API.

## Arquitectura

### Autenticación: `organization_api_keys`

Tabla nueva, mismo patrón de `organization_integrations` (`supabase/migrations/0008_tenancy_foundation.sql:37-46`):

```sql
create table if not exists public.organization_api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  key_hash text not null unique,
  key_prefix text not null check (length(key_prefix) = 12),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Corrección ronda 1 (hallazgo real): RLS filtra FILAS, no columnas — una
-- política de "solo el owner puede leer" no impide que una consulta directa
-- pida la columna key_hash si el rol tiene privilegio sobre ella. Se revoca
-- el privilegio de columna explícitamente; key_hash solo es legible por el
-- rol de servicio (usado exclusivamente dentro de la función de
-- verificación server-only, nunca en una ruta que devuelva la fila entera
-- al cliente).
revoke select (key_hash) on public.organization_api_keys from authenticated;
```

- La clave se genera una sola vez (`sk_live_<32+ bytes aleatorios>`), se muestra completa solo en el momento de creación, y se persiste **hasheada** (`key_hash`, sha-256 sobre el secreto completo — apto para secretos de alta entropía generados por el sistema, a diferencia de bcrypt que está pensado para contraseñas de baja entropía escritas por humanos). `key_prefix` guarda los primeros caracteres visibles (p. ej. `sk_live_a1b2`) para que el dueño identifique cuál clave es cuál sin volver a ver el secreto completo.
- RLS: solo el owner de la organización puede crear, listar (metadatos, nunca `key_hash` — protegido además a nivel de columna, ver arriba) o revocar claves — mismo gate que `organization_integrations` ya usa (`has_organization_role(organization_id, array['owner']::public.organization_role[])`).

### Principal de la request (corrección ronda 1 — el diseño anterior no producía lo que el resto del sistema exige)

**Hallazgo real:** el diseño original de este spec resolvía solo `organization_id` desde la clave y lo trataba como contexto ya confiado. Pero `createContentRepository` (`lib/content/repository-factory.ts:140-193`) construye un `OrganizationContext` con `organizationId`, `userId` **y** `role`, y ese contexto se pasa a `createSupabaseRepository`, cuyos RPCs exigen `assert_organization_actor` con un miembro real con rol (`supabase/migrations/0009_tenantize_content_and_jobs.sql:95-114`). Resolver solo el id de organización no alcanza — y crear un actor sintético (un `auth.users` falso para "la clave") es una complejidad nueva que rompe supuestos del resto del esquema (perfiles, auditoría) sin necesidad real.

**Resolución:** la clave de API actúa **con la identidad del owner que la creó** (`created_by`). Al verificar la clave:
1. Hashear el secreto recibido, buscar la fila en `organization_api_keys` con `revoked_at is null`.
2. Si no hay match → `401 INVALID_API_KEY`.
3. Si hay match, resolver `organization_id` y `created_by` de esa fila, y construir el mismo `OrganizationContext` que ya usa el resto del sistema, mirando el rol real de `created_by` en `organization_members` para esa organización (debe seguir siendo owner — si el owner perdió ese rol o fue removido después de crear la clave, la clave deja de funcionar hasta que otro owner la reemplace; esto es intencional, no un bug).
4. Construir un repositorio nuevo con `createSupabaseServiceRoleClient()` + ese `OrganizationContext`, exactamente como ya hace `createContentRepository` — se reutiliza `createSupabaseRepository` sin modificarlo.

Esto significa que ninguna RPC ni política existente necesita cambiar: para el resto del sistema, una request autenticada por API key es indistinguible en shape de una request de sesión, solo cambia cómo se llegó a `userId`/`role`.

**Corrección ronda 1 (aislamiento por request):** el repositorio se construye **de cero en cada request** — nunca se reutiliza ni se cachea entre requests concurrentes (a diferencia del `demoRepository` singleton de `repository-factory.ts:106-110`, que existe solo para el modo demo sin red). La API v1 además **rechaza explícitamente el modo demo**: si `getContentRepositoryMode()` devuelve `"demo"` o `"misconfigured"`, la ruta responde `503 INTEGRATION_NOT_CONFIGURED` en vez de servir datos de demostración a una integración externa real.

### Superficie v1 — `/api/v1/campaigns`

Todas las rutas reutilizan la lógica de `lib/content/repository.ts` ya existente — esta API es una fachada de autenticación distinta sobre el mismo dominio, no un pipeline paralelo.

- **`GET /api/v1/campaigns`** — lista las campañas de la organización resuelta por la clave. Equivalente a `GET /api/content` (`app/api/content/route.ts:24-48`) pero con auth por clave.
- **`GET /api/v1/campaigns/:id`** — detalle de una campaña. Devuelve el mismo shape que ya expone `ContentRecord` (`lib/content/repository.ts:239-247`: content, asset, targets, drafts, auditEvents, publicationResults, finalCopy). **Corrección ronda 1:** el spec original prometía un campo de "estado del diagnóstico" que no existe en `ContentRecord` — se retira esa promesa de este documento. Exponer el diagnóstico de riesgo de ADR-008 (`lib/aias/publication-diagnosis.ts`, una función distinta a `createCampaignPreflight`) es una extensión natural una vez que el diseño técnico pendiente de ADR-008 exista; no se inventa aquí sobre una pieza que todavía no está especificada.
- **`POST /api/v1/campaigns`** — crea una campaña. Mismo contrato que `POST /api/content` (`app/api/content/route.ts:68-147`): `multipart/form-data` con campo `brief` (JSON validado por `campaignBriefSchema`, `lib/content/campaign.ts:16-23`) y campo `asset` (el creativo, validado por `validateAsset`/`MAX_ASSET_BYTES`). **Diferencia real con el camino humano:** si la organización tiene un logo configurado, el logo se estampa sobre el creativo automáticamente, server-side, antes de seguir el resto del pipeline — ver la sección de composición de logo. Si la organización no tiene logo todavía, la campaña se crea igual, sin logo, sin error.
- **`POST /api/v1/campaigns/:id/publish`** — dispara la publicación de un target específico.
  **Corrección ronda 1 (contrato incompleto en la versión anterior):** el body requiere `publicationTargetId` (una campaña puede tener targets de Facebook e Instagram simultáneamente — el llamador elige cuál) y acepta un `idempotencyKey` opcional (si se omite, se genera uno nuevo), igual que ya exige `lib/content/repository.ts:114-118` / `lib/integrations/n8n-client.ts:13-30`.
  **Corrección ronda 1 (clasificación de errores):** `preparePublishRequest` (`lib/supabase/repository.ts:992-1007`) devuelve el mismo `PublishTargetConflictError` tanto para "el target no existe / no pertenece a esta organización" como para "existe pero no está `APPROVED` todavía" — colapsar ambos en la respuesta filtraría a un caller externo si un target de OTRA organización existe o no. La ruta hace la distinción ella misma, en dos pasos: (1) una consulta propia de existencia+pertenencia por `organization_id`, que responde `404 TARGET_NOT_FOUND` si no hay fila para esta organización, sin filtrar si existe para otra; (2) solo si (1) pasa, llama a `preparePublishRequest` y traduce cualquier conflicto restante (ya sabemos que el target existe y es de esta organización) a `409 TARGET_NOT_APPROVED`.
  **Sobre "publicar sin aprobación humana" (ver advertencia de la cabecera):** hoy, esto significa que el target debe haber llegado a estado `APPROVED` por el camino que sea (hoy: revisión humana vía `/review`; en el futuro: automáticamente, cuando el mecanismo técnico de ADR-008 exista). Este endpoint no implementa ni simula ese mecanismo — llama al mismo `preparePublishRequest` que ya usa el resto del sistema, así que heredará el comportamiento de ADR-008 automáticamente el día que esa pieza se construya, sin necesitar cambios aquí.

### Composición de logo server-side

Justificación de por qué esto no rompe la promesa de "las imágenes nunca salen del navegador" del compositor de logo original: esa promesa era específica al uso manual e interactivo en `/tools/logo-studio`, con una persona operando un navegador. Una llamada de API hecha por un agente externo no tiene navegador en el medio — el creativo viaja por HTTP de todas formas, es inherente a ser una API. La promesa nunca aplicó a este camino.

- La matemática pura de posicionamiento (`computeLogoPlacement`, `lib/logo-studio/compose.ts:5-30`) es agnóstica de entorno (no usa DOM, verificado) y se reutiliza tal cual.
- El renderizado (`compositeToBlob`, `lib/logo-studio/compose.ts:32-59`) sí depende de `document.createElement("canvas")` y `Image`, ambos inexistentes en Node — necesita un puerto server-side equivalente (a decidir en el plan: `sharp` o `@napi-rs/canvas` son las opciones típicas de Node; la elección concreta y su justificación quedan para la fase de plan, no de spec).
- El logo de la organización se descarga del mismo bucket `organization-logos` que ya usa la ruta manual (`app/api/organizations/[id]/logo/route.ts`) — no se duplica almacenamiento.
- Límite del logo: baja de 5MB a **2MB**. **Corrección ronda 1 (hallazgo real):** `MAX_LOGO_BYTES` hoy solo se valida en el `POST` de subida (`app/api/organizations/[id]/logo/route.ts:11,146-155`) — el `GET`/descarga no revalida tamaño ni intenta decodificar el archivo. El flujo server-side nuevo debe validar tamaño y decodificación del logo **descargado** antes de compositarlo, no asumir que ya es válido solo porque pasó la subida en algún momento anterior (pudo subirse antes de bajar el límite a 2MB, por ejemplo).
- Límite del creativo: `MAX_ASSET_BYTES` (20MB, `lib/content/asset-validation.ts:8`) — el que ya rige `POST /api/content`, heredado sin cambios.
- **Corrección ronda 1 (hallazgo real, integridad del resultado):** el resultado de componer el logo sobre el creativo cambia bytes, y potencialmente MIME y dimensiones — no se puede persistir directamente. El asset compuesto pasa por **el mismo `validateAsset`** (`lib/content/asset-validation.ts:135-...`) que ya corre sobre cualquier asset antes de `createContentItemWithAsset`, recalculando dimensiones, MIME y checksum sobre el resultado final, no sobre el creativo original.

**Explícitamente fuera de alcance:** el flujo humano `/library/new` no cambia — sigue sin estampar el logo automáticamente. Extender ese comportamiento ahí es una mejora válida pero distinta (toca el pipeline manual existente, no solo la superficie de API nueva); queda anotada como pendiente futuro, no se mezcla en este spec ni en su plan.

## Seguridad y auditoría

- Aislamiento entre organizaciones: ninguna clave de la organización A puede leer o modificar datos de la organización B — cubierto por tests dedicados, mismo estándar que ya se aplicó al bucket de logos.
- **Corrección ronda 1 (schema real):** `audit_events.actor_id` es `uuid references public.profiles(id)` (`supabase/migrations/0001_content_os.sql:96-104`), no un campo de texto libre — la idea original de escribir `"api_key:<label>"` ahí no encaja. En su lugar: `actor_id` guarda el `uuid` real del owner (`created_by`, el mismo principal resuelto arriba — ya es un `profiles.id` válido, sin cambios de esquema), y la columna `metadata jsonb` (ya existente en la tabla, `0001_content_os.sql:103`) lleva `{"via": "api_key", "api_key_id": "...", "api_key_label": "..."}`. Esto distingue una acción disparada por API de una hecha en sesión de navegador sin tocar el esquema de auditoría.
- **Corrección ronda 1 (alcance real de "revocación inmediata"):** una clave revocada deja de **autenticar** desde el siguiente request en adelante — no cancela requests ya en vuelo, y no invalida URLs firmadas ya emitidas durante una request anterior (las URLs firmadas de `getContentRecord`, `lib/supabase/repository.ts:754-758`, ya duran 10 minutos por diseño, independientemente de la clave que las pidió). Es el mismo límite que ya existe para cualquier otra revocación de acceso en este sistema; no se promete algo más fuerte de lo que la arquitectura actual puede dar.
- Sin rate-limiting en esta primera versión — recorte deliberado de alcance (YAGNI), no un descuido. Se agrega si se vuelve un problema real medido, no de forma preventiva.
- Sin scopes finos por acción — ver decisión 5 arriba.

## Fuera de alcance (explícito)

- Scopes granulares por acción (`campaigns:read`, `publish:execute`, ...).
- Estampado automático de logo en el flujo manual `/library/new`.
- Los 8 kits locales de Claude Code.
- El diseño técnico pendiente de ADR-008 (cómo el publisher real consulta el diagnóstico antes de publicar) — pieza propia, con su propio spec, no de esta API.
- La envoltura MCP en sí (herramientas orquestables por un agente) — sub-proyecto siguiente, spec aparte, depende de que esta API exista y esté mergeada primero.
- Rate-limiting.

## Testing (nivel de spec, detalle real en el plan)

- Claves hasheadas verificadas correctamente; una clave revocada deja de autenticar en el siguiente request, sin excepción.
- Ningún cross-tenant leak: pedir un recurso de otra organización con una clave válida responde `404`, nunca confirma ni niega existencia con detalle.
- `key_hash` nunca viajero en ninguna respuesta de la API, verificado también a nivel de privilegio de columna (no solo por omisión accidental en el código de serialización).
- Creación de campaña vía API con logo configurado produce un asset con el logo compuesto y revalidado (dimensiones/MIME/checksum recalculados); sin logo configurado, produce el asset sin logo, sin error.
- Publicación vía API: target inexistente o de otra organización → 404; target existente pero no `APPROVED` → 409; target `APPROVED` → sigue exactamente el mismo camino que ya usa `preparePublishRequest`/n8n hoy.
- Repositorio construido de cero por request — un test concurrente con dos claves de dos organizaciones distintas confirma que ninguna ve datos de la otra, sin depender de orden de ejecución.
- Modo demo/no-configurado responde `503`, nunca sirve datos falsos a un caller de API real.
- Límites de tamaño (2MB logo, incluyendo el descargado; `MAX_ASSET_BYTES` creativo) rechazados con el código de estado correcto.
