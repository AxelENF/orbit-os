# SnapGad Content OS — Diseño de reconstrucción SaaS

**Estado:** aprobado por Axel para ejecución autónoma el 7 de septiembre de 2026.

## Decisión de producto

SnapGad Content OS será un SaaS web multi-tenant para que cada negocio opere
sus campañas con una experiencia simple. SnapGad opera la infraestructura de
automatización central; el cliente nunca administra n8n ni recibe secretos.
Cada organización conecta sus propias cuentas de Meta/WhatsApp cuando esa
integración sea activada.

La unidad de trabajo es una **campaña**. Una campaña concentra creativo final,
brief, versiones de copy, aprobaciones por canal, programación, publicación y
resultados. Biblioteca, borradores, revisión e historial dejan de ser
productos separados: pasan a ser vistas o secciones de una campaña.

## Límites operativos no negociables

- La base es compartida, pero cada fila de negocio lleva `organization_id` y
  el tenant se deriva de la sesión y membresía, nunca de un valor enviado por
  navegador, n8n o MCP.
- n8n no recibe `SUPABASE_SERVICE_ROLE_KEY` ni escribe tablas directamente.
  Sólo recibe `jobId` y una capacidad HMAC de corta vida; el portal resuelve
  asset, brief, destino y copy final desde datos bloqueados.
- Toda publicación queda apagada hasta que exista conexión Meta por
  organización y una aprobación humana explícita para ese destino.
- OpenRouter/n8n puede proponer análisis y copy; no puede aprobar, inventar
  hechos ni elegir un presupuesto o un destino.
- El cliente ve lenguaje comercial y siguiente acción; URLs temporales,
  secretos, proveedores y modo demo quedan ocultos fuera de desarrollo.

## Arquitectura objetivo

```text
Usuario autenticado → organización + rol → Portal Next.js
                                      │
                                      ├─ Supabase: datos, RLS, Storage privado
                                      ├─ API interna: campañas, jobs, callbacks
                                      └─ n8n central: worker firmado de IA/entrega
                                                            │
                                                            ├─ OpenRouter
                                                            └─ Meta, después de conexión tenant
```

### Modelo mínimo

`organizations`, `organization_members`, `organization_brand_profiles`,
`organization_integrations`, `automation_jobs` y las tablas actuales
tenantizadas (`assets`, `content_items`, `copy_drafts`, `final_copies`,
`publication_targets`, `automation_runs`, `audit_events`).

Roles de V1: `owner`, `editor`, `reviewer`, `viewer`. SnapGad sólo entra como
membresía de soporte auditable de una organización concreta.

### Contrato de job

1. El portal crea un `automation_job` atómico con estado `QUEUED`.
2. n8n recibe `jobId`, timestamp y firma HMAC; llama al portal para reclamarlo.
3. El portal transiciona una sola vez `QUEUED → PROCESSING` y entrega una
   instrucción derivada de la base.
4. n8n devuelve un callback HMAC ligado al mismo `jobId`.
5. El portal valida transición, pertenencia y payload antes de guardar
   resultado/auditoría. Reintentos repetidos son idempotentes.

## Experiencia cliente V1

```text
Inicio              prioridades y estado de campañas
Campañas            lista, filtros y siguiente acción
Nueva campaña       wizard: objetivo → creativo → mensaje/destino
Calendario          campañas aprobadas/programadas
Resultados          conversaciones, leads, citas, cotizaciones, ventas
Marca y conexiones  Brand OS y estado de Meta/WhatsApp/n8n
```

La ficha `Campaña` es el workbench canónico: creativo, copy final,
aprobaciones por canal, fecha, actividad y resultados. En móvil se conserva
toda la navegación mediante un menú accesible.

## Entregas y orden

1. **Cimiento seguro:** corregir lint, consolidar documentación activa,
   tenancy, RLS y jobs sin acceso directo de n8n.
2. **Campaña simple:** reemplazar superficies duplicadas por campañas,
   wizard, workbench, navegación móvil y una línea visual SnapGad.
3. **Automatización controlada:** rediseñar n8n como worker de jobs y probar
   en staging sólo análisis/copy.
4. **Operación medible:** calendario, outcomes del bot y resultados útiles.
5. **Extensibilidad:** API v1 con claves por organización y MCP limitado a
   lectura, preparación y aprobación; jamás ejecución arbitraria.

## Fuera de V1

No Docker, Postiz, Metabase, CMS adicional, pauta automática, CRM completo,
publicación sin revisión, generación autónoma de creativos ni conexión global
de Meta para todos los clientes.

## Criterio de éxito

Un cliente puede cargar un creativo final de Canva, crear una campaña,
recibir/editar copy, aprobar Facebook e Instagram por separado, programar una
publicación y entender qué conversaciones, leads o citas produjo; todo sin
ver infraestructura y sin que una organización lea o publique por otra.
