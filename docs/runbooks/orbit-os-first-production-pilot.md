# Orbit OS: primer piloto de producción

Este runbook prepara el primer uso real de SnapGad sin automatizar publicaciones todavía. La aplicación queda lista para cargar activos, generar borradores por IA, revisar copy y operar el flujo manual de publicación. Meta Publishing permanece desconectado hasta que se configure OAuth en un entorno real.

## Puertas de permiso

| Puerta | Acción | Responsable | Estado para el piloto |
| --- | --- | --- | --- |
| P0 | Lectura de código, Supabase y diagnósticos | Codex | Permitida |
| P1 | Pruebas locales, build y cambios del repositorio | Codex | Permitida |
| P2 | Ejecutar DDL remoto consolidado | Axel, confirmación explícita en el momento | Aplicada 2026-10-05 |
| P3 | Registrar secretos de runtime/OAuth | Axel desde variables seguras | Pendiente |
| P4 | Conectar una página Meta y publicar | Axel, con revisión humana | Pendiente |

No se guardan secretos en Git, SQL, el chat, ni migraciones.

## Ventana de aplicación

1. Confirma que no hay usuarios ni contenido reales aún. Si hay datos, detente: esta consolidación está diseñada para la base vacía actual.
2. Ejecuta [0018-preflight.sql](../../supabase/runbooks/0018-preflight.sql) en Supabase SQL Editor y conserva el resultado.
3. Debe existir exactamente el historial `0001` a `0017`; las tablas de aplicación deben tener cero filas y `supabase_vault` debe estar instalado.
4. La migración consolidada ya fue aplicada por MCP como `20261005124203_orbit_os_mvp_consolidation`; el archivo local correspondiente es `supabase/migrations/20261005124203_orbit_os_mvp_consolidation.sql`.
5. Ejecuta [0018-postflight.sql](../../supabase/runbooks/0018-postflight.sql). Si una verificación no coincide, no conectes Meta ni cargues secretos: guarda el resultado y corrige antes de avanzar.

## Smoke test del portal

1. Crea el usuario propietario de SnapGad y termina onboarding con una organización.
2. Configura el perfil AIAS: rubro, oferta, servicios, tono, CTA y hechos permitidos. No prometas ROI, garantías o cifras no verificadas.
3. Sube un activo de prueba, crea contenido, genera un copy usando la clave del proveedor del cliente y revisa el diagnóstico.
4. Rechaza un borrador y aprueba otro; comprueba historial y auditoría.
5. Usa una publicación manual de prueba, sin presupuesto de pauta, y valida que el estado/auditoría reflejen el resultado.
6. Solo después conecta Meta OAuth para la página de prueba y valida una publicación no pautada con revisión humana.

## Criterio de salida

El piloto está listo para uso interno cuando: RLS aísla cada organización, el propietario puede administrar perfil/activos/contenido, una generación de copy BYOK funciona, la aprobación queda auditada y el flujo manual termina con estado verificable.
