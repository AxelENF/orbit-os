# SnapGad Content OS — Fase siguiente: adaptador de control de producción

**Fecha:** 4 de septiembre de 2026
**Estado:** implementado en código; pendiente validación en staging

## Objetivo

Dar al portal un contrato server-side para leer el estado real de cada creativo
y aprobar Facebook o Instagram de forma independiente, sin permitir que n8n o
el navegador salten la revisión humana.

## Entregado

- `GET /api/content` devuelve los contenidos del owner autenticado.
- `GET /api/content/:id` devuelve brief, destinos, borradores y auditoría.
- `POST /api/content/:id/targets/:targetId/approve` aprueba un solo destino.
- Supabase migration `0005_approve_publication_target.sql` aplica ownership,
  estado `REVIEW`, locks y evento `TARGET_APPROVED` en una transacción.
- Supabase migration `0006_create_content_item_with_asset.sql` registra el asset
  privado y el content item en una sola transacción.
- `POST /api/content` valida firma del archivo, dimensiones 4:5, checksum y
  sube el export a `content-assets` privado cuando Supabase está configurado.
- Login y middleware Supabase ya protegen las rutas del portal configurado.
- Demo y Supabase comparten el mismo contrato; repetir la aprobación no agrega
  otro evento ni cambia el estado de la otra red.

## No se declara todavía

- El login, las migraciones y el upload real requieren credenciales de staging
  para validarse end-to-end.
- No se activó n8n ni se publicó en Meta.
- La migración y el contrato requieren una prueba con Supabase de staging.

## Siguiente bloque recomendado

1. Validar login, migraciones y upload en Supabase de staging.
2. Ejecutar una prueba de copy con un asset Canva 4:5 y después una sola
   publicación de Facebook en Meta staging.

La activación de Instagram y cualquier publicación recurrente quedan después de
esa primera prueba aprobada.
