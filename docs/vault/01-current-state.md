# Estado actual — 2026-09-17

## Resumen ejecutivo

**Orbit OS by SnapGad** es el sistema operativo de contenido de marketing para organizaciones. Un agente como Codex o Claude analiza el creativo, el perfil AIAS, las pruebas permitidas y los resultados previos para diseñar copy por campaña; Orbit conserva activos, variantes, decisiones, guardrails, publicación y observaciones.

La rama publicada `integration/main-consolidation` pasa 613 pruebas, TypeScript, lint y build. Este checkout no contiene `.env.local`, por lo que aún no hay prueba real de Supabase/Auth/Storage/Meta y no se declara producción.

## Consolidado en código

- Multi-organización con RLS, `organization_id`, roles, perfil AIAS versionado, organización activa y auditoría.
- Biblioteca de campañas, activos privados, múltiples assets, borradores, copy final, hashtags, diagnóstico por target y resultados observados.
- Generación interna de copy/intake con límites de costo, guardrails y worker durable con leases, recuperación y dead-letter.
- Logo Studio: logo, composición en lote, posición/tamaño/margen, preview y ZIP; la API v1 puede estampar logo server-side.
- OAuth Meta por organización, selección de Page, cola durable y conectores Graph para Facebook e Instagram. Sólo están probados de forma aislada.
- API v1 con API keys por organización para campañas, detalle y encolado de publicación. El tenant deriva de la clave, no de parámetros del agente.
- n8n queda como bridge opcional; la ruta objetivo es portal + worker interno.

## Modelo de operación de contenido

1. Codex/Claude genera o selecciona un creativo alineado al sistema visual SnapGad o a la marca cliente.
2. El agente lee oferta, cliente ideal, dolor, pruebas permitidas, claims prohibidos, objetivo y resultados previos.
3. El agente redacta copy de alta conversión para contenido educativo/autoridad, venta directa orgánica o creativo preparado para pauta. Orbit guarda origen, contexto y validación.
4. Orbit evalúa el diagnóstico por target; si está apto pasa al worker orgánico y, si hay riesgo, devuelve hallazgos corregibles.
5. Meta Business Suite se usa para decidir gasto y pauta. Orbit prepara asset/copy y registra resultados, pero no crea presupuestos, audiencias ni cargos.

## Política de logo pendiente

El compositor existe, pero la campaña debe elegir la regla antes de generar derivativos:

- `NONE`: conservar creativos originales.
- `FIRST_ASSET_ONLY`: marcar sólo portada/primer slide.
- `ALL_ASSETS`: marcar todos los slides.
- `SELECTED_ASSETS`: marcar posiciones elegidas.

El original privado es inmutable. Cada estampado es un derivativo auditable con asset fuente, versión de logo, esquina, escala y margen; no se aplica un logo globalmente por una regla silenciosa.

## Persistencia y release

- La evidencia anterior verificó remoto hasta migración `0017`.
- El repositorio incluye `0018`–`0030`, pero todavía no hay comparación actual contra Supabase.
- `0031` moverá Page tokens y tokens temporales OAuth a Supabase Vault antes de conectar clientes reales.
- API v1 debe recibir contexto de marca, envío de copy final, readiness, resultados y scopes antes del MCP local.

## Próxima secuencia correcta

1. Conectar Supabase por MCP OAuth o Supabase CLI y capturar el baseline real.
2. Aplicar/verificar `0018`–`0031` en staging con Auth/RLS/Storage/OAuth/worker.
3. Implementar política explícita de logo y extensiones agent-safe de API v1.
4. Instalar MCP local stdio para Codex/Claude usando API key scoped, sin secretos de infraestructura.

## Evidencia y planes

- [Reconciliación de producto](07-reconciliacion-2026-09-17.md)
- [Seguridad de base y staging](../superpowers/plans/2026-09-17-database-security-and-staging.md)
- [MCP de operación por agentes](../superpowers/plans/2026-09-17-orbit-agent-mcp.md)
