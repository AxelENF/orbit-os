# Handoff — rumbo de automatización de marketing (2026-09-12)

Este documento existe porque la sesión se puso larga y Axel pidió explícitamente
un corte limpio antes de seguir: "dejémonos de juegos". Cualquier sesión nueva
(Claude, Codex CLI, o quien sea) debe leer esto primero, antes de asumir nada
del estado del proyecto.

## Estado real ahora mismo

- **Rama activa:** `feat/personal-pilot-hardening` (incluye como ancestro
  `feat/copy-generator-hashtags`, ya con PR abierto).
- **PR #1** (`https://github.com/AxelENF/orbit-os/pull/1`, generador de copy
  real con hashtags): **abierto, mergeable, sin mergear todavía.** No se ha
  tomado decisión de mergearlo o seguir apilando trabajo encima en esta rama.
- **`feat/personal-pilot-hardening`** ya tiene trabajo adicional de otra sesión
  (no de este hilo de conversación): migraciones `0014`–`0017`, reserva
  atómica de presupuesto de IA, taxonomía de contenido por tenant, prefill
  desde perfil AIAS, registro de entrega manual y resultado de publicación, y
  un panel de "pilot readiness". Ver `docs/vault/05-personal-pilot-production-plan.md`
  para el detalle completo de esa auditoría.
- **ADR-008** (recién adoptada, commit `dc6f953`): supersede ADR-005.
  Publicación automática por default; el diagnóstico determinista
  (`lib/aias/publication-diagnosis.ts`) es la red de seguridad — sólo detiene
  para revisión humana cuando marca un hallazgo de riesgo real. Esto es una
  reversión deliberada y explícita de "aprobación humana siempre obligatoria",
  confirmada dos veces por Axel en esta conversación.
- **`05-personal-pilot-production-plan.md`** ya fue corregido en el mismo
  commit para no contradecir ADR-008 — pero el resto de ese documento (Auth/RLS/Storage,
  worker, presupuesto) sigue vigente sin cambios.

## Por qué llegamos aquí (contexto que no debe perderse)

Axel se frustró fuerte con el estado del proyecto ("no me gusta para nada",
"Canva hace lo mismo más fácil"). Al aterrizar la queja, la comparación con
Canva no aplica (Canva no genera copy con guardrails de marca, no tiene
aprobación por plataforma, no publica, no es multi-tenant para una agencia) —
pero dos quejas sí eran reales y quedaron confirmadas:

1. El portal pide demasiada info manual antes de mostrar cualquier resultado
   de IA (13 campos en el intake), y la visión de IA que sí se construyó en
   `worker/providers/copy-processor.ts` nunca se desplegó ni se usó para
   reducir ese formulario.
2. La meta real del producto es **automatizar publicaciones para generar
   comunidad**, no una aprobación manual más rápida — de ahí ADR-008.

Axel también aclaró el panorama de negocio completo: tiene un bot de
WhatsApp/ventas corriendo y mejorándose por separado en su PC principal, para
captar clientes masivamente y darles consultoría tipo "super vendedor" — **ese
bot está fuera del alcance de este repositorio**, se menciona sólo como
contexto de que el otro motor de crecimiento de SnapGad ya existe y este
proyecto (Orbit OS) es el motor de marketing/contenido/comunidad que lo
complementa. La meta explícita es que Orbit OS sea **replicable a muchas
empresas** (no sólo SnapGad) y que la herramienta en sí misma demuestre el
nivel técnico de SnapGad ante clientes.

## Lo que Axel pidió construir, y lo que se descartó

Axel describió en una sola idea: Codex (su flujo externo de generación de
imágenes con IA, entrenado por él) + esta app + necesidad de MCP + logo
automático sobre las imágenes de Codex + publicación autónoma + bot que
conteste comentarios. Se le señaló que eso son 5 sistemas distintos mezclados,
y se decompuso así:

1. **Publisher real de Meta** (OAuth + adaptador que publica de verdad) — no
   existe todavía, sólo hay preflight (`lib/integrations/meta-publisher.ts`).
   Es el bloqueador real: nada de lo demás funciona sin esto.
2. **Auto-publish con diagnóstico** (ADR-008) — capa delgada sobre el #1, ya
   decidida a nivel de producto, falta el diseño técnico.
3. **Compositor de logo automático sobre imágenes de Codex** — ya tiene spec
   de referencia capturada en memoria (`project_logo_batch_studio.md`,
   mockup "SnapGad Batch Studio": batch upload, logo transparente, posición
   en 4 esquinas, tamaño, margen, export en ZIP, procesamiento client-side).
   Ahora se quiere además integrado al pipeline automático, no sólo como
   herramienta manual.
4. **Capa MCP** — exponer el pipeline (generar imagen externamente, poner
   logo, generar copy, publicar) como herramientas orquestables por un
   agente. Axel quiere que el sistema funcione "principalmente a través de
   MCP".

**Descartado explícitamente por Axel:** el bot que contesta comentarios de
Facebook/Instagram. Sale del alcance actual — es una superficie de API y un
conjunto de guardrails completamente distintos (comentarios/mensajes, no
publicaciones). No se debe proponer de nuevo sin que Axel lo pida otra vez.

## Orden de trabajo acordado

1. Publisher real de Meta (OAuth + adaptador) — **siguiente paso inmediato**.
2. Auto-publish con diagnóstico (ADR-008), sobre el #1.
3. Compositor de logo automático — se puede construir en paralelo al #1
   porque no depende de credenciales de Meta.
4. Capa MCP — después de que 1-3 existan de verdad; envolver por MCP algo que
   no existe todavía no aporta nada.

Ninguno de los 4 tiene todavía un spec ni un plan escritos — sólo existe esta
decisión de alcance y de orden. El siguiente paso real es abrir un brainstorm
(`superpowers:brainstorming`) para el publisher de Meta, siguiendo el mismo
rigor que ya se usó para el generador de copy (spec revisado 3 veces, plan
revisado 3 veces, implementación por tarea con revisión antes de cada commit).

## Recordatorios operativos que no deben perderse

- `organization_id` sigue siendo el límite de tenant; nunca se confía en un
  valor enviado por el navegador.
- El publisher de Meta sigue fallando cerrado sin `META_*`/OAuth configurados
  explícitamente por Axel — ADR-008 no activa nada por sí sola.
- No modificar migraciones ya aplicadas (`0001`-`0017` a la fecha); toda
  extensión de esquema es una migración nueva y aditiva.
- Axel quiere precisión y planificación real, no improvisación — cada
  subsistema de la lista de 4 necesita su propio spec + plan + revisión antes
  de escribir código, igual que se hizo con el generador de copy.
- Identidad de git ya está correcta (`AxelENF` + noreply de GitHub) — ver
  `project_orbit_os_git_identity.md` en memoria, no cambiarla a un gmail
  personal.
