# SnapGad Content OS — Centro de campañas web-first

**Fecha:** 5 de septiembre de 2026
**Estado:** diseño aprobado para planificación; no activa n8n ni Meta

## Propósito

Convertir la actual biblioteca de creativos en un centro web de campañas que
permita tomar un export final de Canva, darle contexto comercial, pedir a la
IA clasificación y copy, revisar el texto definitivo y publicar sólo un
destino aprobado. La primera ruta comercial es Facebook hacia el bot de
WhatsApp.

El portal debe hacer visible qué oferta se publicó, para quién, con qué
afirmaciones, en qué red, y qué resultado comercial produjo. No debe publicar
por sí solo, modificar creativos Canva ni inventar pruebas, precios, métricas o
urgencia.

## Restricciones confirmadas

- La experiencia es una aplicación web Next.js. No se añadirá Docker, Directus,
  Postiz, Metabase ni otro panel de administración.
- Supabase existente es la única capa nueva de datos: Auth, Postgres, Storage
  privado y Realtime.
- n8n y OpenRouter se usan para análisis y redacción estructurada, no para
  aprobar, prometer resultados ni decidir publicación.
- Canva conserva el acabado visual y el logo. El sistema recibe sólo el export
  final, normalmente 1080 × 1350 (4:5).
- Facebook es el primer destino activable. Instagram conserva su aprobación
  independiente, pero no bloquea una publicación aprobada de Facebook.
- Las credenciales de Meta permanecen del lado servidor. Ninguna clave llega al
  navegador, al asset público o a un prompt de IA.

## Alcance de la primera implementación

### 1. La campaña como registro central

`content_items` se mantiene como tabla raíz para no duplicar la información ni
migrar un portal completo. En la interfaz se llamará **campaña**. Cada campaña
tendrá un asset final, brief y copy definitivo; no habrá una entidad `campaign`
paralela.

Se agregan a `content_items` los campos:

| Campo | Uso |
| --- | --- |
| `campaign_name` | Nombre humano para encontrar la campaña. |
| `campaign_code` | Código único y legible para atribuir conversaciones del bot. |
| `funnel_stage` | `DISCOVER`, `CONSIDER` o `DECIDE`. |
| `primary_pain` | Dolor concreto que resuelve una sola publicación. |
| `proof_mechanism` | `DEMO`, `WORKFLOW`, `PRODUCT_VIEW` o `NONE`; nunca una prueba inventada. |
| `cta_action` | `WHATSAPP`, `BOOK_DEMO`, `VISIT_WEB` o `LEARN_MORE`; hace verificable la acción del CTA. |

Los campos existentes `service`, `niche`, `content_type`, `objective`, `human_description`,
`allowed_facts` y `cta` siguen siendo el contrato editorial. `allowed_facts` es
la fuente de verdad para validar el copy final.

### 2. Biblioteca y creación rápidas

La navegación pasa a usar: **Campañas**, **Nueva campaña**, **Copy Studio**,
**Revisión** e **Historial**. La biblioteca permite filtrar y buscar por nombre,
servicio, nicho, etapa, tipo de contenido, objetivo y estado. Cada tarjeta
muestra sólo el creativo, oferta, destino activo y siguiente acción; no se
mostrará una cuadrícula de información técnica.

Crear una campaña se divide en tres secciones visibles en una sola página:

1. **Oferta y audiencia:** nombre, servicio, nicho, dolor y etapa.
2. **Creativo final:** asset Canva y validación preflight.
3. **Límites editoriales:** CTA, descripción humana, mecanismo de prueba y
   hechos permitidos.

La aplicación puede sugerir clasificación después del análisis, pero la persona
que crea la campaña confirma o corrige cada etiqueta antes de pedir publicación.

### 3. Preflight sin publicación

El preflight se evalúa en servidor al subir y al enviar el copy a revisión.
Una campaña sólo puede continuar si todos estos controles son válidos:

| Control | Regla |
| --- | --- |
| Archivo | `file-type` confirma la firma binaria y coincide con el MIME declarado. |
| Creativo | Formato PNG, JPEG o WebP; máximo 20 MB; mínimo 540 × 675; relación 4:5. |
| Brief | Todos los campos de campaña y al menos un hecho permitido existen. |
| Copy final | Titular, cuerpo y CTA son no vacíos; la CTA contiene una frase permitida para `cta_action`; el texto no contiene una afirmación no sustentada por los hechos permitidos. |
| Destino | Facebook o Instagram se aprueba por separado; el botón de publicar sólo aparece en un destino aprobado. |

`file-type` complementa, no reemplaza, la comprobación de dimensiones y la
lectura de cabeceras existente. Una firma correcta no prueba que un archivo sea
inofensivo o útil para pauta, por lo que los límites de tamaño y formato se
conservan.

El servidor no pretende decidir por lenguaje natural si una frase es verdadera.
`validateFinalCopy` hace tres comprobaciones deterministas: la CTA debe incluir
una palabra de su acción (`WHATSAPP`: “WhatsApp” o “escribe”; `BOOK_DEMO`:
“agenda” o “demo”; `VISIT_WEB`: “visita”; `LEARN_MORE`: “conoce” o “ver”);
bloquea porcentajes, precios, plazos, superlativos y garantías que no aparezcan
literalmente en `allowed_facts`; y exige que el owner marque “confirmo que las
afirmaciones usan sólo los hechos permitidos”. Esa confirmación se audita junto
con la versión de final copy.

### 4. Copy Studio y revisión humana

n8n recibe un URL temporal del asset, el brief y un esquema JSON. Debe devolver:

```text
visual_analysis: { detected_elements, visual_risks, suggested_tags }
classification: { service, niche, content_type, funnel_stage, confidence }
drafts: [{ headline, body, cta, angle }]
warnings: string[]
```

El callback se valida con Zod, HMAC e idempotencia antes de persistir. La
clasificación sugerida no sobrescribe el brief. El Copy Studio permite elegir
una alternativa, editarla y guardar un **final copy** inmutable para revisión.
El final copy guarda el borrador de origen, su contenido exacto, checksum,
autor y momento de guardado.

Al enviar a revisión se valida ese final copy y se transiciona `DRAFT → REVIEW`.
Un cambio posterior crea una nueva versión y devuelve la campaña a `DRAFT`; no
se puede mantener una aprobación sobre un texto que ya cambió.

### 5. Revisión y publicación

Facebook e Instagram conservan destinos separados. Aprobar uno no cambia el
otro. La interfaz espera la respuesta confirmada del servidor y revierte el
estado visual si falla; no usa una aprobación optimista.

La publicación real queda detrás de una interfaz `Publisher`. La primera
implementación de esa interfaz será `MetaBusinessPublisher`, de lado servidor,
con el SDK oficial de Meta. Antes de su primera llamada realiza un preflight de
cuenta y destino: token presente, Page seleccionada, cuenta Instagram vinculada
cuando corresponda y permisos necesarios. Mientras no exista configuración de
Meta, el adaptador responde `NOT_CONFIGURED`, no intenta una publicación ni
simula un resultado.

El publisher recibe la versión inmutable de final copy y el asset aprobado; no
acepta texto, URL o CTA arbitrarios del navegador. Registra el identificador,
URL y hora remotos, o un error sanitizado, dentro del destino de esa campaña.

El workflow existente de publicación por n8n queda desactivado mientras exista
`MetaBusinessPublisher`; no habrá dos adaptadores capaces de publicar la misma
campaña. n8n conserva el análisis y la redacción de copy.

### 6. Realtime y atribución comercial

Supabase Realtime actualiza Copy Studio, Revisión e Historial cuando n8n añade
borradores o Meta cambia un destino. La suscripción es privada y se filtra por
`content_item_id` y owner; las pantallas siguen teniendo una acción manual de
refresco como respaldo.

La campaña genera un `campaign_code` como `SG-<código>`. El CTA de WhatsApp
puede incluir ese código en un mensaje prellenado o el bot puede conservarlo
como metadata del referral. El bot registra eventos en `campaign_outcomes`:

`CONVERSATION`, `QUALIFIED_LEAD`, `APPOINTMENT`, `QUOTE`, `SALE`.

Cada evento tiene campaña, fuente, fecha y metadata mínima. El portal muestra
conteos por campaña, no una promesa de ROI. Importes sólo se agregan después de
definir una fuente contable confiable.

## Fuera de alcance

- Calendario de publicaciones recurrentes, pauta, presupuestos y cambios de
  anuncios.
- Autogeneración o edición libre de imágenes, logos o plantillas de Canva.
- Publicar TikTok, LinkedIn, Google Business o múltiples páginas.
- Un CRM, dashboard BI externo, CMS, gestor de redes sustituto o automatización
  de comentarios.
- A/B testing automático o cualquier decisión de inversión sin aprobación.

## Estados y errores

El estado actual se conserva: `UPLOADED → GENERATING → DRAFT → REVIEW →
APPROVED → SCHEDULED → PUBLISHED`. `REJECTED` y `ERROR` retornan a un estado
que permite corrección, sin borrar auditoría.

Errores de asset, preflight, callback o Meta se muestran como instrucciones
claras y se guardan sanitizados. Un callback duplicado no crea otro draft. Una
aprobación repetida devuelve el destino ya aprobado sin crear otro evento. Una
campaña no puede publicar si final copy, asset o aprobación ya no coinciden con
la versión revisada.

## Orden de entrega

1. **Fundamentos web:** contrato de campaña, preflight robusto con `file-type`,
   biblioteca filtrable y corrección del guardado/versión de final copy.
2. **IA visible:** esquema de clasificación, UI de aceptación, n8n para copy y
   actualización Realtime privada.
3. **Ruta Facebook:** adaptador Meta en modo dry-run, preflight de cuenta,
   primera publicación manual aprobada y captura de resultado remoto.
4. **Aprendizaje comercial:** código de campaña en el bot y outcomes de
   conversación, cita y cotización.

Cada bloque queda probado en local y staging antes de activar el siguiente.

## Pruebas requeridas

- Unitarias: validación de campaign brief, preflight de asset, copy final,
  transición de estados y atribución de outcomes.
- Rutas: owner scope, HMAC/idempotencia, rechazo de datos libres para publish,
  error de configuración Meta y respuestas de aprobación.
- Integración de staging: upload privado, callback real de n8n, actualización
  Realtime y una publicación de Facebook previamente aprobada.
- Manuales: preview en móvil y escritorio, filtro de biblioteca, edición que
  invalida la aprobación y recepción del código de campaña en el bot.

## Criterio de éxito

Con un export final de Canva, Axel puede crear una campaña, confirmar su
contexto, recibir alternativas de copy, escoger una, aprobar Facebook y ver en
la misma ficha el post remoto y las conversaciones atribuidas. Ningún paso
publica, gasta dinero o cambia una promesa sin una acción explícita del owner.
