# SnapGad Content Engine V1 — copy job

El archivo `n8n/SnapGad-Content-Engine-V1.json` contiene una ruta `POST /webhook/snapgad/content/copy`. El workflow se importa con `active: false` y no contiene tokens. El portal sigue siendo la fuente de verdad; n8n ejecuta el análisis y devuelve dos borradores para revisión humana.

## Variables de entorno de n8n

```text
SNAPGAD_PORTAL_URL=https://TU-PORTAL.example.com
SNAPGAD_N8N_SHARED_SECRET=secreto-largo-compartido-con-el-portal
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
OPENROUTER_API_KEY=...
OPENROUTER_VISION_MODEL=un-modelo-vision-compatible-con-openrouter
```

El `SUPABASE_SERVICE_ROLE_KEY` solo se configura en el servidor de n8n. Nunca se expone al navegador ni se agrega al JSON exportado.

## Payload firmado de entrada

El portal debe enviar `Content-Type: application/json` y los siguientes headers:

```text
X-SnapGad-Timestamp: 1760000000
X-SnapGad-Signature: sha256=HEX_HMAC
```

El texto firmado es `timestamp + "." + stableJson(body)`. `stableJson` es JSON recursivo con las claves de cada objeto ordenadas lexicográficamente; los arrays conservan orden. HMAC es `SHA-256` con `SNAPGAD_N8N_SHARED_SECRET`. Se rechazan firmas ausentes, inválidas o con más de cinco minutos.

Body mínimo:

```json
{
  "contentItemId": "uuid-del-content-item",
  "ownerId": "uuid-del-owner",
  "assetUrl": "https://cdn.example.com/final-canva-asset.png",
  "idempotencyKey": "uuid-unico-por-solicitud",
  "brief": {
    "businessLine": "AUTOMATIZAR",
    "service": "bot_whatsapp",
    "niche": "clinicas",
    "contentType": "venta_directa",
    "objective": "conversaciones_whatsapp",
    "format": "feed_4_5",
    "cta": "Escribe AGENDA por WhatsApp",
    "humanDescription": "Arte final aprobado en Canva para un bot de citas.",
    "allowedFacts": [
      "El bot atiende preguntas",
      "El bot puede ayudar a agendar citas",
      "La configuración se adapta al negocio"
    ]
  }
}
```

`assetUrl` debe ser HTTPS, accesible desde los servidores de OpenRouter y conservarse accesible hasta que termine la ejecución. El formato `feed_4_5` indica el arte final 1080 × 1350; Canva sigue siendo el paso de logo/footer y aprobación.

## Secuencia y estados

1. Verifica firma y campos.
2. Consulta `automation_runs` por `kind=COPY_REQUEST` e `idempotency_key`. Un reintento devuelve 200 sin volver a llamar a la IA.
3. Registra la solicitud con `status=RECEIVED`.
4. OpenRouter recibe la imagen y el brief. El prompt prohíbe inventar precios, resultados, testimonios, urgencia o características no autorizadas.
5. El parser exige `visualAnalysis` y exactamente dos elementos válidos en `drafts`.
6. El callback firmado actualiza el portal. El portal mueve el item de `GENERATING` a `DRAFT` y conserva el callback como `COPY_CALLBACK` idempotente.
7. Actualiza el log de `COPY_REQUEST` a `CALLBACK_SENT`.

Callback al portal: `POST ${SNAPGAD_PORTAL_URL}/api/integrations/n8n/copy-result`.

```json
{
  "contentItemId": "uuid-del-content-item",
  "idempotencyKey": "uuid-de-la-solicitud-copy",
  "visualAnalysis": {
    "scene": "descripcion factual",
    "visibleText": ["texto visible que se pudo leer"],
    "proof": ["prueba visual observada"],
    "risks": ["texto dudoso o ilegible"]
  },
  "drafts": [
    { "headline": "Alternativa 1", "body": "Copy factual...", "cta": "Escribe AGENDA" },
    { "headline": "Alternativa 2", "body": "Copy factual...", "cta": "Escribe AGENDA" }
  ],
  "warnings": [],
  "provider": "openrouter",
  "model": "modelo-real-usado"
}
```

La firma del callback usa el mismo algoritmo y los mismos headers. El `idempotencyKey` puede ser igual al de la solicitud porque el portal lo persiste por `kind`; no debe cambiarse al reintentar.

## Respuestas

- `202`: solicitud aceptada y callback enviado.
- `200`: reintento ya registrado; no se ejecuta OpenRouter otra vez.
- `400`: schema incompleto.
- `401`: firma ausente, vencida o inválida.
- `502`: OpenRouter no devolvió dos borradores válidos; se registra `ERROR`.

## Prueba segura

1. Importa el JSON y confirma que el workflow permanece inactivo.
2. Configura variables en un entorno de staging y una imagen final de Canva no sensible.
3. Genera el HMAC con el mismo `stableJson` del nodo de validación.
4. Lanza el webhook sin activar el workflow de producción.
5. Repite exactamente el mismo payload: la segunda ejecución debe contestar `duplicate: true` y no generar un segundo borrador.
6. Revisa `automation_runs`, el callback y el item en el portal antes de habilitar publicación.
