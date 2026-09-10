# SnapGad Copy Worker V1 — contrato portal ↔ n8n

`n8n/SnapGad-Content-Engine-V1.json` es un worker **inactivo** y exclusivamente
de copy. El portal es la fuente de verdad: n8n recibe un trabajo firmado,
analiza el arte y devuelve borradores para revisión humana. No lee ni escribe
el almacenamiento del portal de forma directa y no publica en redes sociales.

## Variables de entorno de n8n

```text
SNAPGAD_PORTAL_BASE_URL=https://TU-PORTAL.example.com
SNAPGAD_N8N_SHARED_SECRET=secreto-largo-compartido-con-el-portal
OPENROUTER_API_KEY=...
OPENROUTER_VISION_MODEL=un-modelo-vision-compatible-con-openrouter
NODE_FUNCTION_ALLOW_BUILTIN=crypto
```

El export no contiene valores secretos. Configura `SNAPGAD_N8N_COPY_URL` solo
en el portal para entregar trabajos al webhook; no se usa para que n8n acceda a
datos del portal.

## Contrato firmado

El portal envía un trabajo a `POST /webhook/snapgad/content/copy` con:

```text
X-SnapGad-Timestamp: unix-seconds
X-SnapGad-Signature: sha256=HEX_HMAC
```

La firma es HMAC-SHA256 de `timestamp + "." + stableJson(body)` con
`SNAPGAD_N8N_SHARED_SECRET`. `stableJson` ordena las claves de los objetos y
preserva el orden de los arrays. El worker rechaza firmas ausentes, inválidas o
con más de cinco minutos.

El payload de entrada contiene únicamente `jobId` e `idempotencyKey`. No
incluye organización, usuario, `contentItemId`, asset, URL firmada ni brief.
El portal resuelve esos datos después de un claim válido. El brief derivado
incluye contexto permitido —por ejemplo nicho, oferta, CTA y `allowedFacts`—
pero no autoriza a inventar precios, resultados, urgencia, escasez,
testimonios ni características.

## Secuencia del worker

1. Verifica la firma del webhook y firma una petición de claim.
2. Hace `POST ${SNAPGAD_PORTAL_BASE_URL}/api/integrations/n8n/copy/claim` con
   `jobId` e `idempotencyKey`. El portal otorga el trabajo una sola vez y
   devuelve un `leaseToken`, una URL temporal del asset y el brief derivado al
   poseedor del claim.
3. Analiza el asset y produce análisis visual más exactamente dos borradores
   basados únicamente en los hechos permitidos.
4. Firma y envía el resultado a
   `POST ${SNAPGAD_PORTAL_BASE_URL}/api/integrations/n8n/copy/complete`.
   Incluye `jobId`, `idempotencyKey`, `leaseToken` y el resultado; el portal
   valida el lease vigente antes de guardar el resultado y transicionar de
   `GENERATING` a `DRAFT`.

Un reintento conserva la misma `idempotencyKey`. Si el envío inicial no obtiene
confirmación, el portal puede reentregarlo; el claim impide que una segunda
ejecución produzca un resultado duplicado.

## Límite actual de implementación

El contrato portal-side de enqueue, claim y complete está definido en el
repositorio, pero no se ha aplicado a una base de datos ni validado en staging.
El JSON permanece inactivo: importarlo es seguro, pero activarlo está bloqueado
hasta aplicar las migraciones, configurar secretos y conservar evidencia de
reintentos. No se debe sustituir este contrato con acceso directo del worker al
almacenamiento del portal.

## Prueba futura de staging

1. Importa el JSON y confirma que permanece inactivo.
2. Configura las variables en staging y usa un asset final no sensible.
3. Prueba el webhook con una firma válida y verifica que el claim se otorga una
   sola vez.
4. Repite exactamente el trabajo y confirma que el portal reutiliza el mismo
   estado y no genera otro resultado.
5. Confirma que complete sólo acepta el claim vigente y que el item vuelve a
   `DRAFT` antes de permitir revisión humana.
