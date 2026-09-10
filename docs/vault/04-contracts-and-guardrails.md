# Contratos y guardrails

## Tenant

- La organización se deriva de la sesión autenticada y de una membresía válida.
- Nunca se confía en `organizationId` enviado libremente por el cliente.
- La organización activa se transportará en una cookie firmada con `SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET`; el valor siempre se vuelve a validar contra `organization_members`.
- Todas las consultas, assets, jobs, integraciones y auditorías se filtran por organización.

## AIAS profile

- El perfil debe contener rubro, oferta, cliente ideal, dolor, tono, claims permitidos, claims prohibidos y CTA.
- Cada job de IA conserva `profile_version`.
- El copy generado es un borrador hasta pasar validación y aprobación.
- El diagnóstico de publicación es puro y fail-closed: no hace llamadas de red, no publica y no considera listo un material sin dolor, prueba y CTA verificables.
- Un claim que aparece en la lista prohibida siempre gana sobre la lista permitida; un conflicto produce un hallazgo de error.

## Jobs

- Todo job tiene `idempotency_key`.
- Un lease vencido puede recuperarse sin duplicar resultado.
- Los errores deben ser sanitizados antes de mostrarse en UI.
- Los trabajos largos no se ejecutan dentro de una petición web.
- `SupabaseCopyWorkerStore` sólo expone al proceso worker claim/lease/mutaciones; no crea jobs ni acepta payloads de tenant desde el navegador.
- El endpoint de health es interno, bearer-token gated y devuelve telemetría agregada sin briefs, assets o credenciales.
- La migración `0013_automation_job_lifecycle.sql` es preparación de staging; el adapter no implica que Supabase remoto ya esté aplicado.
- `npm run worker` exige un módulo de processor explícito; sin ese módulo o sin service-role termina antes de reclamar trabajo.
- El runner renueva leases durante operaciones largas y apaga el polling con `SIGTERM`/`SIGINT`; los errores de provider se persisten con el contrato de retry.

## Assets

- El archivo original es privado.
- El path incluye el tenant y el asset ID.
- Se conserva checksum, MIME real, dimensiones y derivativos.
- Para Instagram se genera JPEG normalizado cuando el original no cumple el formato requerido.

## Generación visual: escala física de dispositivos

- Toda pieza SnapGad 4:5 con laptop debe representar una ultrabook realista de **13–14 pulgadas, relación 16:10**; nunca un monitor, una laptop de tamaño imposible ni un teclado desproporcionado.
- En un lienzo de **1080 × 1350 px**, la laptop completa debe ocupar aproximadamente **32–42 % del área visual**; la pantalla visible no puede superar **46 % de la altura del lienzo** (máximo 621 px). Debe haber plano de escritorio y aire alrededor para que se perciba escala, no un close-up gigante.
- La laptop debe dejar al menos **8 % de margen** respecto a los bordes del lienzo y no puede quedar recortada por más de un borde. Si aparece junto a un teléfono, la laptop es soporte de la web y el teléfono conserva el rol de prueba conversacional; los dispositivos combinados no deben saturar el arte.
- Antes de aceptar una imagen, revisar proporción de pantalla, teclado, biseles, grosor y perspectiva contra una laptop real. Si parece un monitor gigante, una maqueta o elimina el espacio negativo del copy, se regenera aunque el resto de la composición sea buena.
- Regla de prompt obligatoria: `Laptop físicamente realista de 13–14 pulgadas, escala moderada sobre escritorio, máximo 42 % del área visual, pantalla no mayor a 46 % de la altura, márgenes visibles; evitar laptop gigante, monitor, close-up desproporcionado o teclado sobredimensionado.`

## Publication

- Facebook e Instagram tienen estados y errores independientes.
- La app guarda el ID remoto y URL de cada publicación.
- No se publican claims que no estén en `allowedFacts` o en el perfil aprobado.
