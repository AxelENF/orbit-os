# Reconciliación de producto — 2026-09-17

## Corte verificado

La rama publicada `integration/main-consolidation` contiene el núcleo AIAS, la
biblioteca de campañas, generación y validación de copy, Logo Studio, OAuth de
Meta, worker durable de publicación y API v1. La suite local pasa con 613
pruebas; `tsc`, `eslint` y `next build` también pasan.

Esto no prueba una operación real: no existe `.env.local` en este checkout, no
hay evidencia nueva de la aplicación remota de `0018` a `0030`, ni smoke de
Auth/RLS/Storage/OAuth/worker con una cuenta Meta real.

## Endpoints actuales

| Grupo | Rutas | Estado para un agente |
| --- | --- | --- |
| API v1 por API key | `GET/POST /api/v1/campaigns`, `GET /api/v1/campaigns/:id`, `POST /api/v1/campaigns/:id/publish` | Base útil; la clave resuelve una organización y el payload de publicación se deriva en servidor. |
| Gestión de contenido con sesión | `/api/content`, `/api/content/:id`, `/copy`, `/final-copy`, `/preflight`, `/targets/*` | Funcional para portal; no es todavía el contrato estable de un agente externo. |
| Perfil y organizaciones | `/api/organizations`, `/active`, `/:id/profile`, `/:id/api-keys`, `/:id/logo` | Tenant-aware y apropiado para UI autenticada. |
| OAuth Meta | `/api/integrations/meta/connect`, `/callback`, `/connect/select`, `/status`, `/disconnect` | Implementado en código; pendiente de prueba real y de cifrado de tokens. |
| Worker e integraciones heredadas | `/api/internal/worker/health`, `/api/integrations/n8n/*` | Worker interno es la ruta objetivo; n8n sigue como bridge opcional. |

No existe todavía un endpoint MCP ni un servidor MCP dentro de Orbit. El plan
histórico lo menciona, pero no hay `app/api/mcp` ni herramientas registradas.

## Inconsistencias que se deben cerrar

1. `0018_meta_publisher.sql` guarda `page_access_token` como texto y la sesión
   temporal de OAuth también conserva un token de usuario. RLS evita la
   exposición al navegador, pero no cifra secretos de terceros dentro de los
   respaldos lógicos de la aplicación.
2. El worker lee `SNAPGAD_META_PUBLISH_WORKER_ENABLED`; `.env.example`, README
   y el runbook viejo aún documentan `SNAPGAD_PUBLISH_WORKER_ENABLED`.
3. `01-current-state.md`, `05-personal-pilot-production-plan.md`,
   `06-staging-pilot-runbook.md` y README describen preflight/manual como si
   fueran el estado actual, aunque el código ya contiene OAuth, cola de publish
   y Graph API.
4. Las migraciones `0018`–`0030` no se deben marcar como aplicadas sin comparar
   `supabase_migrations.schema_migrations` contra el repositorio y correr smoke
   autenticado. El estado anterior sólo documenta hasta `0017`.
5. API v1 aún no cubre el ciclo completo de un agente: faltan un contrato v1
   para enviar copy final, consultar diagnóstico/readiness, resultados y
   contexto de marca. Eso se resuelve antes de construir MCP.

## Decisiones de ejecución

- La primera etapa MCP será un servidor **local stdio**, no un endpoint remoto.
  Codex/Claude usarán una API key guardada sólo en variables del proceso local;
  el modelo no verá `SUPABASE_SERVICE_ROLE_KEY`, tokens Meta ni secretos OAuth.
- MCP nunca llama a Graph API ni a Supabase directamente. Sólo llama a Orbit
  API v1, que deriva tenant, aplica guardrails y deja auditoría.
- La carga de imágenes para el MCP local aceptará rutas locales sólo dentro de
  raíces explícitas configuradas por el operador. No acepta URLs arbitrarias ni
  base64 masivo.
- La publicación orgánica puede continuar automáticamente sólo cuando el
  diagnóstico persistido ya declara el target apto. Un agente no puede saltar
  findings, programar gasto publicitario ni crear claims fuera del perfil AIAS.

## Planes vinculados

- [Seguridad de base y staging](../superpowers/plans/2026-09-17-database-security-and-staging.md)
- [Control plane MCP para agentes](../superpowers/plans/2026-09-17-orbit-agent-mcp.md)
