# Decisiones de arquitectura

## ADR-001 — AIAS como producto principal

**Fecha:** 2026-09-08
**Estado:** Adoptada

La aplicación se diseña como una SaaS operada con IA. El perfil de cada organización define el diagnóstico, la voz, los claims permitidos, el CTA y la adaptación por plataforma. No se asume el pitch de SnapGad para los clientes.

## ADR-002 — n8n es extensión, no dependencia diaria

**Fecha:** 2026-09-08
**Estado:** Adoptada

Los jobs de copy, revisión y publicación pertenecen al portal y a un worker interno. n8n queda disponible para automatizaciones complejas, webhooks externos y conectores específicos. No se elimina hasta que el worker interno pase las pruebas de recuperación y una publicación real en staging.

## ADR-003 — OAuth simplifica la conexión, no sustituye Meta API

**Fecha:** 2026-09-08
**Estado:** Adoptada

El cliente conectará sus cuentas mediante OAuth. Las llamadas posteriores a Facebook e Instagram se ejecutarán server-side mediante adaptadores Meta. Los tokens y scopes se almacenan por organización y nunca llegan al navegador.

## ADR-004 — Storage por adaptador

**Fecha:** 2026-09-08
**Estado:** Adoptada

Supabase Storage privado es el adaptador inicial de producción. El disco propio se soporta mediante un adaptador local para self-hosting y staging. Google Drive será únicamente una integración de importación/exportación, no el storage runtime.

## ADR-005 — Aprobación humana obligatoria

**Fecha:** 2026-09-08
**Estado:** Adoptada

La IA puede diagnosticar, escribir y recomendar. La publicación remota requiere aprobación explícita por destino, con preflight y registro de auditoría.

## ADR-006 — Nombre de producto y repositorio

**Fecha:** 2026-09-10
**Estado:** Adoptada

El nombre comercial de esta herramienta será **Orbit OS by SnapGad**: el centro de operaciones de contenido y automatización de SnapGad. El repositorio oficial es `AxelENF/orbit-os` y su slug es `orbit-os`.

El paquete interno conserva temporalmente `snapgad-content-os` para no romper imports, claves de almacenamiento local ni integraciones existentes. El renombrado interno se hará en una migración separada cuando exista un repositorio remoto nuevo y una estrategia explícita de compatibilidad.

## ADR-007 — Migraciones reproducibles con Supabase CLI

**Fecha:** 2026-09-10
**Estado:** Aplicada en Supabase remoto; pendiente de smoke test autenticado

Las migraciones SQL permanecen en `supabase/migrations/` y se ejecutan en orden con Supabase CLI. En esta fase se aplicaron contra el proyecto Supabase `zsljrjuebdgcyinexdlj`; `migration list` confirmó coincidencia exacta `0001`–`0013`, y se verificaron tablas, funciones, estados de job, RLS y el bucket privado `content-assets`.

El entorno local sigue sin `supabase/config.toml`, Postgres local y daemon Docker. Antes de operar el portal contra esta base falta un smoke test con un usuario Auth real, membresía, asset privado y job durable; después se podrá conectar el worker con sus variables locales sin guardar secretos en git.
