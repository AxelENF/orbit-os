# Bitácora de ejecución

## 2026-09-10 — Preparación de publicación en GitHub y migraciones locales

- Auditoría Git: rama actual `feat/content-os-mvp`, sin remoto `origin` y sin cambios publicados desde este entorno. El proyecto queda preparado para un repositorio nuevo con slug `snapgad-orbit` y nombre de producto SnapGad Orbit.
- Auditoría de base local: `npx supabase@2.117.0` responde, pero no existe `supabase/config.toml`, Postgres local ni daemon Docker activo. No se ejecutó `supabase db reset` ni se alteró ninguna base; la aplicación de migraciones queda pendiente de una instancia local/staging válida.
- Se confirmó que no hay credenciales reales en el árbol de trabajo. El commit/push sólo debe incluir código, migraciones y vault; nunca `.env.local`, tokens ni claves de servicio.

## 2026-09-10 — Guardrail visual: escala realista de laptops

- Auditoría visual de creativos web y Web + Bot IA: la laptop aparece sobredimensionada de forma repetida, reduce el espacio negativo y puede percibirse como monitor/maqueta, lo que debilita credibilidad.
- Añadida regla obligatoria a `04-contracts-and-guardrails.md`: ultrabook de 13–14 pulgadas y relación 16:10, laptop completa en 32–42 % del área visual, pantalla visible máximo 46 % de la altura del lienzo 1080 × 1350, márgenes mínimos de 8 %, escritorio visible y revisión de proporción antes de aceptar el arte.
- La regla se aplicará a todos los prompts y revisiones futuras de creativos SnapGad con laptop; una pieza con escala imposible se regenera aunque conserve el resto del estilo aprobado.

## 2026-09-10 — Cierre de fase: runner durable y auditoría operativa

- `codebase-memory-mcp` reindexado en modo `full` con persistencia; último estado `ready`, 1,684 nodos y 5,192 relaciones, `skipped_count=0`. La cobertura registrada conserva generación `2026-09-10T08:13:47Z`; las 12 migraciones SQL siguen `parse_partial` y se conservan con revisión directa como fuente de verdad; `.env.example` permanece excluido por diseño de gitignore.
- Suite completa: `npm test -- --run` — 50 archivos, 263 pruebas, todas pasan.
- Calidad estática: `npx tsc --noEmit` y `npm run lint` — pasan sin errores. Build: `npm run build` — compila y genera correctamente las rutas, incluido `/api/internal/worker/health`.
- Runner persistente listo en `worker/durable-runner.ts` y `worker/entrypoint.ts`: polling, heartbeat de lease, recuperación de leases vencidos, retry/dead-letter delegado al store y apagado por `SIGTERM`/`SIGINT`. `npm run worker` falla cerrado si faltan Supabase service-role o `SNAPGAD_COPY_WORKER_MODULE`; con el módulo placeholder inexistente termina antes de reclamar jobs.
- Health interno `GET /api/internal/worker/health` exige bearer token constante y no expone payloads. No se realizaron llamadas a Meta, OpenRouter, n8n ni Supabase remoto.
- Pendiente de staging: aplicar 0013, validar RLS/leases con jobs reales y conectar un processor de copy explícito. El runner no publica por sí mismo mientras ese processor no esté instalado y aprobado.

## 2026-09-09 — Reindexado posterior al adapter durable

- Codebase-memory reindexado en modo `full` con persistencia; generación `2026-09-10T00:36:46Z`, estado `ready`, 1,631 nodos y 4,909 relaciones, `skipped_count=0` (snapshot histórico antes del runner).
- La cobertura de los archivos TypeScript, rutas, tests y documentación operados no reporta gaps; las 12 migraciones SQL permanecen `parse_partial` y se revisan directamente como fuente de verdad.

## 2026-09-09 — Adaptador durable Supabase y health interno (staging-prep)

- Añadido `lib/automation/supabase-copy-worker-store.ts`: adapter server-only para claim scoped por provider/organización, URL firmada de `content-assets`, renovación de lease, completion, retry/dead-letter, cancelación, recuperación de leases vencidos y health agregado. El cache sólo conserva ownership del lease durante el proceso; Postgres sigue siendo la fuente de verdad.
- Ampliada `supabase/migrations/0013_automation_job_lifecycle.sql` con RPCs de claim atómico, renew, fail con backoff, cancel, recovery y resumen de health. La migración sigue sin aplicarse a Supabase real y el SQL está marcado `parse_partial` por el indexador; se revisó directamente.
- Añadido `GET /api/internal/worker/health`, bearer-token gated y con comparación constante; no usa sesión de navegador ni devuelve payloads. Añadido `SNAPGAD_WORKER_HEALTH_TOKEN` al ejemplo de entorno.
- Cerrada una brecha de error: un asset sin URL firmada ahora registra `COPY_JOB_ASSET_URL_FAILED` mediante el RPC de fail aun cuando el job no haya entrado al cache local.
- Pruebas focales: store Supabase, contrato durable, forma de migración y health endpoint — 14 pruebas pasan. No se hicieron llamadas a Meta, OpenRouter, n8n ni Supabase remoto.
- Añadidos `worker/durable-runner.ts`, `worker/entrypoint.ts` y `npm run worker`: polling persistente, heartbeat configurable, recuperación periódica y apagado por `SIGTERM`/`SIGINT`. El arranque exige Supabase service-role y `SNAPGAD_COPY_WORKER_MODULE`; sin processor explícito termina con error antes de reclamar jobs.
- `server-only` quedó como dependencia directa del wrapper usado por las rutas Next; el worker importa el core sin ejecutar el marcador de componentes cliente.

## 2026-09-09 — Auditoría intermedia de la fase durable (snapshot histórico)

- Suite completa: `npm test -- --run` — 49 archivos, 258 pruebas, todas pasan.
- Calidad estática: `npx tsc --noEmit` y `npm run lint` — pasan sin errores.
- Build: `npm run build` — Next.js compila y genera las rutas/páginas del proyecto, incluido `/api/internal/worker/health`.
- Integridad: `git diff --check` — código sin errores; sólo avisos normales de conversión LF/CRLF.
- Límite explícito de ese snapshot: no se había aplicado `0013` en Supabase ni se habían realizado llamadas externas. El runner persistente se cerró posteriormente en la entrada del 2026-09-10.

## 2026-09-09 — Reindexado después de la fase UI/worker

- Codebase-memory reindexado en modo `full` con artefacto persistente `.codebase-memory/graph.db.zst`.
- Generación `2026-09-09T10:22:02Z`, estado `indexed`, 1,567 nodos y 4,623 relaciones, `skipped_count=0`.
- Las 12 migraciones SQL aparecen como `parse_partial`; se revisan siempre como fuente directa. La cobertura de TypeScript/TSX/documentación no reporta gaps, aunque el metadato de archivos recién editados requiere lectura directa y reindexado ya realizado.

## 2026-09-09 — Auditoría final de esta ejecución

- Suite completa: `npm test -- --run` — 47 archivos, 250 pruebas, todas pasan.
- Calidad estática: `npx tsc --noEmit` y `npm run lint` — pasan sin errores.
- Build: `npm run build` — Next.js compila y genera 21 páginas/rutas sin error.
- Integridad: `git diff --check` — código 0; sólo avisos normales de conversión LF/CRLF de Git.
- Seguridad/operación: no se aplicaron migraciones remotas, no se usó service-role en browser, no se llamó Meta/OpenRouter/n8n para publicar y no se desactivó el puente n8n.
- Auditoría correctiva: el handler de perfil ahora mapea fallos de `session` y `context.params` a respuestas 503 controladas; se añadió regresión focal para ambos casos.

## 2026-09-09 — Onboarding AIAS conectado y prueba de regresión

- Añadido `components/aias/profile-form.tsx`: formulario por organización para identidad, rubro, oferta, cliente ideal, dolores, pruebas permitidas, tono, CTA y claims prohibidos.
- El formulario usa únicamente la API autenticada de perfil, envía `expectedVersion` en actualizaciones y muestra conflictos/errores sin ocultar el límite de demo local.
- Integrado en `/onboarding` y `/settings/organizations`; el selector activo determina el `organizationId` visible y no se acepta un tenant arbitrario fuera de la membresía que ya valida el servidor.
- Añadida prueba de UI para modo demo sin red y guardado versionado; foco de páginas de organizaciones conservado.
- Verificación focal: 2 archivos, 4 pruebas; TypeScript y ESLint de los archivos UI correctos.
- Se inició la siguiente unidad acotada del worker durable con contrato explícito; ninguna migración remota ni publicación Meta se ejecuta automáticamente.

## 2026-09-09 — Contrato de ciclo durable del worker

- Añadido `lib/automation/durable-job-contract.ts` con estados, transiciones, agenda mínima (`runAt`/`nextAttemptAt`), provider key y ownership de lease.
- Añadida `supabase/migrations/0013_automation_job_lifecycle.sql` como migración aditiva para retry/dead-letter/cancelación. Depende de 0010-0011, permanece sin aplicar y no añade RPCs ni llamadas externas.
- Añadidas pruebas de contrato y de forma SQL; la integración durable, heartbeat, polling y health HTTP siguen pendientes de staging.

## 2026-09-08 — Auditoría y consolidación AIAS

- Revisado el estado real del repositorio y las migraciones.
- Confirmado que el modo predeterminado es demo y que no hay una base remota configurada en este entorno.
- Confirmado que el publisher Meta actual es solamente preflight.
- Confirmado que n8n tiene exportación/bridge, pero no debe considerarse worker interno.
- Confirmado que la resolución actual rechaza más de una membresía; todavía falta selector de organización activa.
- Creado el plan `docs/superpowers/plans/2026-09-08-aias-multiorganization-core.md`.
- Creado este vault para centralizar contexto y decisiones.
- Verificado que no hay un MCP de codebase expuesto en las herramientas disponibles.

## 2026-09-08 — Inicio de implementación

- Creado el vault versionado en `docs/vault/`.
- Delegada la primera unidad acotada: contratos y validación del perfil AIAS.
- La instalación de un MCP de codebase queda pendiente de identificar un servidor o plugin concreto; no existe uno disponible con ese nombre en esta sesión.

## 2026-09-08 — Contrato AIAS inicial

- Añadido `lib/aias/contracts.ts` con perfil empresarial, preferencias de workflow, plataformas y zona horaria.
- Añadido `lib/aias/brief.ts` para convertir el perfil de organización en contexto determinista y resolver campos de campaña sin asumir el pitch de SnapGad.
- Añadido `forbiddenClaims` al contrato de contenido para preservar restricciones por organización.
- Prueba focalizada: `tests/aias/brief.test.ts` — 3/3 pasan.

## 2026-09-08 — Verificación de MCP codebase

- Revisado `C:\Users\AxelENF\.codex\config.toml` y el inventario de herramientas.
- El único MCP local configurado es `node_repl`.
- En ese momento todavía no había un servidor `codebase` expuesto en la sesión.
- Posteriormente se instaló el servidor oficial `codebase-memory-mcp`; esta entrada conserva el diagnóstico histórico y no describe el estado actual.

## 2026-09-08 — codebase-memory-mcp instalado

- Fuente: `DeusData/codebase-memory-mcp`.
- Instalado `codebase-memory-mcp 0.10.8` en `C:\Users\AxelENF\AppData\Local\Programs\codebase-memory-mcp`.
- El instalador verificó el checksum SHA-256 del release antes de activar el binario.
- Codex quedó configurado en `C:\Users\AxelENF\.codex\config.toml` con MCP, SessionStart y SubagentStart hooks.
- Proyecto indexado: `C:/Users/AxelENF/Documents/Codex/2026-08-27/pode/snapgad-content-os`.
- Índice generado: 1,121 nodos y 3,172 relaciones.
- El índice excluye `.git`, `.next`, `.superpowers`, `node_modules` y `supabase/.temp` por diseño.
- Las migraciones SQL quedaron con parseo parcial; el índice sigue siendo útil para TypeScript/TSX, pero las consultas SQL requerirán revisión directa de archivos.

## 2026-09-09 — MCP conectado, reindexado y ADR persistido

- El servidor `mcp__codebase_memory_mcp__*` quedó disponible en esta sesión.
- Se confirmó el proyecto `C-Users-AxelENF-Documents-Codex-2026-08-27-pode-snapgad-content-os` en la rama `feat/content-os-mvp`.
- Se reindexó el estado actual del repositorio con modo `full` y artefacto persistente `.codebase-memory/graph.db.zst`.
- Generación del índice: `2026-09-09T05:38:24Z`; estado `ready`; 1,122 nodos y 3,173 relaciones.
- La cobertura no tiene archivos omitidos por error (`skipped_count=0`); las 10 migraciones SQL conservan rangos `parse_partial` y deberán revisarse directamente antes de cambios SQL.
- Se verificó cobertura de los archivos de organizaciones, repositorio, AIAS y alta de campañas; todos reportan `no_recorded_issue`, aunque sus metadatos cambiaron y deben reindexarse después de cada edición relevante.
- Se persistió el ADR inicial de arquitectura AIAS mediante `manage_adr`; el vault sigue siendo la fuente legible para decisiones y operación.

## 2026-09-09 — Primera mejora AIAS: selector seguro de organización

- Añadido `lib/organizations/active-organization.ts` con resolución explícita de la organización activa.
- Un usuario con varias membresías ya no se resuelve por posición; debe enviar una selección que coincida con una membresía autenticada.
- Un id inexistente se rechaza con `OrganizationAccessError`; no existe fallback silencioso entre tenants.
- `createContentRepository` acepta el hint únicamente como entrada validable; todavía falta leerlo de una cookie firmada y construir la UI de cambio/onboarding.
- Añadidas pruebas de contrato para selección única, selección múltiple, id no perteneciente y compatibilidad del factory.
- Añadido `lib/organizations/active-organization-cookie.ts` con HMAC-SHA256, expiración y binding al `userId`.
- Añadidos `lib/organizations/active-organization-handler.ts` y `app/api/organizations/active/route.ts`: el cambio de organización valida sesión/membresía y escribe una cookie `httpOnly` sólo después de esa validación.
- Verificación local: 35 archivos de prueba, 173 pruebas; lint, `git diff --check` y build Next.js sin errores.
- Reindexado posterior a los cambios: generación confirmada `2026-09-09T07:23:21Z`, 1,170 nodos y 3,306 relaciones; `adr_present=true`, `skipped_count=0`, con las 10 migraciones SQL aún marcadas como `parse_partial`.
- La consulta de cobertura registra `generation_matches=true` y `no_recorded_issue` en los archivos operados, pero también `metadata_changed`; el watcher debe refrescar esos metadatos antes de usar el grafo para afirmaciones exhaustivas.
- Build de producción corregido y verificado: Next.js compiló TypeScript, rutas y páginas sin errores.

## Próxima ejecución autorizada

1. Implementar onboarding y perfil AIAS.
2. Integrar la cookie activa en todos los handlers y construir onboarding/selector visual.
3. Escribir pruebas de contrato antes de modificar persistencia SQL.
4. Preparar el worker interno en modo demo/in-memory.
5. Después solicitar configuración de staging para aplicar migraciones y probar Supabase.

## 2026-09-09 — Paralelización controlada AIAS

- Se creó el objetivo de implementación para cerrar el núcleo AIAS sin publicar ni aplicar migraciones.
- Se delegaron en paralelo dos unidades sin solapamiento: onboarding/selector/API de organizaciones y diagnóstico determinista de publicaciones.
- Evidencia previa al trabajo: grafo `ready`, generación `2026-09-09T07:23:21Z`, 1,170 nodos y 3,306 relaciones; cobertura `no_recorded_issue` con `metadata_changed` en archivos operados. Las migraciones SQL siguen `parse_partial` y no se usaron para inferir más de lo que la fuente permite.
- Onboarding: añadido `GET /api/organizations` autenticado con `Cache-Control: no-store`, cookie activa HMAC validada por usuario/membership, selector accesible, pantallas de onboarding/settings y CTA de creación explícitamente no destructivo. Se integró el selector en `AppShell` sólo cuando existe configuración pública de Supabase; demo local no hace llamadas extra.
- Diagnóstico: añadido `lib/aias/publication-diagnosis.ts` con score explicable, hallazgos `error/warning/info`, dolor/oportunidad, audiencia explícita, ángulo marcado como inferido, CTA, claims permitidos/bloqueados y recomendaciones. Tras revisión de especificación se corrigieron overlaps fail-closed, `readyForCopy` inseguro y divergencia de schema/runtime.
- Revisiones: onboarding aprobado por revisión de especificación sin hallazgos P0-P3; el diagnóstico tuvo dos P1 iniciales y quedó corregido por el implementador con pruebas nuevas. La revisión de calidad queda en curso antes del cierre.
- Verificación local de esta fase: `npm test -- --run` — 39 archivos, 186 pruebas; `npx tsc --noEmit` — correcto; `npm run lint` — correcto; build de Next.js ejecutado tras la integración, pendiente de registrar su salida final si el proceso termina sin error.

## 2026-09-09 — Cierre de brechas de revisión

- La revisión de calidad detectó y se corrigió el bypass de aliases/first-wins del diagnóstico, CTA narrativo falso, urgencia/rankings no detectados y evasión por whitespace. El diagnóstico exige una única fuente de señal, fusiona campañas de forma conservadora y bloquea `readyForCopy` ante cualquier riesgo.
- La revisión del workspace detectó rutas de onboarding/settings fuera del matcher y switchers duplicados. `proxy.ts` ahora protege `/onboarding` y `/settings/:path*`; `AppShell` omite el switcher global en esas páginas para conservar una única instancia.
- El selector y las páginas validan el payload de organizaciones y rechazan un id activo que no pertenezca a la lista recibida. En demo local se muestra un estado explícito en lugar de intentar una integración real.
- Verificación final de código: `npm test -- --run` — 40 archivos, 199 pruebas; `npx tsc --noEmit` — correcto; `npm run lint` — correcto; `npm run build` — correcto (rutas `/api/organizations`, `/onboarding` y `/settings/organizations` generadas).
- Reindexado final codebase-memory: generación `2026-09-09T08:08:30Z`, 1,289 nodos y 3,669 aristas, `skipped_count=0`, `adr_present=true`; las 10 migraciones SQL permanecen `parse_partial` y no se modificaron en esta fase.
- Revisiones de calidad finales: onboarding sin P0/P1/P2; diagnóstico sin P0/P1 y con un P2 de contrato (`funnelStage`/`offer` aún no persistidos en la salida), reservado para la integración futura del proveedor de copy.

## 2026-09-09 — Siguiente fase: contratos locales AIAS y kernel de jobs

- Implementado `lib/organizations/profile-repository.ts` como adaptador explícito en memoria: aislamiento por `organizationId`, creación en versión 1, actualizaciones con `expectedVersion` obligatorio, hash SHA-256, auditoría por organización, snapshots inmutables y metadata JSON plana, finita y acíclica. No se precarga perfil de SnapGad.
- Implementado `worker/job-runner.ts` con estados `QUEUED`, `PROCESSING`, `RETRY_WAIT`, `COMPLETED`, `FAILED`, `CANCELLED` y `DEAD_LETTER`; idempotencia por organización/kind/key; leases, renovación, recuperación, backoff, dead-letter, cancelación y health determinista.
- Implementados adapters inyectables locales para copy y publicación en `worker/providers/`; no llaman a Meta, n8n, OpenRouter ni red externa.
- Añadidas pruebas focalizadas: perfil 11/11 y worker 15/15. Las revisiones de especificación y calidad no dejaron BLOCKER/MAJOR al cierre; el worker fue corregido para exigir `organizationId` y `leaseToken` en operaciones tenant-facing.
- Límites preservados: no se modificaron migraciones, rutas de producción, `package.json`, Meta ni Supabase; todavía falta el repositorio durable, RPCs/leases persistentes, proceso worker y staging.
- Calidad pendiente explícita: el worker productivo deberá renovar leases automáticamente para proveedores lentos; el kernel actual sólo expone renovación manual y `runOnce` no hace heartbeat. `markFailed` queda como helper interno, no como API tenant-facing.
- Quality gate de la fase: `npm test -- --run` — 42 archivos, 225 pruebas; `npx tsc --noEmit` — correcto; `npm run lint` — correcto; `npm run build` — correcto. `git diff --check` — limpio.
- Codebase-memory reindexado después de los cambios: generación `2026-09-09T09:02:57Z`, 1,423 nodos y 4,085 relaciones, `skipped_count=0`, artefacto persistente actualizado. Las 10 migraciones SQL siguen `parse_partial` y no se aplicaron.

## 2026-09-09 — Persistencia AIAS y API de perfil preparada para staging

- Añadida `supabase/migrations/0011_aias_profiles.sql` sin ejecutarla: columnas AIAS versionadas, historial por organización, RLS de lectura y RPC security-definer con actor autenticado, roles owner/editor, advisory lock y hash canonicalizado.
- Añadido `lib/organizations/supabase-profile-repository.ts`: cliente Supabase inyectado, sin service-role, lectura/guardado versionado e historial; mantiene el modo demo independiente.
- Añadida `app/api/organizations/[id]/profile/route.ts`: GET/PUT/PATCH con membership autenticada, actor derivado de sesión, control de roles, `expectedVersion`, no-store/Vary Cookie, límite de 256 KB y profundidad JSON acotada.
- Pruebas de esta unidad: repositorio Supabase 7/7 y API 8/8; la suite global queda en 44 archivos y 238 pruebas antes del hardening final de esta entrada.
- Revisiones de especificación: la escritura directa heredada `FOR ALL` fue detectada y cerrada antes de integrar; persisten sólo límites de staging: migración/RLS reales, shape del RPC, conexión de UI y validación con usuarios Supabase reales.
- Quality gate final de la fase: `npm test -- --run` — 44 archivos, 240 pruebas; `npx tsc --noEmit` — correcto; `npm run lint` — correcto; `npm run build` — correcto; `git diff --check` — limpio.
- Codebase-memory reindexado después del hardening: generación `2026-09-09T09:27:28Z`, 1,514 nodos y 4,459 relaciones, `skipped_count=0`, artefacto persistente actualizado. La migración 0011 y las anteriores siguen con cobertura `parse_partial`; se revisaron directamente y no se aplicaron.
