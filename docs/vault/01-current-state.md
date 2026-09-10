# Estado actual — 2026-09-09

## Resumen

SnapGad Content OS tiene una base local sólida para campañas, borradores, copy final, revisión, auditoría y una primera frontera de jobs. Sigue siendo demo por defecto y no es todavía una SaaS operativa conectada a Meta.

## Consolidado

- Next.js + React + TypeScript.
- Repositorio demo en memoria cuando no existen variables Supabase.
- Repositorio Supabase preparado, pero sin migraciones aplicadas a un proyecto conectado desde este entorno.
- Validación server-side de PNG/JPEG/WEBP, máximo 20 MB y formato vertical 4:5.
- Bucket privado `content-assets` previsto para assets.
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
- Contrato local de perfil AIAS con versionado optimista, hash SHA-256, auditoría y validación de metadata JSON acíclica; además existe adaptador Supabase con RPC/historial, pendiente de staging real.
- Kernel local de jobs con leases, recuperación, reintentos, dead-letter, cancelación, health y adapters inyectables; todavía no consulta Supabase ni ejecuta Meta/n8n.
- Preparación de persistencia AIAS: migración `0011_aias_profiles.sql`, historial append-only y adaptador Supabase con RPC/versionado; la migración aún no está aplicada.
- Contrato portable del worker durable, RPCs aditivos de ciclo de vida en `0013_automation_job_lifecycle.sql` y adaptador `SupabaseCopyWorkerStore` preparados; el kernel en memoria sigue siendo la única ejecución local hasta aplicar/probar staging.
- Endpoint interno `GET /api/internal/worker/health` protegido por token de servicio y sin payloads de jobs; reporta sólo telemetría agregada cuando existe store durable configurado.
- Runner persistente `worker/durable-runner.ts` y entrypoint `npm run worker` con polling, heartbeat, recuperación y configuración fail-closed; requiere un processor de copy explícito y no hace llamadas de proveedor por defecto.
- API autenticada `/api/organizations/[id]/profile` con GET/PUT/PATCH, roles y límites de payload/profundidad; está conectada al formulario de onboarding/settings, pero aún no está validada con RLS real.

## Brecha adicional detectada

`lib/content/contracts.ts` todavía limita `businessLine`, `service` y `niche` a enums globales de SnapGad. Para una AIAS multi-organización esto no es suficiente: el perfil del cliente debe poder definir su propio catálogo o aceptar valores controlados por organización. La migración debe conservar validación, pero no bloquear rubros válidos de clientes nuevos.

## No consolidado

- Crear organización y completar el onboarding de perfil AIAS en staging con usuarios Supabase reales.
- Integrar la cookie activa en los handlers de contenido restantes y validar el cambio de organización contra cada ruta mutante.
- Worker interno persistente.
- Store durable/RPC aplicado y validado en staging, con un processor de copy real conectado.
- Retries, dead-letter y recuperación operativa completa.
- OAuth Meta por organización.
- Cifrado/rotación de credenciales de proveedores.
- Publicación real Facebook/Instagram.
- Delivery URL compatible con el fetch externo de Meta.
- Storage local como adaptador explícito.
- Migraciones verificadas en staging.
- Aplicar/probar `0011_aias_profiles.sql` en staging y validar el shape RPC/RLS con usuarios reales.

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
- `supabase/migrations/0013_automation_job_lifecycle.sql`
- `lib/automation/supabase-copy-worker-store.ts`
- `app/api/internal/worker/health/route.ts`
