# API v1 con claves por organización — diseño

**Fecha:** 2026-09-14 (revisado 2026-09-15 tras rondas 1 y 2 de Codex CLI)
**Estado:** Diseñado en vivo con Axel (preguntas de clarificación una a una, decisiones confirmadas en el momento) — no es una sesión autónoma retroactiva como las anteriores. Sesión en modo autónomo por instrucción explícita de Axel para la ejecución posterior ("despliega subagents en codex para la realización").
**Roadmap:** Primera mitad del cuarto ítem del orden de 4 partes acordado el 2026-09-14 (intake ✅ → navegación/IA ✅ → compositor de logo ✅ → **capa MCP**). La capa MCP resultó ser dos sub-proyectos independientes, decisión tomada durante este mismo brainstorm: **(1) esta API v1** y **(2) la envoltura MCP encima de ella**, cada una con su propio ciclo spec→plan→revisión. Este documento cubre solo (1).
**Rama:** `feat/api-v1-tenant-keys`, creada sobre `feat/logo-batch-compositor` (no sobre `feat/personal-pilot-hardening` directamente) — **dependencia real, no arbitraria:** la composición de logo server-side (ver más abajo) reutiliza `lib/logo-studio/compose.ts` y la ruta `app/api/organizations/[id]/logo/route.ts`, que solo existen en esa rama. Siguiente migración: `0019` (confirmado en ronda 2 — `0018_organization_logos_bucket.sql` ya existe, heredado de la rama de logo).

**Advertencia de dependencia entre ramas, importante para la secuencia de merge (no bloquea este spec, pero Axel debe saberlo):** esta rama NO incluye el publisher real de Meta (`feat/meta-publisher-oauth-adapter` es una rama hermana distinta, no mergeada). En esta rama, `lib/integrations/meta-publisher.ts` sigue siendo solo un preflight de configuración. El endpoint de publicación de este spec está diseñado para funcionar correctamente hoy contra el mecanismo real que ya existe (n8n) y para heredar automáticamente el comportamiento de ADR-008 el día que ese mecanismo exista — ver la sección de publicación.

## Contexto

`docs/vault/06-marketing-automation-handoff.md` (2026-09-12) ya registraba la intención original de Axel: exponer el pipeline como herramientas orquestables por un agente, con el sistema funcionando "principalmente a través de MCP". Existe además un plan nunca implementado, `docs/superpowers/plans/2026-09-07-operations-and-extensibility.md`, que ya proponía la arquitectura base (API v1 versionada + MCP como envoltura delgada). Esa arquitectura sigue siendo válida; lo que cambió es el contexto:

- Ese plan de 2026-09-07 es anterior a **ADR-008** (2026-09-12), que permite publicación automática por defecto con el diagnóstico determinista como red de seguridad — más permisivo que la restricción "MCP nunca publica" que proponía el plan viejo.
- Ninguna pieza de ese plan viejo se implementó nunca (verificado por grep).
- **ADR-008 es una decisión de producto adoptada, no un mecanismo ya ejecutable.** Su propio texto (`docs/vault/02-decisions.md:69`) dice explícitamente que el diseño técnico de cómo el publisher real consulta el diagnóstico "todavía no está especificado." Este spec no se bloquea en esa pieza faltante — ver la sección de publicación.
- **Hallazgo adicional de la ronda 2 de revisión, relevante para cualquier trabajo futuro de publicación (no solo este spec):** incluso el mecanismo de publicación que SÍ existe hoy (`lib/integrations/n8n-client.ts` + `preparePublishRequest`) tiene un vacío real — el callback de confirmación (`supabase/migrations/0003_ingest_publish_result_callback.sql:82-93`) exige una fila previa en `automation_runs` de tipo `PUBLISH_REQUEST`, pero `preparePublishRequest` (`lib/supabase/repository.ts:992-1017`) nunca la crea — solo el repositorio de demo lo simula (`lib/demo/repository.ts:480-505`). Esto significa que el flujo de publicación real, hoy, puede devolver `202` y fallar después con `PUBLISH_REQUEST_NOT_FOUND` en el callback. Es un vacío preexistente del pipeline de publicación, no introducido por este spec — se documenta aquí porque el endpoint `/publish` de esta API lo hereda tal cual, y corregirlo de raíz pertenece a quien sea dueño del pipeline de publicación, no a esta API. Axel debe saber que esto ya era así antes de este spec.
- Axel también había mencionado por separado una carpeta local de 8 kits standalone de Claude Code — **descartados explícitamente para este alcance** ("olvidalo, eso lo dejamos out, prioriza el marketer").

## Decisiones de alcance (tomadas en el brainstorm, en orden)

1. **¿Quién se conecta?** Cada organización cliente de Orbit OS — implica el sistema completo de claves por tenant.
2. **¿Qué nivel de acción tiene un agente conectado?** El mismo que el pipeline automático de ADR-008 tendrá una vez que exista.
3. **¿Entran los 8 kits locales?** No.
4. **¿Un spec o dos?** Dos — API v1 primero, capa MCP después.
5. **¿Scopes finos o clave con acceso completo?** Clave con acceso completo por organización, deliberadamente.
6. **¿Compositor de logo incluido?** Sí — logo baja a **2MB** de límite (ver corrección de consistencia más abajo), creativo usa el límite ya existente del pipeline compartido (`MAX_ASSET_BYTES`, 20MB).

## Arquitectura

### Autenticación: `organization_api_keys`

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

alter table public.organization_api_keys enable row level security;
```

**Corrección ronda 2 (hallazgo real — la ronda 1 solo describía la intención en prosa, sin SQL que la implemente):** la versión anterior de este spec creaba la tabla y prometía RLS "mismo patrón que `organization_integrations`" pero nunca escribía el `enable row level security` ni las políticas. Además, una política genérica `for all` con solo el chequeo de rol owner permitiría a un owner editar `created_by` de una clave para atribuirla a otro usuario. Resolución: **sin políticas de INSERT/UPDATE de propósito general.** Toda escritura pasa por dos RPCs `security definer` dedicadas — mismo patrón que el resto del esquema usa para mutaciones sensibles (p. ej. `approve_publication_target`):

```sql
create policy "Owners read their api keys" on public.organization_api_keys
  for select to authenticated
  using (public.has_organization_role(organization_id, array['owner']::public.organization_role[]));

-- Sin policy de insert/update/delete: solo las RPCs de abajo pueden escribir
-- esta tabla, y corren con privilegios de servicio, no con los del caller.

create function public.create_organization_api_key(p_organization_id uuid, p_label text)
returns table (id uuid, key_prefix text, secret text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text := 'sk_live_' || encode(gen_random_bytes(32), 'hex');
  v_hash text := encode(digest(v_secret, 'sha256'), 'hex');
  v_prefix text := left(v_secret, 12);
  v_id uuid;
begin
  if not public.has_organization_role(p_organization_id, array['owner']::public.organization_role[]) then
    raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER';
  end if;
  insert into public.organization_api_keys (organization_id, label, key_hash, key_prefix, created_by)
  values (p_organization_id, p_label, v_hash, v_prefix, auth.uid())
  returning organization_api_keys.id into v_id;
  return query select v_id, v_prefix, v_secret;
end;
$$;

create function public.revoke_organization_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
begin
  select organization_id into v_organization_id
  from public.organization_api_keys where id = p_key_id;
  if v_organization_id is null
     or not public.has_organization_role(v_organization_id, array['owner']::public.organization_role[]) then
    raise exception using errcode = 'P0001', message = 'NOT_ORGANIZATION_OWNER';
  end if;
  update public.organization_api_keys set revoked_at = now()
  where id = p_key_id and revoked_at is null;
end;
$$;

revoke all on function public.create_organization_api_key(uuid, text) from public, anon;
revoke all on function public.revoke_organization_api_key(uuid) from public, anon;
grant execute on function public.create_organization_api_key(uuid, text) to authenticated;
grant execute on function public.revoke_organization_api_key(uuid) to authenticated;
```

- El secreto se genera server-side dentro de la RPC (nunca lo elige el caller), se devuelve **una sola vez** en la respuesta de creación, y se persiste hasheado (sha-256, apto para secretos de alta entropía generados por el sistema — no bcrypt, pensado para contraseñas humanas de baja entropía).
- **Corrección ronda 2 (hallazgo real — la ronda 1 proponía `revoke select (key_hash) ... from authenticated`, que no tiene efecto si el rol ya tiene `SELECT` a nivel de tabla, que es como Supabase concede privilegios por defecto):**

```sql
revoke select on public.organization_api_keys from authenticated;
grant select (id, organization_id, label, key_prefix, created_by, created_at, last_used_at, revoked_at)
  on public.organization_api_keys to authenticated;
```

  Esto sí logra el aislamiento: `authenticated` pierde el privilegio de tabla completo y recupera solo las columnas seguras — `key_hash` queda fuera de ese grant, así que ninguna consulta directa con el cliente autenticado normal puede leerla, sin importar qué permita RLS a nivel de fila. La verificación de la clave (ver más abajo) corre con el cliente de **service role**, que **no está sujeto a RLS ni a estos grants de `authenticated`** — es un rol de Postgres distinto con su propio acceso completo por diseño de Supabase, no algo que dependa de estos GRANT/REVOKE.

### Gestión de claves — HTTP (nuevo, ausente en la versión anterior)

**Corrección ronda 2 (hallazgo real):** la versión anterior de este spec nunca definió cómo un owner realmente crea o revoca una clave desde la aplicación — solo describía la tabla. Estas rutas son **autenticadas por sesión** (el owner ya logueado en el dashboard), no por API key — son gestión, no la superficie v1 en sí:

- `POST /api/organizations/:id/api-keys` — body `{ label: string }`, llama a `create_organization_api_key`, responde `{ id, keyPrefix, secret }` (una sola vez).
- `GET /api/organizations/:id/api-keys` — lista metadatos (nunca `secret` ni `key_hash`).
- `DELETE /api/organizations/:id/api-keys/:keyId` — llama a `revoke_organization_api_key`.

### Autenticación de la superficie v1: header y verificación

Cada request a `/api/v1/*` lleva `Authorization: Bearer <secreto>`. Verificación:

1. Hashear el secreto recibido (sha-256), buscar en `organization_api_keys` con `revoked_at is null`, usando el cliente de **service role** (necesario porque no hay `auth.uid()` para una request externa — no hay sesión de la que depender).
2. Sin match → `401 INVALID_API_KEY`.
3. Con match, resolver `organization_id` y `created_by`. Buscar el rol real de `created_by` en `organization_members` para esa organización.
4. **Corrección ronda 2 (hallazgo real):** la ronda 1 asumía que si el owner pierde su rol, "la clave deja de funcionar" — pero nada en el código fuerza eso: `OrganizationContext` (`lib/organizations/context.ts:7-13`) acepta cualquier `OrganizationRole`, y las RPCs no todas exigen `owner` específicamente. Ahora la verificación **exige explícitamente `role === "owner"`** — si `created_by` ya no es owner de esa organización (cambió de rol, o ya no es miembro), la clave se trata como inválida: `401 INVALID_API_KEY`, el mismo código que una clave inexistente, sin distinguir el motivo al caller externo.
5. Con un owner válido confirmado, construir el mismo `OrganizationContext` que ya usa el resto del sistema (`{organizationId, userId: created_by, role: "owner"}`) y un repositorio **nuevo, construido para esta request únicamente** — nunca cacheado ni reutilizado entre requests concurrentes (a diferencia del `demoRepository` singleton de `repository-factory.ts:106-110`, que existe solo para el modo demo).
6. La API v1 **rechaza el modo demo/no-configurado explícitamente**: si `getContentRepositoryMode()` no es `"supabase"`, la ruta responde `503 INTEGRATION_NOT_CONFIGURED`.
7. **Corrección ronda 2 (manejo de errores faltante):** `requireOrganizationContext` (usado internamente al construir el contexto) puede lanzar `OrganizationAccessError` (`lib/organizations/context.ts:23-28`) si la membresía desapareció entre el paso 3 y el 5 — las rutas nuevas capturan ese tipo de error explícitamente y responden `401 INVALID_API_KEY`, igual que cualquier otro fallo de autenticación de esta superficie. No se deja que escape como una excepción sin manejar.

### Superficie v1 — `/api/v1/campaigns`

- **`GET /api/v1/campaigns`** — lista las campañas de la organización resuelta por la clave. Equivalente a `GET /api/content`.
- **`GET /api/v1/campaigns/:id`** — detalle, mismo shape que `ContentRecord` (content, asset, targets, drafts, auditEvents, publicationResults, finalCopy). No incluye un campo de "diagnóstico" — esa pieza depende del diseño técnico pendiente de ADR-008, no se inventa aquí.
- **`POST /api/v1/campaigns`** — crea una campaña. Mismo contrato que `POST /api/content`: `multipart/form-data`, campo `brief` (`campaignBriefSchema`) y campo `asset` (`validateAsset`/`MAX_ASSET_BYTES`, 20MB). Si la organización tiene un logo configurado, se estampa automáticamente server-side antes de seguir el pipeline (ver composición de logo). Sin logo configurado, la campaña se crea igual, sin error.

- **`POST /api/v1/campaigns/:id/publish`** — publica un target específico.

  **Corrección ronda 2 (hallazgo real de seguridad — el contrato anterior era explotable):** `n8nPublishRequestInputSchema` (`lib/integrations/n8n-client.ts:13-30`) exige `contentItemId`, `publicationTargetId`, `assetUrl` **y** `copy`, y `requestN8nPublish` reenvía `assetUrl`/`copy` tal cual al webhook de n8n **sin compararlos con lo almacenado**. La ruta interna de n8n (`app/api/integrations/n8n/publish/route.ts`) es segura porque su único caller legítimo hoy es interno. Un caller externo de API v1 NO debe poder declarar su propio `assetUrl`/`copy` — podría publicar contenido distinto del que realmente fue generado/aprobado. Por eso, el body público de este endpoint acepta **solo** `{ publicationTargetId: string, idempotencyKey?: string }`; la ruta **deriva** `contentItemId` (de la URL `:id`), `assetUrl` y `copy` leyendo el `ContentRecord` ya almacenado, y arma el payload completo para `requestN8nPublish` con esos valores server-side, nunca con lo que mande el caller.

  **Corrección ronda 2 (clasificación de errores todavía incompleta en la ronda 1):** la ronda 1 solo distinguía 404 (no existe/no es de esta organización) de 409 (existe pero no está `APPROVED`), pero `preparePublishRequest` (`lib/supabase/repository.ts:1003`) colapsa un **error real de consulta** en el mismo `PublishTargetConflictError` que "no encontrado" — un fallo transitorio de base de datos no debe convertirse en un falso `409 TARGET_NOT_APPROVED`. La ruta ahora distingue tres casos explícitamente: (1) consulta propia de existencia+pertenencia por `organization_id` que no encuentra fila → `404 TARGET_NOT_FOUND`; (2) esa misma consulta lanza una excepción real → `503 TARGET_LOOKUP_FAILED`; (3) fila encontrada pero no `APPROVED` → `409 TARGET_NOT_APPROVED`. Solo llegando limpio a (3) con estado `APPROVED` se procede a `requestN8nPublish`.

  **Vacío heredado, no de este spec (ver Contexto):** aun con lo anterior correcto, la falta de un registro `automation_runs`/`PUBLISH_REQUEST` en `preparePublishRequest` puede hacer que una publicación aparentemente aceptada falle después en el callback. Este spec no lo oculta ni lo intenta resolver — lo hereda igual que ya lo hereda hoy la ruta interna de n8n.

### Composición de logo server-side

Justificación de por qué esto no rompe la promesa de "las imágenes nunca salen del navegador" del compositor de logo original: esa promesa era específica al uso manual e interactivo en `/tools/logo-studio` — una llamada de API no tiene navegador en el medio, el creativo viaja por HTTP de todas formas.

- `computeLogoPlacement` (`lib/logo-studio/compose.ts:5-30`) es agnóstico de entorno y se reutiliza tal cual.
- `compositeToBlob` depende de DOM (canvas/`Image`) y necesita un puerto server-side (`sharp` o `@napi-rs/canvas` — decisión concreta en el plan, no en el spec).
- El logo se descarga del mismo bucket `organization-logos` que ya usa la ruta manual — no se duplica almacenamiento.
- **Corrección ronda 2 (inconsistencia real, no resuelta en la ronda 1):** la ronda 1 decía "el logo baja a 2MB" pero nunca comprometía el cambio concreto — `MAX_LOGO_BYTES` en `app/api/organizations/[id]/logo/route.ts:11` seguía en 5MB. Ahora es explícito: **esa constante cambia a `2 * 1024 * 1024` como parte de este plan**, aplicada tanto al `POST` de subida como a la validación del objeto descargado para composición (el `GET`/download hoy no revalida tamaño ni decodificación en absoluto, `:88-100,214-217` — el flujo nuevo sí lo hace). Un solo límite, un solo lugar de verdad, sin una subida manual pudiendo "colar" un logo que luego rompe la composición por API. Un logo ya subido por encima de 2MB antes de este cambio (borde teórico — no hay ningún logo real subido todavía en ningún entorno) se trata en la composición como fallo controlado (`503 LOGO_TOO_LARGE`), no como crash.
- El resultado compuesto se revalida con el mismo `validateAsset` que corre sobre cualquier asset antes de persistir — recalcula dimensiones, MIME y checksum sobre el archivo final, no sobre el creativo original.

**Explícitamente fuera de alcance:** el flujo humano `/library/new` no cambia — sigue sin estampar el logo automáticamente.

## Seguridad y auditoría

- Aislamiento entre organizaciones: cubierto por tests dedicados, mismo estándar que Logo Studio.
- **Corrección ronda 2 (hallazgo real — el mecanismo de la ronda 1 no existía):** la ronda 1 proponía que `actor_id` fuera el `uuid` del owner y `metadata` cargara `{"via": "api_key", ...}`, y afirmaba que ninguna RPC necesitaba cambiar. Falso: las RPCs actuales insertan `metadata` con `jsonb_build_object(...)` de campos fijos, sin ningún parámetro para adjuntar contexto extra (ver p. ej. `supabase/migrations/0009_tenantize_content_and_jobs.sql:207-211`). Las RPCs relevantes para acciones que la API v1 puede disparar (creación de campaña, solicitud de publicación) se extienden con un parámetro opcional `p_actor_metadata jsonb default '{}'::jsonb`, fusionado (`||`) dentro del `jsonb_build_object` existente — la lista exacta de RPCs a tocar se enumera en el plan. `actor_id` sigue siendo el `uuid` real del owner (sin cambios de esquema); `metadata` gana `{"via": "api_key", "apiKeyId": "...", "apiKeyLabel": "..."}` cuando la acción vino de una clave.
- Revocación: una clave revocada deja de **autenticar** desde el siguiente request en adelante — no cancela requests ya en vuelo ni invalida URLs firmadas ya emitidas (10 minutos de validez, `lib/supabase/repository.ts:754-758`, sin cambios).
- Sin rate-limiting en esta primera versión — recorte deliberado (YAGNI).
- Sin scopes finos por acción — decisión deliberada de Axel.

## Fuera de alcance (explícito)

- Scopes granulares por acción.
- Estampado automático de logo en el flujo manual `/library/new`.
- Los 8 kits locales de Claude Code.
- El diseño técnico pendiente de ADR-008.
- Arreglar el vacío preexistente de `automation_runs`/`PUBLISH_REQUEST` en el pipeline de publicación — heredado, documentado, no resuelto aquí.
- La envoltura MCP en sí — sub-proyecto siguiente.
- Rate-limiting.

## Testing (nivel de spec, detalle real en el plan)

- Claves hasheadas verificadas correctamente; clave revocada, o cuyo creador ya no es owner, deja de autenticar (mismo `401 INVALID_API_KEY` en ambos casos, sin distinguir el motivo).
- `create_organization_api_key`/`revoke_organization_api_key` rechazan a un no-owner; ninguna policy de INSERT/UPDATE de propósito general existe sobre la tabla.
- `key_hash` nunca viaja en ninguna respuesta ni es alcanzable por el cliente autenticado normal — verificado también a nivel de grant de columna (`grant select (...)` explícito, no un `revoke` de columna sobre un rol que igual conserva SELECT de tabla).
- Ningún cross-tenant leak en `GET`/`publish`: recurso de otra organización responde `404`.
- Publicación: target inexistente o de otra organización → 404; error real de consulta → 503 (nunca 409 falso); target no aprobado → 409; target aprobado → sigue el mismo camino que ya usa `preparePublishRequest`/n8n hoy, con `assetUrl`/`copy` derivados del registro almacenado, nunca del body del caller.
- Creación de campaña vía API con logo configurado produce un asset con el logo compuesto y revalidado; sin logo, produce el asset sin logo, sin error; logo heredado por encima de 2MB → fallo controlado, no crash.
- Repositorio construido de cero por request; modo demo/no-configurado responde 503, nunca sirve datos falsos a un caller real.
- RPCs extendidas con `p_actor_metadata` siguen aceptando el flujo existente sin ese parámetro (default `{}`), sin romper los callers de sesión actuales.
