# Vault index

## Producto

- [AIAS target architecture](../superpowers/plans/2026-09-08-aias-multiorganization-core.md)
- [SaaS rebuild design](../superpowers/specs/2026-09-07-saas-rebuild-design.md)
- [Campaign experience plan](../superpowers/plans/2026-09-07-campaign-experience.md)

## Estado y decisiones

- [Current state](01-current-state.md)
- [Decisions](02-decisions.md)
- [Execution log](03-execution-log.md)
- [Contracts and guardrails](04-contracts-and-guardrails.md)
- ADR de arquitectura AIAS: persistido también en el grafo `codebase-memory-mcp` para consultas estructurales entre sesiones.

## Reglas operativas

- `organization_id` es el límite de tenant.
- El navegador nunca recibe secretos de proveedor.
- La IA propone; una persona aprueba antes de publicar.
- Una publicación debe ser idempotente y conservar su ID remoto.
- Demo, staging y producción deben declararse explícitamente; no se infiere conectividad por la existencia de una variable parcial.
- No se aplican migraciones remotas sin confirmar el proyecto destino.
