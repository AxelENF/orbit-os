# Sugerencias por visión en el intake — diseño

**Fecha:** 2026-09-14
**Estado:** Aprobado por Axel de forma anticipada — sesión autónoma ("hazme las cosas, no preguntes, confío en ti"). Las decisiones de diseño que en otro momento se habrían preguntado una por una están documentadas aquí con su razonamiento, para que Axel pueda revisarlas y corregir cualquiera al volver.
**Roadmap:** Primer ítem del orden de 4 partes acordado el 2026-09-14 (intake → arquitectura de información/navegación → compositor de logo → capa MCP).

## Contexto

`components/content/content-form.tsx` pide 14 campos — varios obligatorios
— antes de poder generar cualquier copy: `businessLine`, `service`,
`niche`, `contentType`, `objective`, `campaignName`, `offer`,
`funnelStage`, `destination`, `destinationValue`, `cta`,
`humanDescription`, `allowedFacts` (más `format`, fijo). Es la queja más
antigua y repetida de todo este proyecto ("demasiada info pendeja...
sigue requisando demasiada info").

Ya existen dos piezas relacionadas que **no resuelven esto hoy**:

1. **`lib/aias/content-defaults.ts`** (`buildAiasContentDefaults`) — pre-llena
   `businessLine`, `service`, `niche`, `cta`, `humanDescription`,
   `allowedFacts`, `forbiddenClaims` desde el perfil AIAS de la
   organización. Ya reduce el trabajo, pero son valores genéricos del
   negocio, no de la imagen específica que se está subiendo.
2. **El análisis de imagen del generador de copy**
   (`worker/providers/copy-processor.ts`) — manda la imagen a un modelo de
   visión de OpenRouter, pero el campo `visualAnalysis` que devuelve es
   literalmente `{ source: "openrouter", model }` — no hay ninguna
   extracción estructurada real, y de cualquier forma corre **después** de
   enviar el formulario completo, nunca antes.

Investigué prácticas de la industria (ContentStudio, Adobe Express Caption
Writer, SocialBee) antes de diseñar esto: el patrón dominante en
herramientas de este tipo es "sube la imagen primero, la IA la analiza de
inmediato y propone el resto — el humano confirma o edita, no empieza de
cero." Este diseño sigue ese patrón, y reusa el mismo lenguaje visual de
"sugerencia editable" que ya existe en este archivo para los defaults de
AIAS (banner "Sugerencias cargadas... Revísalas antes de continuar").

## Alcance

**Incluido:** un paso nuevo de análisis por visión que corre **al
seleccionar la imagen**, no al enviar el formulario, y pre-llena los campos
que la imagen realmente puede sugerir. Combina con los defaults de AIAS ya
existentes (no los reemplaza). Falla abierto: si el análisis falla o
tarda, el formulario sigue siendo 100% usable manualmente, igual que hoy.

**Explícitamente fuera de alcance** (decisiones de alcance, no olvidos):
- **No se le pide a la IA que invente campos que no son visuales.**
  `businessLine`, `funnelStage`, `destination` y `allowedFacts` son
  decisiones de negocio/estrategia — siguen viniendo exclusivamente del
  perfil AIAS o de que el usuario los escriba. Pedirle a un modelo de
  visión que adivine la etapa del funnel de una imagen sería inventar,
  exactamente lo que este proyecto evita en todos lados (ADR-001, los
  guardrails de claims).
- **No se toca el generador de copy ni su `visualAnalysis` stub** — es un
  problema real pero separado; este spec no lo resuelve.
- **La arquitectura de información (unificar library/drafts/review), el
  dashboard de resultados, y el link de Meta en el menú** — hallazgos
  reales de la misma sesión, pero son el segundo ítem del roadmap
  acordado, no este.

## Arquitectura

Un nuevo endpoint síncrono, no un job del worker durable — a diferencia de
la generación de copy (que sí es un job, porque el usuario ya se fue a
revisar otra cosa mientras corre), esto necesita sentirse instantáneo: el
usuario acaba de soltar una imagen y está esperando.

1. `AssetDropzone` (o el componente padre `ContentForm`), al recibir el
   primer archivo válido, llama `POST /api/content/suggestions` con ese
   archivo (multipart, un solo asset — si hay carrusel, se analiza solo la
   portada, mismo criterio que ya usa `content_item_assets` para la
   posición 0).
2. La ruta corre un chequeo de presupuesto **blando** (lee
   `getMonthToDateSpendUsd`/`getMonthlyBudgetUsd`, ya existen en
   `worker/providers/ai-usage.ts` — sin reserva atómica, ver "Por qué no se
   reusa el sistema de reservas" abajo) y, si hay margen, llama a
   OpenRouter con un modelo de visión, `max_tokens` bajo, y un prompt que
   pide **solo** los campos que una imagen puede sugerir de verdad:
   `niche` (si es visualmente evidente, p. ej. una clínica dental),
   `contentType`, `objective`, `humanDescription` (una frase describiendo
   qué se ve), `offer` (si hay texto de oferta/promoción visible en la
   imagen), `cta` (si hay una llamada a la acción visible).
3. La respuesta se valida con Zod (mismo rigor que `copy-processor.ts`) y
   se regresa al cliente como sugerencias — nunca se escribe nada en la
   base de datos todavía, el content item ni siquiera existe en este punto.
4. `ContentForm` mezcla las sugerencias en el estado del formulario con el
   mismo patrón no-destructivo que ya usa para los defaults de AIAS:
   `current || suggestion` — si el usuario ya escribió algo, no se
   sobrescribe. Se muestra un banner "✨ Sugerido por tu imagen — revisa
   antes de continuar", separado del banner existente de AIAS.
5. Si el paso 2 o 4 falla (sin presupuesto, timeout, respuesta inválida),
   no se bloquea nada — el formulario se queda exactamente como hoy, sin
   sugerencias, y el usuario lo llena a mano.

### Por qué no se reusa el sistema de reservas de presupuesto

`reserveAiRequestBudget`/`settleAiUsageReservation` (ya existen, los usa
`copy-processor.ts`) dependen de un `job_id` con FK real a
`automation_jobs` (`0015_ai_usage_reservations.sql:11`,
`references public.automation_jobs(id)`). Esto está bien para la
generación de copy (siempre es un job real), pero forzar esta sugerencia
interactiva a pasar por el sistema de jobs completo (encolar → worker la
reclama → cliente hace polling) le agregaría segundos de latencia a algo
que debe sentirse instantáneo, solo para una llamada barata y de bajo
riesgo.

En cambio: `ai_usage_events.job_id` **ya es nullable** en el esquema real
(`0014_copy_hashtags_and_ai_usage.sql:195`, sin `not null` — a diferencia
de la tabla de reservas, que sí lo exige). Esto permite una función nueva,
más simple, que registra el gasto real sin necesitar un job:

```sql
create function public.record_interactive_ai_usage(
  p_organization_id uuid, p_provider text, p_model text,
  p_input_tokens integer, p_output_tokens integer, p_estimated_cost_usd numeric
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  insert into public.ai_usage_events (
    organization_id, job_id, provider, model, input_tokens, output_tokens, estimated_cost_usd
  ) values (
    p_organization_id, null, p_provider, p_model, p_input_tokens, p_output_tokens, p_estimated_cost_usd
  )
  returning jsonb_build_object('recorded', true);
$$;
```

El chequeo de presupuesto antes de la llamada es una lectura simple
(`getMonthToDateSpendUsd` + `getMonthlyBudgetUsd`, no una reserva
atómica) — acepta la misma clase de condición de carrera TOCTOU que ya
está documentada como riesgo aceptado en `copy-processor.ts` (issue de
seguimiento ya registrado en una sesión anterior), pero aquí el riesgo es
menor: esta llamada tiene `max_tokens` bajo y cuesta una fracción de lo
que cuesta generar copy — el peor caso de la carrera es exceder el
presupuesto mensual por el costo de una sugerencia barata, no por una
generación completa.

## Contrato de la API

```
POST /api/content/suggestions
Body: multipart/form-data, campo "asset" (un archivo, el mismo validador
      validateAsset() de siempre, sin cambios)

200 OK:
{
  "suggestions": {
    "niche": string | null,
    "contentType": "educativo" | "prueba" | "venta_directa" | null,
    "objective": "conversaciones_whatsapp" | "agenda_demo" | "trafico_web" | "autoridad" | null,
    "humanDescription": string | null,
    "offer": string | null,
    "cta": string | null
  }
}

Cualquier fallo (presupuesto agotado, OpenRouter caído, respuesta
inválida, timeout) -> 200 OK con "suggestions": null, nunca un error que
el cliente tenga que manejar de forma especial. El formulario ya sabe
tratar "sin sugerencias" como su estado por default.
```

## Cambios de frontend

- **`AssetDropzone`**: al aceptar el primer archivo válido, dispara la
  llamada (con manejo de carrera si el usuario cambia el archivo antes de
  que responda — se descarta la respuesta vieja). Muestra un estado sutil
  "Analizando tu creativo…" junto a la miniatura, no un bloqueo de pantalla
  completa.
- **`ContentForm`**: el campo de imagen se mueve al **primer lugar visual**
  del formulario (hoy está dentro de la tercera sección) — es la acción
  que dispara todo lo demás, debe ser lo primero que el usuario toca. Las
  demás secciones no cambian de orden entre sí.
- Los campos que la IA no sugiere (`businessLine` si no vino de AIAS,
  `campaignName`, `funnelStage`, `destination`, `destinationValue`,
  `allowedFacts`) siguen exactamente igual que hoy — este spec no promete
  reducir esos, sería inventar certeza donde no la hay.

## Seguridad

- El endpoint nuevo es una ruta de Next.js autenticada (mismo patrón que
  `POST /api/content`) — `organization_id` se deriva de la sesión, nunca
  del cliente.
- La imagen no se persiste en Storage en este paso — solo se manda a
  OpenRouter en memoria y se descarta; el content item real (y su subida a
  Storage) se sigue creando solo al enviar el formulario completo, sin
  cambios ahí.
- `record_interactive_ai_usage` es `service_role`-only, mismo patrón
  revoke/grant que el resto del esquema.

## Testing

- Tests del endpoint con `fetch` mockeado hacia OpenRouter: respuesta
  válida se parsea y regresa; respuesta inválida/timeout/sin presupuesto
  regresan `suggestions: null` sin lanzar; el gasto se registra solo
  cuando sí hubo respuesta del modelo (mismo criterio que
  `copy-processor.ts`: "el costo se registra siempre que hubo respuesta,
  incluso si la validación de forma falla después").
- Tests de `AssetDropzone`/`ContentForm`: sugerencias se mezclan sin
  sobrescribir campos ya editados por el usuario; una respuesta tardía de
  un archivo ya reemplazado se descarta; el formulario sigue siendo
  enviable si el análisis nunca llega.
- Test de migración (regex sobre el archivo `.sql`, mismo patrón
  establecido en este proyecto — sin Postgres local para correr contra una
  base real): confirma el `revoke`/`grant` de `record_interactive_ai_usage`
  y que `job_id` se pasa como `null`.
