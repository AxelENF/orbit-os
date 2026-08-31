# SnapGad Content OS — Diseño aprobado para implementación

**Fecha:** 31 de agosto de 2026  
**Estado:** listo para construir el MVP  
**Producto:** portal interno separado de la página administrativa existente.

## 1. Resultado de negocio

El primer ciclo completo debe permitir que SnapGad convierta un creativo final
revisado en Canva en una publicación controlada y trazable:

1. Axel carga el archivo final de un creativo.
2. Lo clasifica con el contexto comercial que la IA no debe inventar.
3. El sistema solicita análisis visual y dos propuestas de copy a n8n.
4. Axel edita, elige y aprueba una propuesta.
5. n8n publica únicamente los destinos autorizados y devuelve el resultado.
6. El portal conserva asset, brief, copy final, estado, IDs remotos y errores.

No se considera éxito tener un calendario bonito. El éxito es completar tres
publicaciones reales seguidas sin Postiz, sin copys inventados y sin pérdida de
control humano.

## 2. Decisiones de arquitectura

### Elegida

```text
Next.js Content OS
  ├─ interfaz, validaciones, estado de negocio y auditoría
  ├─ Supabase Auth + Postgres + Storage
  └─ API privada firmada para n8n

n8n
  ├─ llama el proveedor de visión/copy configurado por Axel
  ├─ reintenta operaciones externas
  ├─ conserva credenciales de Meta
  └─ publica FB/IG sólo a partir de una orden APROBADA

Meta Graph API
  └─ destino de publicación, no fuente de verdad
```

El portal es dueño del estado. n8n es ejecutor; no lee, modifica ni publica
arbitrariamente. Cada solicitud lleva un identificador, una firma y una llave
de idempotencia. Cada callback se verifica antes de mutar el estado.

### Descartadas para V1

- Postiz: no aporta valor a esta operación y duplica el sistema.
- Mixpost, Payload, Directus, Refine o Appsmith como base: añaden otro modelo
  de datos, stack o licencia para apenas cuatro pantallas internas.
- Canva API: el export final seguirá siendo manual y revisado por Axel.
- Publicación autónoma, comentarios automáticos, gastos de pauta y multitenancy.

## 3. Alcance del MVP

### Incluido

- Inicio de sesión de propietario y rol interno básico.
- Carga de imagen estática 4:5 final desde Canva a Supabase Storage.
- Biblioteca filtrable por línea, servicio, nicho, objetivo y tipo de contenido.
- Brief comercial obligatorio: descripción humana, hechos permitidos y CTA.
- Solicitud a n8n para análisis visual y dos copys estructurados.
- Editor y revisión humana de un copy elegido.
- Aprobación individual por Facebook Page e Instagram profesional.
- Orden de publicación firmada para n8n y registro de callback.
- Historial de estados, IDs remotos, errores e idempotencia.
- Modo de prueba local: sin credenciales, permite recorrer el flujo con datos
  mock sin publicar.

### Fuera de alcance

- Generación de imágenes, edición Canva o retirada automática de logo/texto.
- Reels, video, stories, carruseles y variantes 9:16.
- Programación recurrente, calendario editorial, métricas de negocio o blog.
- Respuestas automáticas a comentarios, DMs o WhatsApp.
- Multiempresa o usuarios externos de clientes.
- Pago de anuncios o cambios automáticos dentro de Meta Ads.

## 4. Taxonomía comercial inicial

El portal no clasifica por herramientas sueltas. Usa las líneas de SnapGad:

| Campo | Valores iniciales |
| --- | --- |
| `business_line` | `CONTROLAR`, `CAPTAR`, `AUTOMATIZAR` |
| `service` | POS, web de conversión, bot WhatsApp, CRM, ERP/operaciones, infraestructura |
| `niche` | clínicas, estéticas, spas, salones, barberías, comercio con inventario, servicios locales, general |
| `content_type` | educativo, prueba, venta_directa |
| `objective` | conversaciones_whatsapp, agenda_demo, tráfico_web, autoridad |
| `format` | feed_4_5 |

El UI permitirá texto adicional de nicho y CTA, pero los campos base serán
listas controladas para no terminar con archivos sin contexto.

## 5. Pantallas

### A. Biblioteca (`/library`)

- Grid de assets, filtros y estado del contenido asociado.
- CTA `Subir creativo`.
- Cada tarjeta muestra preview, servicio, nicho, tipo y último estado.

### B. Nuevo creativo (`/library/new`)

- Archivo PNG/JPG/WEBP de 4:5.
- Línea, servicio, nicho, tipo, objetivo y CTA.
- Descripción humana y lista de hechos permitidos.
- Validación de formato/dimensiones antes de permitir crear contenido.

### C. Borradores (`/drafts` y `/drafts/:id`)

- Preview de asset y brief fuente.
- Análisis visual recibido, dos alternativas de copy y advertencias.
- El usuario puede editar el copy; queda una revisión auditada.
- Acción `Enviar a revisión`.

### D. Revisión e historial (`/review`, `/history`)

- Botones independientes por destino: Facebook e Instagram.
- `Aprobar`, `Rechazar` y, más adelante, `Programar`.
- `Publicar ahora` sólo aparece después de tener workflow Meta probado.
- Timeline de eventos y mensajes de error sin exponer secretos.

## 6. Datos y estados

Tablas mínimas:

| Tabla | Responsabilidad |
| --- | --- |
| `profiles` | usuario interno y rol (`owner`, `reviewer`) |
| `assets` | metadatos del archivo final de Storage, dimensiones y checksum |
| `content_items` | taxonomía, brief, hechos permitidos y estado del ciclo |
| `copy_drafts` | análisis visual, texto, proveedor/modelo, revisión y copy elegido |
| `publication_targets` | destino FB/IG, estado individual, horario e ID remoto |
| `automation_runs` | solicitudes/callbacks n8n, llaves de idempotencia y errores sanitizados |
| `audit_events` | quién hizo cada transición y cuándo |

Estados de `content_items`:

```text
SUBIDO → GENERANDO → BORRADOR → REVISION → APROBADO → PROGRAMADO → PUBLICADO
                                      ↘ RECHAZADO / ERROR
```

El estado del contenido se deriva de los destinos: Facebook publicado no marca
Instagram como publicado. Un mismo content item puede terminar en
`PUBLICADO_PARCIAL` cuando una red falle.

## 7. Contratos de automatización

### Portal → n8n: solicitud de copy

`POST /webhook/snapgad-content-copy` con firma HMAC y payload:

```json
{
  "contentItemId": "uuid",
  "assetUrl": "signed-or-publishable-url",
  "brief": {
    "service": "bot WhatsApp",
    "niche": "clínicas",
    "objective": "conversaciones_whatsapp",
    "cta": "Solicita una demo",
    "humanDescription": "...",
    "allowedFacts": ["Responde", "califica", "agenda"]
  },
  "idempotencyKey": "uuid"
}
```

### n8n → Portal: callback de copy

`POST /api/integrations/n8n/copy-result` con la misma clase de firma:

```json
{
  "contentItemId": "uuid",
  "idempotencyKey": "uuid",
  "visualAnalysis": { "summary": "...", "detectedClaims": [] },
  "drafts": [
    { "body": "...", "headline": "...", "cta": "..." },
    { "body": "...", "headline": "...", "cta": "..." }
  ],
  "warnings": []
}
```

### Portal → n8n: publicación

Sólo se envía para un `publication_target` cuyo estado es `APPROVED`.
El payload usa una URL que Meta pueda descargar durante el intento. n8n responde
por callback con `remotePostId`, URL remota o error sanitizado.

## 8. Guardrails de contenido y seguridad

- La descripción humana y `allowedFacts` son la fuente factual. El análisis
  visual no puede agregar resultados, precios, testimonios, urgencia ni ROI.
- Cada copy se valida contra hechos permitidos y requiere CTA no vacío.
- Ninguna IA puede crear una transición a `APPROVED` o `PUBLISHED`.
- Las claves de Meta, OpenRouter, Supabase service role y HMAC viven sólo en
  servidor/n8n; nunca en el navegador ni repositorio.
- Storage es privado por defecto; las URLs de publicación se emiten sólo para
  un trabajo aprobado y con vencimiento/revocación apropiados.
- Todas las tablas expuestas llevan RLS; el rol de servicio se limita a rutas
  de servidor.
- Se guarda auditoría de upload, edición, aprobación, solicitud y callback.

## 9. Entornos y transferencia

- `local`: UI mock y pruebas automatizadas; no requiere credenciales.
- `staging`: Supabase de prueba, n8n de prueba y Page de prueba Meta.
- `production`: Supabase/Storage real y workflow n8n activado.

El repo incluirá `.env.example`, migraciones, README de despliegue y contratos
de webhooks para poder transferirlo sin depender de esta PC.

## 10. Criterios de aceptación de V1

1. Un owner puede crear un content item con asset y metadatos válidos.
2. Una imagen no válida o un brief sin hechos permitidos no pasa a generación.
3. Un callback repetido de n8n no duplica borradores ni publicaciones.
4. Un copy no puede aprobarse si viola un hecho permitido o carece de CTA.
5. Facebook e Instagram mantienen estados e IDs independientes.
6. Sin integración configurada, el modo demo muestra el flujo pero nunca llama
   a Meta ni publica nada.
7. El proyecto instala, prueba y arranca en otra PC con README y `.env.example`.
