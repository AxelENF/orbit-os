# Preparación de producción — 2026-10-05

## Hechos verificados

- Proyecto Supabase objetivo: `zsljrjuebdgcyinexdlj`.
- Historial remoto antes de aplicar cambios: `0001` a `0017` (17 migraciones).
- Base de datos de aplicación vacía: perfiles, organizaciones, contenido y jobs en cero.
- `supabase_vault` está instalado.
- El DDL consolidado fue aplicado el 2026-10-05 mediante el MCP autenticado de Supabase.

## Cambio preparado

La delta local no aplicada `0018` a `0032` se preservó en `supabase/archive/unapplied-0018-0032/` y se consolidó como una sola migración activa:

- `supabase/migrations/20261005124203_orbit_os_mvp_consolidation.sql` (versión remota `20261005124203`).

Además de las funciones, tablas, RLS, Vault, Meta OAuth, assets, API keys y BYOK que ya componían la delta, la migración revoca ejecución RPC de funciones internas/trigger y corrige la policy de `profiles` para evitar re-evaluación por fila.

## Evidencia local

- Inventario de migración: `0001` a `0017` más `20261005124203`, validado por `scripts/verify-orbit-mvp-migration.mjs`.
- Regresión de migraciones: 10 archivos y 58 pruebas superadas.
- `npx tsc --noEmit`, `npm run lint` y `npm run build` superados.

## Postflight remoto

- Historial remoto: `0001` a `0017` más `20261005124203_orbit_os_mvp_consolidation`.
- Las nuevas tablas públicas y privadas existen, tienen RLS habilitado y siguen vacías.
- Las funciones internas/trigger auditadas no son ejecutables por `anon` ni `authenticated`.
- Los helpers de organización y perfil que requiere el portal permanecen disponibles para `authenticated`.
- Los advisors conservan avisos informativos: tablas internas sin policy directa (el acceso está revocado y solo se usa vía RPC de service role), funciones autenticadas con controles internos y recomendaciones de índices aún sin uso por estar la base vacía. Se revisarán con datos reales; no se añaden índices masivamente sin carga medida.

## Gate pendiente

P2 fue aprobada y aplicada. El postflight está en `supabase/runbooks/0018-postflight.sql`; no muta datos y debe conservarse como verificación del piloto.
