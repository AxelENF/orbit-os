# Sugerencias por visión en el intake — diseño

**Fecha:** 2026-09-14 (revisión 4 — tres rondas de revisión con Codex CLI más una corrección manual final; lista para la fase de plan)
**Estado:** Aprobado por Axel de forma anticipada — sesión autónoma ("hazme las cosas, no preguntes, confío en ti"). Las decisiones de diseño que en otro momento se habrían preguntado una por una están documentadas aquí con su razonamiento, para que Axel pueda revisarlas y corregir cualquiera al volver. Ronda 1: 6 problemas (el más serio, el spec asumía por error el modelo de assets múltiples de la rama paralela sin mergear `feat/meta-publisher-oauth-adapter`). Ronda 2: 5 problemas más, incluido un bug real de diseño en el tracking de procedencia. Ronda 3 (última automatizada): 3/4 verificados, más una imprecisión de wording sobre qué cuenta como "editado por el usuario" — corregida a mano.
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

1. `AssetDropzone` (o el componente padre `ContentForm`), al recibir un
   archivo válido, llama `POST /api/content/suggestions` con ese archivo
   (multipart, un solo asset). **Corrección tras revisión de Codex CLI:**
   esta rama (`feat/intake-vision-simplification`, creada sobre
   `feat/personal-pilot-hardening`) todavía tiene `AssetDropzone` con
   `value: File | null` — un solo archivo, sin carrusel. El modelo de
   múltiples assets (`content_item_assets`, `AssetDropzone` con
   `value: File[]`) existe únicamente en la rama paralela y todavía sin
   mergear `feat/meta-publisher-oauth-adapter`. Este spec **no depende de
   esa rama** y trabaja sobre el estado real de esta: se analiza el único
   archivo que el usuario suelta. Cuando ambas ramas se integren, este
   flujo solo necesita apuntar a la posición 0 del arreglo en vez de al
   archivo único — no requiere rediseño.
2. La ruta corre un chequeo de presupuesto **blando** (lee
   `getMonthToDateSpendUsd`/`getMonthlyBudgetUsd`, ya existen en
   `worker/providers/ai-usage.ts` — sin reserva atómica, ver "Por qué no se
   reusa el sistema de reservas" abajo) y, si hay margen, llama a
   OpenRouter con un modelo de visión, y un prompt que pide **solo** los
   campos que una imagen puede sugerir de verdad: `niche` (si es
   visualmente evidente, p. ej. una clínica dental), `contentType`,
   `objective`, `humanDescription` (una frase describiendo qué se ve),
   `offer` (si hay texto de oferta/promoción visible en la imagen), `cta`
   (si hay una llamada a la acción visible).

   **Parámetros concretos** (mismo patrón de variables de entorno que
   `copy-processor.ts`, con su propio namespace porque puede ser un modelo
   distinto — más barato, ya que esto es extracción estructurada corta, no
   redacción de copy):
   - `SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL` — requerida, sin default (mismo criterio que `SNAPGAD_COPY_OPENROUTER_MODEL`: nunca asumir un modelo específico en código).
   - `SNAPGAD_INTAKE_SUGGEST_MAX_OUTPUT_TOKENS` — default `300` (la respuesta es un objeto JSON corto de 6 campos, no un draft de copy).
   - `SNAPGAD_INTAKE_SUGGEST_TIMEOUT_MS` — default `15000` (más corto que los `45000` de copy — esto debe sentirse instantáneo; si tarda más que esto, mejor fallar abierto que hacer esperar al usuario).
   - `SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD` — default `0.01` (un techo bajo a propósito, ver el razonamiento de riesgo abajo).
   - `SNAPGAD_INTAKE_SUGGEST_MODEL_INPUT_PRICE_PER_1M_USD` / `..._OUTPUT_PRICE_PER_1M_USD` — mismo patrón que sus equivalentes de copy.
3. La respuesta se valida con Zod (mismo rigor que `copy-processor.ts`) y
   se regresa al cliente como sugerencias. **No se persiste el asset ni se
   crea el content item en este paso** (eso sigue pasando solo al enviar
   el formulario completo, sin cambios) — pero sí se registra el gasto real
   en `ai_usage_events` cuando hubo respuesta del modelo, igual que
   cualquier otra llamada real a un proveedor de IA en este proyecto.
4. `ContentForm` mezcla las sugerencias en el estado del formulario.
   **Corrección tras revisión de Codex CLI:** el patrón `current ||
   suggestion` que ya usa el merge de AIAS **no funciona aquí tal cual** —
   `contentType` y `objective` arrancan con un valor no vacío en
   `initialState` (`CONTENT_TYPES[0]`, `CONTENT_OBJECTIVES[0]`), así que
   `current` siempre sería verdadero y la sugerencia de la imagen nunca se
   aplicaría a esos dos campos. Y sin ningún registro de qué fue sugerido
   vs. qué fue escrito por el usuario, una segunda imagen (el usuario
   cambia de creativo) no podría reemplazar las sugerencias de la primera
   — quedarían atrapadas como "current" para siempre.

   **Segunda corrección, tras revisión de Codex CLI ronda 2:** la primera
   versión de esta sección marcaba `suggestedFields[field] = false` al
   editar — pero eso hace que `!current[field]` vuelva a ser cierto en
   cuanto el usuario borra el campo a mano (lo deja vacío a propósito), y
   una sugerencia posterior lo volvería a llenar — justo lo que se quería
   evitar. La procedencia necesita ser un trinquete de un solo sentido, no
   un booleano que se puede revertir:

   Un `Set<keyof FormState>` llamado `userEditedFields` — una vez que un
   campo entra a este set, **nunca vuelve a salir**, sin importar que el
   usuario lo deje vacío. **Precisión agregada tras revisión de Codex CLI
   ronda 3:** "editado por el usuario" cubre **cualquier** origen de
   cambio disparado por el usuario, no solo tipeo en `<input>`/`<textarea>`
   — también selección en un `<select>` (`contentType`, `objective`, los
   dos campos con valor inicial no vacío, son selects hoy) y elección de
   una opción de `<datalist>`. Todo `onChange` que ya existe en el
   formulario agrega el campo al set al disparar, sin importar el tipo de
   control, incluso si el resultado es una cadena vacía. `applyProfile()`
   (el efecto de defaults de AIAS, ya existente) respeta el mismo set: no
   sobreescribe ningún campo que ya esté en `userEditedFields`, por la
   misma razón — si el usuario ya editó algo a mano, ningún origen
   automático (perfil de AIAS o imagen) debe tocarlo de nuevo, sin
   importar cuál llegue primero o después.

   Al aplicar una respuesta de `/api/content/suggestions`,
   un campo se sobrescribe si **y solo si** `!userEditedFields.has(field)`
   — nunca ha sido tocado a mano — **y** el valor sugerido no es `null`
   (una sugerencia ausente para un campo nunca escribe `null` sobre un
   valor existente ni sobre el vacío; simplemente no toca ese campo).
   `contentType`/`objective` no necesitan ningún truco de inicialización
   especial con este modelo — su valor inicial no vacío es irrelevante
   para la condición, que ahora depende solo de si el usuario los tocó.

   Esto también resuelve la precedencia con los defaults de AIAS
   (`applyProfile()`, ya existente): ese efecto pre-llena `niche`, `cta`,
   `humanDescription`, etc. sin agregar nada a `userEditedFields` — son un
   punto de partida genérico, no una decisión del usuario. Una sugerencia
   de la imagen (más específica que el perfil de la organización) puede
   reemplazarlos libremente, exactamente el orden de precedencia correcto:
   AIAS (genérico) → imagen (específico) → usuario (final), y solo el
   último es irreversible.

   Se muestra un banner "✨ Sugerido por tu imagen — revisa antes de
   continuar", separado del banner existente de AIAS.
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

**Esto es deliberadamente una guardarraya más débil que la de
`copy-processor.ts`, no un patrón ya aceptado en otro lado** (corrección
tras revisión de Codex CLI — la versión anterior de este párrafo decía lo
contrario, y es falso: `copy-processor.ts` usa `reserve_ai_request_budget`
precisamente para **cerrar** la carrera de lectura-luego-escritura entre
dos llamadas concurrentes, no para aceptarla). Aquí se elige a propósito
un chequeo de solo-lectura (`getMonthToDateSpendUsd` +
`getMonthlyBudgetUsd`, sin reserva atómica) por dos razones: la reserva
exige un `job_id` con FK real a un job durable (ver arriba), y esto debe
sentirse instantáneo, no esperar un ciclo de encolado. La carrera real que
esto acepta: si dos sugerencias del mismo organization_id se disparan casi
al mismo tiempo (dos pestañas, dos campañas creándose a la vez), ambas
podrían pasar el chequeo de presupuesto antes de que cualquiera registre
su gasto, permitiendo exceder el límite mensual. **Corrección tras revisión de Codex CLI ronda
2:** el sobregasto NO está acotado a una sola llamada — escala con el
número de solicitudes concurrentes del mismo organization_id que pasan el
chequeo antes de que cualquiera registre su gasto (tres pestañas
subiendo campañas al mismo tiempo → hasta 3× el costo de una llamada, no
1×). Lo que sí sigue acotado es el costo *por solicitud*
(`SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD`, default `0.01` USD). El
sobregasto agregado real depende de cuántas solicitudes concurrentes del
mismo organization_id lleguen a competir — no hay un límite de
concurrencia definido en este spec, así que no se afirma un techo en
dólares para el escenario agregado (corrección tras revisión de Codex CLI
ronda 3: la versión anterior decía "serán centavos", una certeza que no
está respaldada sin ese límite). Se acepta el riesgo explícitamente sin
cuantificarlo de más: el escenario requiere varias personas de la misma
organización creando campañas en la misma ventana de segundos, cada
solicitud individual sigue acotada por
`SNAPGAD_INTAKE_SUGGEST_MAX_REQUEST_COST_USD`, y un límite de
concurrencia real (semáforo o reserva atómica sin FK a `automation_jobs`)
queda fuera de alcance de este spec si el riesgo agregado deja de ser
aceptable. Si esto deja
de ser aceptable en el futuro (más de un usuario por organización subiendo
campañas a la vez, con frecuencia), la solución es la misma reserva
atómica de `copy-processor.ts` sobre una tabla de reservas sin FK a
`automation_jobs` — explícitamente fuera de alcance de este spec.

## Contrato de la API

```
POST /api/content/suggestions
Auth: sesión autenticada real requerida — SIN camino de demo/anónimo.
      (Corrección tras revisión de Codex CLI: POST /api/content sí tiene
      un modo demo sin autenticación — repository-factory.ts — pero este
      endpoint nuevo llama a OpenRouter con presupuesto real de la
      organización; nunca debe ser alcanzable sin sesión, aunque el resto
      del intake algún día lo sea en demo.)
Body: multipart/form-data, campo "asset" (un archivo, el mismo validador
      validateAsset() de siempre, sin cambios)

401 Unauthorized: sin sesión válida.
400 Bad Request: multipart inválido, o el archivo no pasa validateAsset()
      (mismo error que ya usa POST /api/content en ese caso).
200 OK:
{
  "suggestions": {
    "niche": string | null,
    "contentType": "educativo" | "prueba" | "venta_directa" | null,
    "objective": "conversaciones_whatsapp" | "agenda_demo" | "trafico_web" | "autoridad" | null,
    "humanDescription": string | null,
    "offer": string | null,
    "cta": string | null
  } | null
}

"suggestions": null" en un 200 (no un error) es el resultado esperado
cuando el análisis opcional de IA no pudo completarse por una razón que no
es culpa de la solicitud: presupuesto mensual agotado, OpenRouter caído o
con timeout, o una respuesta que no cumple el schema esperado. La
solicitud en sí fue válida (auth correcta, archivo válido) — solo no hubo
sugerencia que ofrecer. El formulario ya sabe tratar "sin sugerencias"
como su estado por default.

**Casos adicionales, agregados tras revisión de Codex CLI ronda 2** (la
versión anterior no los cubría):
- **Configuración del proveedor ausente** (falta `SNAPGAD_INTAKE_SUGGEST_OPENROUTER_MODEL`, `OPENROUTER_API_KEY`, o los precios) → `503`, mismo patrón que `ContentConfigurationError` ya usa en otras rutas de este proyecto (`INTEGRATION_NOT_CONFIGURED`) — es un error de despliegue, no algo que el usuario pueda resolver reintentando.
- **Fallo de Supabase al leer el gasto/presupuesto mensual** (`getMonthToDateSpendUsd`/`getMonthlyBudgetUsd` lanzan) → se trata igual que "sin margen de presupuesto": `200` con `suggestions: null`. No tiene sentido bloquear el llenado del formulario porque una lectura de solo-consulta falló; el peor caso es simplemente no ofrecer sugerencia esa vez.
- **Fallo al registrar el gasto DESPUÉS de una respuesta real de OpenRouter** (`record_interactive_ai_usage` lanza) — este es el caso que sí importa: ya se incurrió en un costo real. No se descarta la sugerencia ya pagada (se regresa `200` con las sugerencias reales igual), pero el fallo de registro se loguea con `console.error` en el servidor (mismo patrón que otros errores no fatales de este proyecto) para que quede visible operacionalmente — un gasto de $0.01 sin registrar no amerita fallarle la solicitud al usuario, pero tampoco debe desaparecer en silencio sin que nadie se entere.
```

**Cómo se manda la imagen sin persistirla** (el processor de copy usa una
signed URL de Storage porque el asset ya existe ahí — aquí el asset
todavía no se subió a ningún lado): la ruta lee los bytes del archivo del
multipart body directamente en memoria, los convierte a un data URL
base64 (`data:image/png;base64,...`), y lo manda como `image_url.url` en
el mensaje a OpenRouter — los endpoints de chat completions compatibles
con OpenAI aceptan data URLs igual que URLs https. `validateAsset()` ya
acota el archivo a 20 MB (`MAX_ASSET_BYTES`); en base64 eso crece a ~27 MB
de cuerpo de solicitud — se acepta ese techo tal cual, sin un límite nuevo
inventado para este endpoint.

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
- `userEditedFields` y los valores del formulario deben vivir en una sola
  estructura de estado (o actualizarse dentro del mismo `setState`
  funcional) para evitar una condición de carrera de React entre una
  respuesta de sugerencias que llega tarde y una edición del usuario que
  ocurre casi al mismo tiempo — detalle de implementación, no de
  comportamiento, pero el plan debe resolverlo explícitamente.
- Los campos que la IA no sugiere (`businessLine` y `service` si no
  vinieron de AIAS, `campaignName`, `funnelStage`, `destination`,
  `destinationValue`, `allowedFacts`) siguen exactamente igual que hoy —
  este spec no promete reducir esos, sería inventar certeza donde no la
  hay.
- `humanDescription` hoy le pide al usuario dolor, resultado y público —
  tres cosas que una imagen sola no puede darte. La sugerencia de la
  imagen es solo un punto de partida honesto ("se ve un consultorio
  dental, promoción de limpieza dental"), no un reemplazo completo del
  campo; el banner de sugerencia dice explícitamente "revisa antes de
  continuar" para que quede claro que hay que completarlo, no solo
  aceptarlo.

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
