# Publicación SnapGad — no disponible todavía

La publicación a Facebook e Instagram no está disponible en este repositorio.
El export actual de n8n es un worker inactivo sólo de copy: no llama APIs de
redes sociales, no crea publicaciones y no tiene una ruta de publicación.

## Por qué está bloqueada

Antes de publicar por cuenta de un cliente hace falta una **integración tenant
de Meta**: cada organización debe autorizar sus propios destinos, conservar de
forma segura su conexión, manejar renovación o revocación y elegir el destino
correcto para cada target aprobado. Esa arquitectura no existe aún.

También faltan contratos portal-side para trabajos durables, idempotencia por
target, leases de ejecución, callbacks firmados y almacenamiento de los IDs y
URLs remotos que devuelva cada plataforma. Un estado `APPROVED` es una
aprobación humana para el portal; nunca es una orden de publicación autónoma.

## Estado actual

- No hay claims de publicación en vivo.
- No hay worker de publicación importable.
- No hay tokens ni credenciales de plataformas en el export de copy.
- No debe marcarse un target como publicado sin una respuesta persistida y
  verificable de la plataforma correspondiente.

## Condiciones para habilitarla después

1. Implementar integración tenant de Meta con consentimiento explícito,
   aislamiento por organización y ciclo de vida de credenciales.
2. Implementar una cola durable con claim, lease, intento y clave de
   idempotencia por `publicationTargetId`.
3. Diseñar endpoints firmados portal ↔ worker que sólo entreguen el target
   aprobado y reconcilien callbacks sin duplicar publicaciones.
4. Probar cada plataforma por separado en staging, persistir el resultado y
   mantener la aprobación humana inmediatamente anterior al envío.
5. Revisar seguridad y operación antes de crear un export de publicación.

Hasta completar estas condiciones, el flujo válido termina en revisión humana;
el usuario publica manualmente desde la herramienta oficial de cada red.
