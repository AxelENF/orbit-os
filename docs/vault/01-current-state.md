# Estado actual — 2026-09-10

## Resumen

SnapGad Content OS tiene una base local sólida para campañas, borradores, copy final, revisión, auditoría y una frontera durable de jobs. Sigue siendo demo por defecto y todavía no publica automáticamente en Meta; el esquema persistente ya está aplicado y verificado en el proyecto Supabase conectado.

## Consolidado

- Next.js + React + TypeScript.
- Repositorio demo en memoria cuando no existen variables Supabase.
- Repositorio Supabase aplicado al proyecto `zsljrjuebdgcyinexdlj`; el historial remoto contiene `0001`–`0017` en orden.
- Validación server-side de PNG/JPEG/WEBP, máximo 20 MB y formato vertical 4:5.
- Bucket privado `content-assets` creado y verificado como no público.
- Organizaciones, membresías, roles y RLS definidos en migraciones.
- `organization_id` agregado a entidades de contenido y jobs.
- `automation_jobs` con idempotencia, claim, lease y completion para copy.
- Bridge n8n firmado e inactivo; no es el flujo operativo predeterminado.
- Meta limitada a preflight; no existe publisher real.
- UI local navegable para biblioteca, nuevo contenido, revisión, borradores e historial.
- Contrato AIAS para perfil y preferencias de workflow, con defaults seguros y claims prohibidos.
- Resolver de organización activa validado contra memberships, codec HMAC y `POST /api/organizations/active` con cookie `httpOnly`.
- Listado autenticado `GET /api/organizations`, selector accesible y pantallas de onboarding/organizaciones; el perfil AIAS ya se carga y guarda desde ambas pantallas cuando existe configuración pública de Supabase, y muestra un límite explícito en demo local.
- Diagnóstico determinista de publicaciones AIAS con score, hallazgos, claims fail-closed y recomendación de revisión humana; aún no genera copy ni publica.
- Contrato local de perfil AIAS con versionado optimista, hash SHA-256, auditoría y validación de metadata JSON acíclica; además existe adaptador Supabase con RPC/historial. Falta el smoke test con usuarios Auth reales.
- Kernel local de jobs con leases, recuperación, reintentos, dead-letter, cancelación, health y adapters inyectables; todavía no consulta Supabase ni ejecuta Meta/n8n.
- Persistencia AIAS aplicada mediante `0011_aias_profiles.sql`, con historial append-only y adaptador Supabase con RPC/versionado; falta probarlo con una sesión Auth real.
- Contrato portable del worker durable, enum de estados de `0012_automation_job_status_values.sql`, RPCs de `0013_automation_job_lifecycle.sql` y adaptador `SupabaseCopyWorkerStore` aplicados; el worker aún requiere un processor de copy explícito y pruebas de jobs reales.
- Endpoint interno `GET /api/internal/worker/health` protegido por token de servicio y sin payloads de jobs; reporta sólo telemetría agregada cuando existe store durable configurado.
- Runner persistente `worker/durable-runner.ts` y entrypoint `npm run worker` con polling, heartbeat, recuperación y configuración fail-closed; requiere un processor de copy explícito y no hace llamadas de proveedor por defecto.
- API autenticada `/api/organizations/[id]/profile` con GET/PUT/PATCH, roles y límites de payload/profundidad; está conectada al formulario de onboarding/settings. La migración/RLS existe, pero falta el smoke test con usuarios y membresías reales.
- Registro manual de entrega por destino: URL HTTPS, fecha y nota opcional con idempotencia, auditoría y tenant scope. La migración `0016_manual_publication_delivery.sql` ya está aplicada; falta el smoke con usuario Auth y publicación real.
- Snapshots manuales de resultados por destino: alcance, impresiones, conversaciones, leads calificados, citas, gasto/ingreso MXN y nota opcional. La migración `0017_publication_result_snapshots.sql` ya está aplicada; el sistema conserva observaciones y no atribuye ROI automáticamente.

## Brecha adicional detectada

`lib/content/contracts.ts` todavía limita `businessLine`, `service` y `niche` a enums globales de SnapGad. Para una AIAS multi-organización esto no es suficiente: el perfil del cliente debe poder definir su propio catálogo o aceptar valores controlados por organización. La migración debe conservar validación, pero no bloquear rubros válidos de clientes nuevos.

## No consolidado

- Crear organización y completar el onboarding de perfil AIAS en staging con usuarios Supabase reales.
- Integrar la cookie activa en los handlers de contenido restantes y validar el cambio de organización contra cada ruta mutante.
- Operar el worker interno persistente con un processor de copy explícito y smoke test durable.
- Smoke test de store durable/RPC con un usuario Auth, un asset privado y un job real.
- Retries, dead-letter y recuperación operativa completa.
- OAuth Meta por organización.
- Cifrado/rotación de credenciales de proveedores.
- Publicación real Facebook/Instagram.
- Delivery URL compatible con el fetch externo de Meta.
- Storage local como adaptador explícito.
- Validar RLS, storage y shape de RPC con usuarios reales en staging.

## Evidencia principal

- `README.md`
- `lib/content/repository-factory.ts`
- `lib/content/asset-validation.ts`
- `lib/automation/jobs.ts`
- `lib/integrations/meta-publisher.ts`
- `supabase/migrations/0008_tenancy_foundation.sql`
- `supabase/migrations/0009_tenantize_content_and_jobs.sql`
- `supabase/migrations/0010_automation_jobs.sql`
- `supabase/migrations/0011_aias_profiles.sql`
- `supabase/migrations/0012_automation_job_status_values.sql`
- `supabase/migrations/0013_automation_job_lifecycle.sql`
- `lib/automation/supabase-copy-worker-store.ts`
- `app/api/internal/worker/health/route.ts`
