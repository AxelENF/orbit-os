# Orbit OS by SnapGad — corte de producción para piloto personal

**Estado auditado:** 2026-09-12
**Objetivo inmediato:** que una campaña real atraviese el sistema sin inventar
claims ni publicar sin una decisión humana.

## Veredicto

La interfaz y el modelo de datos ya son una base útil. La instalación local
actual es deliberadamente un demo: no hay `.env.local`, el portal no inicia
una sesión de Supabase y no se ha comprobado una operación real de Storage,
RLS, worker o proveedor de IA. No se debe presentar como producción todavía.

La generación de copy, dos borradores y hashtags ya está integrada en la rama
del piloto. Las migraciones `0014` y `0015` permanecen pendientes de un apply
revisado en Supabase; por ello el comportamiento real sigue siendo demo hasta
completar el smoke autenticado.

## Flujo mínimo que sí se debe liberar

```text
usuario autenticado + organización activa
  -> sube activo privado
  -> define brief y hechos permitidos
  -> worker genera alternativas de copy
  -> humano elige/edita y aprueba por destino
  -> entrega manual asistida a Facebook/Instagram
  -> registra URL/resultado real
```

La primera liberación no necesita calendario, analítica avanzada, comentarios
colaborativos ni publicación autónoma. Esas capas se construyen únicamente
después de que el flujo anterior complete una campaña real de punta a punta.

## Bloqueadores de producción

| Prioridad | Hallazgo | Acción de cierre |
| --- | --- | --- |
| P0 | El demo no tiene Auth/RLS/Storage verificados. | Configurar variables locales seguras, crear usuario y organización de prueba, y ejecutar smoke autenticado con activo privado. |
| P0 | El worker y OpenRouter no se han ejecutado contra un job real. | Configurar un único worker server-side, límite mensual explícito y una campaña de prueba de bajo costo. |
| P0 | No existe un publicador Meta activo. | Mantener publicación manual asistida hasta comprobar OAuth, permisos por destino y callback idempotente en staging. |
| P1 | La IA leía presupuesto y registraba gasto como operaciones separadas. | Cerrado en código: `0015` reserva/conciliación atómica por job e intento. Falta apply y smoke concurrente. |
| P1 | La cola podía dejar contenido creado sin job si fallaba el enqueue. | Cerrado en código: el asset se conserva y el borrador permite reintento idempotente. Falta smoke durable. |
| P1 | Los hashtags permitían texto sin `#` en validación estructural. | Cerrado en código: TypeScript y `0014` validan formato. Falta apply y smoke de callback. |
| P2 | Hay valores de catálogo fijos de SnapGad en el formulario. | Tomar taxonomía, voz, servicios y restricciones desde el perfil de cada organización. |

## Secuencia de implementación

1. **Persistencia real:** revisar `0014` y `0015` como migraciones nuevas,
   aplicarlas solo tras un dry run y comprobar Auth + RLS + Storage por usuario
   y organización.
3. **Copy con supervisión:** levantar worker único, probar un activo privado,
   revisar salida, costo y reintentos; no permitir publicación automática.
4. **Resultado real:** generar una entrega manual de Facebook e Instagram con
   copy por plataforma, UTMs y registro de URL/resultado al volver de Meta.
5. **Meta por OAuth:** conectar una sola cuenta de SnapGad, preflight de
   permisos, publicación de staging y callback; después generalizar a clientes.

## Criterio de salida del piloto personal

- Un usuario autenticado solo puede ver su organización y sus activos.
- Un activo llega a Storage privado y genera dos alternativas de copy con
  hechos permitidos conservados.
- El gasto de IA queda acotado e identificable por job.
- Facebook e Instagram requieren aprobación independiente.
- Se registra el resultado real, aunque la primera publicación sea manual.
- La suite, tipos, lint y build pasan desde la raíz del repositorio.

## Regla operativa

IA propone; una persona aprueba; la plataforma registra. No se automatizan
presupuesto, promesas comerciales ni publicación sin una confirmación humana
explícita.
