# Orbit OS — Generador de copy real con hashtags (worker interno)

**Estado:** diseño en revisión, brainstorm con Axel el 10 de septiembre de 2026.

## Motivación

Auditoría funcional del 2026-09-10 confirmó que hoy **no existe generación de
copy con IA en ningún camino**: en demo, `lib/demo/draft-store.ts` concatena
una plantilla fija; en producción, `worker/providers/copy-provider.ts` es una
interfaz vacía y `SNAPGAD_COPY_WORKER_MODULE` no apunta a ningún módulo real.
Tampoco existe el campo `hashtags` en ningún contrato del repositorio. Además,
**ninguna pantalla dispara la generación**: `POST /api/integrations/n8n/copy`
sólo puede ser llamado externamente y ningún componente de UI lo invoca, así
que el camino de producción queda parado incluso si n8n estuviera activo.

Este diseño cierra ambos huecos usando el **worker interno** (`worker/entrypoint.ts`),
que es el camino por defecto según ADR-002 (n8n es extensión, no dependencia
diaria) — no se toca el bridge n8n existente.

## Alcance

**Incluye:**
- Trigger de enqueue del job `COPY` para el worker interno, desacoplado de
  n8n. Nota: `repository.enqueueCopyJob` / `enqueue_copy_automation_job` ya
  existen y ya se usan hoy en `POST /api/integrations/n8n/copy` — lo nuevo es
  **sólo** el punto de disparo automático desde `POST /api/content`, no la
  lógica de encolado en sí.
- `worker/providers/copy-processor.ts`: processor real contra OpenRouter con
  visión, exactamente 2 alternativas de copy y 5-8 hashtags cada una.
- Migración aditiva `0014`: columna `hashtags` en `copy_drafts`, tabla de
  bitácora de uso de IA (`ai_usage_events`) y tope de presupuesto mensual
  opcional por organización.
- Validación fail-closed de claims sobre el copy y los hashtags generados,
  reusando la lógica ya existente en `lib/content/final-copy.ts`.
- UI: estado "Generando" visible con poll en `/drafts` mientras el job corre.

**No incluye (fuera de este diseño, a propósito):**
- Aprobación humana por destino, publisher real de Meta, bridge n8n — sin
  cambios.
- Generación o edición de imágenes con IA. El creativo sigue llegando
  terminado; la producción de imágenes de marca ocurre en un flujo externo
  del cliente y está fuera de este producto.
- El postprocesador de logo en lote ("SnapGad Batch Studio") — sub-proyecto
  separado, spec de referencia ya capturada para un brainstorm futuro.
- Acelerar/rediseñar el onboarding AIAS genérico — confirmado como dirección
  correcta pero es una unidad de trabajo distinta.

## Flujo de datos

```text
Intake (content-form) → POST /api/content
  → crea content_item + asset privado                          [ya existe]
  → NUEVO: enqueue automático de automation_job kind=COPY
     provider queda en su default de columna ("local", 0013)
  → content_item pasa a GENERATING

worker/entrypoint.ts (proceso persistente, npm run worker)
  → claim_next_copy_automation_job (brief + URL firmada del asset)
  → worker/providers/copy-processor.ts                          [nuevo]
     1. chequeo de presupuesto mensual (ai_usage_events vs. tope de la org)
     2. llamada a OpenRouter (modelo con visión), timeout duro
     3. valida forma: 2 drafts, headline/body/cta no vacíos, 5-8 hashtags
     4. valida claims: grounding en allowedFacts, rechazo de forbiddenClaims
     5. registra costo real (tokens de la respuesta) en ai_usage_events
  → complete_copy_automation_job → ingest_copy_result_callback (extendida)
     content_item → DRAFT, copy_drafts recibe headline/body/cta/hashtags

/drafts hace poll mientras el estado es GENERATING                [nuevo, UI]
Revisión humana → Aprobación por destino (sin cambios)
```

## Contratos

- `lib/content/final-copy.ts`: `FinalCopyInput` gana `hashtags: string[]`;
  `validateFinalCopy` corre la misma validación de claims prohibidos sobre
  los hashtags que ya corre sobre headline/body/cta.
- `lib/demo/draft-store.ts`: `DemoCopyOption` gana `hashtags: string[]` para
  mantener paridad visual con producción (sigue siendo plantilla local, sin
  IA, con su warning explícito intacto).
- `worker/providers/copy-processor.ts` (nuevo): implementa el contrato que
  `worker/entrypoint.ts` espera de `SNAPGAD_COPY_WORKER_MODULE` — exporta una
  función default que recibe el **`DurableJob<SupabaseCopyJobPayload, Result>`
  completo** (no sólo el payload: `job.organizationId` e `job.id` viven en el
  nivel superior de esa envoltura; `contentItemId`/`storagePath`/`assetUrl`/
  `brief` están anidados en `job.payload`, ver `worker/durable-runner.ts` y
  `lib/automation/durable-job-contract.ts`). El guardrail de presupuesto usa
  `job.organizationId`; el registro en `ai_usage_events` usa `job.id`. La
  función regresa `{ visualAnalysis, drafts, warnings, provider: "openrouter",
  model }`, la forma exacta que ya consume `complete_copy_automation_job`.

## Migración `0014` (aditiva)

1. `copy_drafts`: agrega columna `hashtags jsonb not null default '[]'::jsonb`
   con `check` de que sea un array de 0 a 8 strings no vacíos. Este rango es
   deliberadamente más laxo que el guardrail de aplicación (5-8): la base de
   datos acepta cualquier forma razonable para no romper el contrato n8n
   existente si se activa sin pasar por el processor nuevo; el rango 5-8 es
   una regla del processor, no de la base.
2. `ingest_copy_result_callback`: `create or replace function` (mismo nombre y
   firma) para leer `hashtags` opcional de cada entrada de `p_drafts`
   (default `[]` si el llamador no lo manda — no rompe el contrato n8n si
   algún día se activa sin pasar por este cambio). La función valida la forma
   de `hashtags` (array de strings no vacíos, máximo 8) igual que ya valida
   headline/body/cta, devolviendo `COPY_RESULT_INVALID_DRAFTS` en vez de
   dejar que un `check` de tabla produzca un error crudo de Postgres.
3. Tabla nueva `ai_usage_events` (append-only, mismo espíritu que
   `audit_events`): `organization_id`, `job_id`, `provider`, `model`,
   `input_tokens`, `output_tokens`, `estimated_cost_usd`, `created_at`. RLS:
   lectura por miembros de la organización, escritura sólo `service_role`.
4. `organizations` gana `ai_monthly_budget_usd` (nullable, default `null` =
   sin tope, no rompe organizaciones existentes).
5. `fail_copy_automation_job` (definida en `0013`): hoy sólo actualiza
   `automation_jobs` — no toca `content_items` ni `audit_events`. Verificado
   contra el código: si no se extiende, un fallo del worker deja el
   `content_item` atascado en `GENERATING` para siempre (la transición
   `GENERATING → ERROR` ya existe en `lib/content/state-machine.ts` pero nada
   la dispara aquí) y no aparece ningún evento en `/history` (que lee
   `audit_events` directamente). `create or replace function` (mismo nombre y
   firma) para que, cuando el resultado sea `FAILED` o `DEAD_LETTER` (es
   decir, ya no va a reintentar), además transicione el `content_item` de
   `GENERATING` a `ERROR` e inserte una fila en `audit_events` con el error
   saneado — mismo patrón atómico que ya usa `ingest_copy_result_callback`.
   Cuando el resultado es `RETRY_WAIT`, no se toca `content_items` (el worker
   va a reintentar).

## Guardrails de costo/calidad, en orden

1. **Presupuesto:** antes de llamar al modelo, suma `ai_usage_events` del mes
   en curso para la organización; si supera `ai_monthly_budget_usd`, el job
   falla como **no reintentable** (pasa a `FAILED`, ver más abajo) y queda un
   finding claro en `/history` vía el `audit_events` que ahora inserta
   `fail_copy_automation_job` (punto 5 de la migración).
2. **Timeout duro** por llamada a OpenRouter (`AbortController`, ~45s). Un
   timeout **sí es reintentable**.
3. **Forma de la respuesta:** exactamente 2 drafts, `headline`/`body`/`cta`
   no vacíos, 5-8 hashtags por draft. Si el modelo no cumple el formato, falla
   como **reintentable** (backoff, ya lo maneja `DurableJobRunner`).
4. **Claims:** cada draft (incluidos hashtags) se valida contra
   `allowedFacts`/`forbiddenClaims` con la lógica ya existente en
   `final-copy.ts`, extraída a una función compartida en vez de duplicarse.
   Un claim prohibido falla como **no reintentable** (reintentar no cambia el
   resultado: el modelo tendería a repetir el mismo problema con el mismo
   brief).
5. Sólo si todo pasa: se registra el costo real (tokens devueltos por
   OpenRouter) y se completa el job.

**Cómo se comunica "reintentable" al runner (pieza que hoy no existe):**
verificado contra `worker/durable-runner.ts:106`, sin configuración explícita
`isRetryable` **todo** error se trata como reintentable — el guardrail de
presupuesto, tal cual, terminaría reintentando hasta `DEAD_LETTER` en vez de
ir directo a `FAILED`. `copy-processor.ts` lanza una clase de error dedicada
(`CopyGuardrailError`, con un campo `retryable: boolean`) para los casos no
reintentables (presupuesto, claim prohibido); cualquier otro error (red,
timeout, forma inválida) queda reintentable por default. `worker/entrypoint.ts`
pasa `isRetryable: (error) => !(error instanceof CopyGuardrailError) || error.retryable`
al construir el `DurableJobRunner`.

Nada de este flujo llama a Meta, publica, ni se salta la revisión humana —
el resultado sigue siendo un borrador en estado `DRAFT`, igual que hoy.

## UI

`/drafts` hace poll mientras `content.state === "GENERATING"`. El label
`GENERATING: "Generando"` ya existe hoy en `statusLabels` (se ve en la carga
inicial); lo que falta específicamente es el **refresco automático** — hoy la
pantalla carga una vez y no se entera cuando el worker termina. El copy y los
hashtags aparecen editables antes de enviar a revisión, igual que hoy con
`headline`/`body`/`cta`.

## Testing

- Contrato de `final-copy.ts` extendido: casos de hashtags con claim
  prohibido, grounding correcto, conteo fuera de rango.
- `copy-processor.ts`: mockear la llamada a OpenRouter (sin red real en
  tests); casos de guardrail de presupuesto excedido, timeout, forma
  inválida, claim prohibido en un draft.
- Forma SQL de la migración `0014` (mismo patrón que las migraciones
  anteriores, que se revisan como `parse_partial`).
- Regresión de `ingest_copy_result_callback` con y sin `hashtags` en el
  payload, para confirmar que no rompe el contrato n8n existente.

## Variables de entorno nuevas

- `OPENROUTER_API_KEY` (server-only). Verificado: **no existe hoy en
  `.env.example`** — sólo aparece documentada para el entorno de despliegue
  de n8n (`docs/n8n/content-copy-workflow.md`, un contenedor distinto a este
  repo). Hay que agregarla a `.env.example` como parte de esta unidad, no
  asumir que ya está.
- `SNAPGAD_COPY_OPENROUTER_MODEL` (modelo con visión a usar).
- `SNAPGAD_COPY_TIMEOUT_MS` (default 45000).

Ninguna se activa ni se llama sin que Axel las configure explícitamente;
sin ellas el worker sigue fallando cerrado, igual que hoy.
