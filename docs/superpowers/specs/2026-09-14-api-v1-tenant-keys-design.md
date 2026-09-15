# API v1 con claves por organización — diseño

**Fecha:** 2026-09-14
**Estado:** Diseñado en vivo con Axel (preguntas de clarificación una a una, decisiones confirmadas en el momento) — no es una sesión autónoma retroactiva como las anteriores. Sesión en modo autónomo por instrucción explícita de Axel para la ejecución posterior ("despliega subagents en codex para la realización").
**Roadmap:** Primera mitad del cuarto ítem del orden de 4 partes acordado el 2026-09-14 (intake ✅ → navegación/IA ✅ → compositor de logo ✅ → **capa MCP**). La capa MCP resultó ser dos sub-proyectos independientes, decisión tomada durante este mismo brainstorm: **(1) esta API v1** y **(2) la envoltura MCP encima de ella**, cada una con su propio ciclo spec→plan→revisión. Este documento cubre solo (1).
**Rama:** `feat/api-v1-tenant-keys`, creada sobre `feat/logo-batch-compositor` (no sobre `feat/personal-pilot-hardening` directamente) — **dependencia real, no arbitraria:** la composición de logo server-side (ver más abajo) reutiliza `lib/logo-studio/compose.ts` y la ruta `app/api/organizations/[id]/logo/route.ts`, que solo existen en esa rama. Próxima migración de esta rama: `0018` (sexta rama hermana en reclamar ese número de forma independiente — patrón ya documentado y deliberadamente diferido, ver [[project-orbit-os-marketing-automation-roadmap]]).

## Contexto

`docs/vault/06-marketing-automation-handoff.md` (2026-09-12) ya registraba la intención original de Axel: exponer el pipeline (generar imagen externamente, poner logo, generar copy, publicar) como herramientas orquestables por un agente, con el sistema funcionando "principalmente a través de MCP". Existe además un plan nunca implementado, `docs/superpowers/plans/2026-09-07-operations-and-extensibility.md`, que ya proponía la arquitectura base: una API v1 versionada como contrato estable, con MCP como envoltura delgada sobre un subconjunto de esa API. Esa arquitectura sigue siendo válida; lo que cambió es el contexto que la rodea:

- Ese plan de 2026-09-07 es anterior a **ADR-008** (2026-09-12), que ya permite publicación automática por defecto con el diagnóstico determinista como única red de seguridad. El plan viejo proponía que MCP nunca pudiera aprobar ni publicar — una restricción que hoy sería más estricta que lo que el propio sistema automático ya se permite a sí mismo.
- Ninguna pieza de ese plan viejo (`api_keys`, `/api/v1/*`, MCP) se implementó nunca — se verificó en este brainstorm (`grep` de `api_keys`/`apiKey` en el código real no encontró nada fuera de docs).
- Axel también había mencionado por separado una carpeta local de 8 kits standalone de Claude Code (memoria `project_orbit_os_claude_kits_reference.md`) como posible inspiración para "hacer más cosas con un agente vía MCP". Se preguntó explícitamente si debían incorporarse — **Axel los descartó para este alcance** ("olvidalo, eso lo dejamos out, prioriza el marketer"). No son parte de este documento ni del siguiente.

## Decisiones de alcance (tomadas en el brainstorm, en orden)

1. **¿Quién se conecta?** Cada organización cliente de Orbit OS, no solo Axel — implica el sistema completo de claves por tenant, no una conexión local personal.
2. **¿Qué nivel de acción tiene un agente conectado?** El mismo que el pipeline automático ya tiene bajo ADR-008 — incluida la publicación sin aprobación humana cuando el diagnóstico no marca riesgo real. No hay una capa de permisos más restrictiva que la que ya existe.
3. **¿Entran los 8 kits locales?** No. Fuera de alcance, descartado explícitamente. El foco es el pipeline de marketing existente ("el marketer").
4. **¿Un spec o dos?** Dos — API v1 primero (este documento), capa MCP después, cada uno con su propio ciclo de revisión.
5. **¿Scopes finos por acción o clave con acceso completo?** Clave con acceso completo por organización. Los scopes finos (`campaigns:read`, `publish:execute`, etc.) se descartan por ahora — no hay ninguna restricción real que estén protegiendo, dado el punto 2. Se documenta como decisión deliberada, no como omisión.
6. **¿Compositor de logo incluido?** Sí, con dos ajustes de tamaño confirmados por Axel: el logo de la organización baja de 5MB a **2MB** de límite; el creativo adjunto usa el límite que **ya rige el pipeline compartido** (`MAX_ASSET_BYTES` en `lib/content/asset-validation.ts`, 20MB) — no un número nuevo inventado para esta API. (Nota de corrección: en la conversación se mencionó 10MB por analogía con el dropzone de Logo Studio; verificar contra el código real mostró que el endpoint que esta API realmente reutiliza — `POST /api/content`, ver Arquitectura — ya usa 20MB, y ese es el límite correcto a heredar.)

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
```

- La clave se genera una sola vez (`sk_live_<32+ bytes aleatorios>`), se muestra completa solo en el momento de creación, y se persiste **hasheada** (`key_hash`, con un algoritmo de hash apto para secretos de alta entropía — no bcrypt, que está pensado para contraseñas de baja entropía escritas por humanos; sha-256 sobre el secreto completo es razonable aquí). `key_prefix` guarda los primeros caracteres visibles (p. ej. `sk_live_a1b2`) para que el dueño identifique cuál clave es cuál sin volver a ver el secreto completo.
- RLS: solo el owner de la organización puede crear, listar (metadatos, nunca el hash) o revocar claves — mismo gate que `organization_integrations` ya usa (`has_organization_role(organization_id, array['owner']::public.organization_role[])`), aplicado tanto a `select` como al resto de operaciones.
- **Verificación de una clave entrante es estructuralmente distinta al resto de la app:** no hay sesión de Supabase Auth ni `auth.uid()` para una llamada de API externa, así que no se puede apoyar en RLS de la forma habitual. La ruta verifica el `Authorization: Bearer <clave>` hasheando el valor recibido y buscándolo con el cliente de **service role** (el único camino legítimo para resolver "a qué organización pertenece esta clave" antes de que exista cualquier contexto de tenant). Una vez resuelto `organization_id` desde la fila encontrada — nunca desde la URL ni el body — el resto de la request opera con ese id ya confiado, exactamente como hoy las rutas de sesión resuelven `organization_id` vía `organization_members` antes de tocar cualquier dato de negocio.
- Revocación: `revoked_at` no nulo invalida la clave de inmediato — la verificación siempre filtra `revoked_at is null`, sin ningún cache intermedio.

### Superficie v1 — `/api/v1/campaigns`

Todas las rutas reutilizan la lógica de `lib/content/repository.ts` ya existente — esta API es una fachada de autenticación distinta sobre el mismo dominio, no un pipeline paralelo.

- **`GET /api/v1/campaigns`** — lista las campañas de la organización resuelta por la clave. Equivalente a `GET /api/content` (`app/api/content/route.ts:24-48`) pero con auth por clave.
- **`GET /api/v1/campaigns/:id`** — detalle de una campaña (copy, targets, estado del diagnóstico). Rechaza (404, sin filtrar información) cualquier id que no pertenezca a la organización de la clave.
- **`POST /api/v1/campaigns`** — crea una campaña. Mismo contrato que `POST /api/content` (`app/api/content/route.ts:68-147`): `multipart/form-data` con campo `brief` (JSON validado por `campaignBriefSchema`, `lib/content/campaign.ts:16-23`) y campo `asset` (el creativo, validado por `validateAsset`/`MAX_ASSET_BYTES`). **Diferencia real con el camino humano:** si la organización tiene un logo configurado (`organization-logos/{organization_id}/logo.png`), el logo se estampa sobre el creativo automáticamente, server-side, antes de seguir el resto del pipeline (validación de asset → `createContentItemWithAsset` → `enqueueCopyJob`) — ver siguiente sección. Si la organización no tiene logo todavía, la campaña se crea igual, sin logo, sin error (mismo comportamiento que tendría un creativo subido manualmente sin logo configurado).
- **`POST /api/v1/campaigns/:id/publish`** — dispara la publicación de un target, sujeto al mismo diagnóstico determinista que ya usa el pipeline automático bajo ADR-008. No es un atajo que se salte esa verificación.

### Composición de logo server-side

Justificación de por qué esto no rompe la promesa de "las imágenes nunca salen del navegador" del compositor de logo original: esa promesa era específica al uso manual e interactivo en `/tools/logo-studio`, con una persona operando un navegador. Una llamada de API hecha por un agente externo no tiene navegador en el medio — el creativo viaja por HTTP de todas formas, es inherente a ser una API. La promesa nunca aplicó a este camino.

- La matemática pura de posicionamiento (`computeLogoPlacement`, `lib/logo-studio/compose.ts:5-30`) ya es agnóstica de entorno (no usa DOM) y se reutiliza tal cual.
- El renderizado (`compositeToBlob`, `lib/logo-studio/compose.ts:32-59`) sí depende de `document.createElement("canvas")` y `Image`, ambos inexistentes en Node — necesita un puerto server-side equivalente (a decidir en el plan: `sharp` o `@napi-rs/canvas` son las opciones típicas de Node; la elección concreta y su justificación quedan para la fase de plan, no de spec).
- El logo de la organización se descarga del mismo bucket `organization-logos` que ya usa la ruta manual (`app/api/organizations/[id]/logo/route.ts`) — no se duplica almacenamiento.
- Límite del logo: baja de 5MB a **2MB**, aplicado en el mismo lugar que ya lo valida (`MAX_LOGO_BYTES`, `app/api/organizations/[id]/logo/route.ts:11`) — un único límite para el mismo tipo de archivo, sin importar si se subió manualmente o se está leyendo para este flujo.
- Límite del creativo: `MAX_ASSET_BYTES` (20MB, `lib/content/asset-validation.ts:8`) — el que ya rige `POST /api/content`, heredado sin cambios.

**Explícitamente fuera de alcance:** el flujo humano `/library/new` no cambia — sigue sin estampar el logo automáticamente. Extender ese comportamiento ahí es una mejora válida pero distinta (toca el pipeline manual existente, no solo la superficie de API nueva); queda anotada como pendiente futuro, no se mezcla en este spec ni en su plan.

## Seguridad y auditoría

- Aislamiento entre organizaciones: ninguna clave de la organización A puede leer o modificar datos de la organización B — cubierto por tests dedicados, mismo estándar que ya se aplicó al bucket de logos.
- Cada acción ejecutada vía clave de API queda atribuida a `"api_key:<label>"` en los eventos de auditoría existentes del dominio de contenido — distinguible de una acción hecha por un usuario humano con sesión, sin crear un sistema de auditoría paralelo.
- Sin rate-limiting en esta primera versión — recorte deliberado de alcance (YAGNI), no un descuido. Se agrega si se vuelve un problema real medido, no de forma preventiva.
- Sin scopes finos por acción — ver decisión 5 arriba.

## Fuera de alcance (explícito)

- Scopes granulares por acción (`campaigns:read`, `publish:execute`, ...).
- Estampado automático de logo en el flujo manual `/library/new`.
- Los 8 kits locales de Claude Code.
- La envoltura MCP en sí (herramientas orquestables por un agente) — sub-proyecto siguiente, spec aparte, depende de que esta API exista y esté mergeada primero.
- Rate-limiting.

## Testing (nivel de spec, detalle real en el plan)

- Claves hasheadas verificadas correctamente; una clave revocada deja de autenticar en el siguiente request, sin excepción.
- Ningún cross-tenant leak: pedir un recurso de otra organización con una clave válida responde como si no existiera (404), nunca 403 con detalle (no confirmar ni negar existencia a quien no tiene acceso).
- Creación de campaña vía API con logo configurado produce un asset con el logo compuesto; sin logo configurado, produce el asset sin logo, sin error.
- Publicación vía API respeta el mismo diagnóstico que el pipeline automático — un caso que el diagnóstico marcaría para revisión humana se comporta igual sin importar si el trigger fue una sesión de navegador o una clave de API.
- Límites de tamaño (2MB logo, `MAX_ASSET_BYTES` creativo) rechazados con el código de estado correcto, coherente con lo que ya hacen las rutas equivalentes de sesión.
