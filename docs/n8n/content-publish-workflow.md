# SnapGad Content Engine V1 — publish job

El archivo `n8n/SnapGad-Content-Engine-V1.json` contiene una ruta `POST /webhook/snapgad/content/publish`. Facebook e Instagram son ramas y solicitudes independientes. No existe un crosspost implícito: cada target tiene su propio `publicationTargetId`, estado, ejecución e ID remoto.

## Variables de n8n

```text
META_GRAPH_VERSION=23.0
META_PAGE_ID=ID_DE_LA_PAGINA
META_PAGE_ACCESS_TOKEN=token_de_pagina_de_larga_duracion
META_IG_USER_ID=ID_DE_INSTAGRAM_PROFESIONAL
```

En el portal, configura `SNAPGAD_N8N_PUBLISH_URL` con la URL del webhook de publicación. El portal firma cada solicitud con `SNAPGAD_N8N_SHARED_SECRET`; ambos valores deben coincidir con la configuración de n8n.

El token se manda en el header `Authorization: Bearer ...`; no se incluye en URLs ni en este export. El asset debe estar disponible públicamente para Meta. Una URL privada o un signed URL vencido hará fallar la publicación.

## Aprobación y payload

La aprobación ocurre en el portal. n8n rechaza todo request cuyo `approvalState` no sea exactamente `APPROVED`, aunque el request tenga firma válida. Se requiere una nueva clave UUID para cada target; no reutilices la clave de Facebook para Instagram.

```json
{
  "contentItemId": "uuid-del-content-item",
  "publicationTargetId": "uuid-target-facebook-o-instagram",
  "ownerId": "uuid-del-owner",
  "platform": "FACEBOOK",
  "assetUrl": "https://cdn.example.com/final-canva-asset.png",
  "idempotencyKey": "uuid-unico-para-este-target",
  "approvalState": "APPROVED",
  "approvedAt": "2026-09-02T18:00:00.000Z",
  "approvedBy": "uuid-o-identificador-del-owner",
  "copy": {
    "headline": "Tu WhatsApp no se queda en visto",
    "body": "Atiende preguntas y recibe solicitudes de cita aunque estés ocupado.",
    "cta": "Escribe AGENDA por WhatsApp"
  }
}
```

La firma de entrada es HMAC-SHA256 de `timestamp + "." + stableJson(body)` con los mismos headers descritos en el flujo de copy. El timestamp tiene una ventana de cinco minutos.

## Secuencia Facebook

1. Verifica firma, aprobación, URL, plataforma y copy.
2. Consulta `automation_runs` por `PUBLISH_REQUEST` y `idempotencyKey`; los reintentos no vuelven a publicar.
3. Registra la solicitud.
4. `POST /{META_PAGE_ID}/photos` con `url`, `caption` y `published=true`.
5. Normaliza el ID devuelto y manda callback firmado al portal.
6. Actualiza el log con `CALLBACK_SENT` o `ERROR`.

## Secuencia Instagram

1. Verifica los mismos campos, pero con `platform=INSTAGRAM`.
2. `POST /{META_IG_USER_ID}/media` para crear un contenedor con `image_url` y `caption`.
3. `POST /{META_IG_USER_ID}/media_publish` con el `creation_id` devuelto.
4. Manda callback firmado al portal y registra el resultado de este target únicamente.

El workflow usa el mismo token de página para las llamadas Graph. Meta debe tener vinculada la cuenta de Instagram profesional y la app debe contar con los permisos necesarios. Esto debe probarse con una cuenta/destino de staging antes de activar producción.

## Callback de publicación

`POST ${SNAPGAD_PORTAL_URL}/api/integrations/n8n/publish-result`:

Éxito:

```json
{
  "contentItemId": "uuid-del-content-item",
  "publicationTargetId": "uuid-target",
  "platform": "FACEBOOK",
  "idempotencyKey": "uuid-unico-para-este-target",
  "remotePostId": "id-devuelto-por-meta",
  "remoteUrl": "https://www.facebook.com/id-devuelto-por-meta",
  "publishedAt": "2026-09-02T18:02:00.000Z"
}
```

Error sanitizado:

```json
{
  "contentItemId": "uuid-del-content-item",
  "publicationTargetId": "uuid-target",
  "platform": "INSTAGRAM",
  "idempotencyKey": "uuid-unico-para-este-target",
  "error": {
    "code": "META_INSTAGRAM_ERROR",
    "message": "Descripcion corta sin token ni payload sensible"
  }
}
```

El portal debe persistir el callback como `PUBLISH_CALLBACK`, actualizar solo el target indicado y dejar el otro target pendiente. No se debe marcar el item global como publicado porque la otra plataforma puede seguir pendiente.

## Respuestas y prueba

- `202`: Meta respondió y callback fue enviado; el portal tiene el ID remoto.
- `200`: idempotencia; no se repite la publicación.
- `400`: payload o plataforma inválida.
- `401`: firma inválida o vencida.
- `409`: el target no está aprobado.
- `502`: Meta falló; el portal recibe un error sanitizado.

Antes de activar:

1. Importa y deja `active=false`.
2. Usa un target aprobado de staging y un asset 4:5 accesible para Meta.
3. Prueba Facebook de forma aislada y valida el ID en portal/historial.
4. Repite el mismo request y confirma que no aparece un segundo post.
5. Prueba Instagram por separado; una falla de Instagram no debe cambiar el estado de Facebook.
6. Solo después de esta evidencia considera activar el workflow y el calendario.
