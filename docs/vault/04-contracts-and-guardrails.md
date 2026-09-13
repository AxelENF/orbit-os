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
- Las migraciones `0012_automation_job_status_values.sql` y `0013_automation_job_lifecycle.sql` están aplicadas al proyecto Supabase `zsljrjuebdgcyinexdlj`; el adapter no sustituye la validación end-to-end de RLS con usuarios Auth.
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

## Generación visual: sistema tipográfico SnapGad

- Toda creatividad SnapGad debe usar **una sola familia sans-serif formal, no condensada y consistente**. La referencia de marca para la edición final es **Montserrat Arabic**; si la herramienta de generación no la reproduce fielmente, se usa una equivalencia limpia tipo **Arial/Helvetica**, nunca una segunda fuente decorativa.
- Jerarquía fija: *eyebrow* en peso Medium/500, mayúsculas con espaciado moderado; titular en Bold/800–900; apoyo en Regular/400–500; y CTA/footer en Bold/700. El footer y el botón CTA deben compartir exactamente la misma familia y el mismo lenguaje de peso que el resto de la pieza.
- Se prohíben fuentes condensadas de póster, serif, script, itálicas, tipografías "tech" ornamentales y mezclas de familias dentro del mismo arte. El color naranja define énfasis, no un cambio de fuente.
- Antes de aceptar una imagen, revisar que titular, texto de apoyo, footer y CTA tengan anchura de letra, altura de x, espaciado y peso visual coherentes. Si el generador mezcla estilos o vuelve el CTA más condensado/diferente que el copy, se regenera o se corrige en Canva antes de publicar.
- Regla de prompt obligatoria: `Tipografía única y consistente: sans-serif formal no condensada, equivalente a Montserrat Arabic (fallback Arial/Helvetica). Titular Bold 800–900, apoyo Regular 400–500 y CTA/footer Bold 700; no mezclar familias, no usar fuente condensada, serif, script ni itálica.`

## Publication

- Facebook e Instagram tienen estados y errores independientes.
- La app guarda el ID remoto y URL de cada publicación.
- No se publican claims que no estén en `allowedFacts` o en el perfil aprobado.
