# Orbit OS by SnapGad — runbook de piloto con Supabase

**Propósito:** verificar una sola campaña de SnapGad de punta a punta con
persistencia real y generación de copy supervisada. No activa publicación
automática en Facebook o Instagram.

## Límites que permanecen activos

- IA propone; una persona revisa y aprueba por destino.
- Meta permanece en entrega manual asistida. No establecer
  `SNAPGAD_PUBLISH_WORKER_ENABLED=true` durante este piloto.
- Los secretos viven exclusivamente en `.env.local` y en el proceso worker;
  nunca se pegan en un ticket, commit, consola compartida o variable `NEXT_PUBLIC_*`.
- Se usa una organización y un usuario de prueba primero. No se importan
  bibliotecas ni clientes existentes.

## 1. Preparar variables locales

Crear `.env.local` a partir de `.env.example` y completar únicamente las
variables necesarias para el piloto:

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SNAPGAD_ACTIVE_ORGANIZATION_COOKIE_SECRET=
SNAPGAD_WORKER_HEALTH_TOKEN=
SNAPGAD_COPY_WORKER_MODULE=./worker/providers/copy-processor.ts
OPENROUTER_API_KEY=
SNAPGAD_COPY_OPENROUTER_MODEL=
SNAPGAD_COPY_MODEL_INPUT_PRICE_PER_1M_USD=
SNAPGAD_COPY_MODEL_OUTPUT_PRICE_PER_1M_USD=
SNAPGAD_COPY_MAX_OUTPUT_TOKENS=700
SNAPGAD_COPY_MAX_REQUEST_COST_USD=0.05
SNAPGAD_PUBLISH_WORKER_ENABLED=false
```

La URL pública, la anon key y el service-role key se obtienen del panel de
Supabase; el service-role no entra al navegador. Seleccionar un modelo de
visión de OpenRouter con precios conocidos y colocar sus precios actuales por
millón de tokens antes de iniciar el worker.

## 2. Aplicar migraciones con un operador

La base remota tiene `0001`–`0013` verificados. Esta fase agrega `0014`,
`0015` y `0016`, en ese orden. El operador debe exportar temporalmente una URL de base
privada en su sesión local, revisar la lista y aplicar una sola vez:

```powershell
npx supabase@2.117.0 migration list --db-url $env:ORBIT_OS_DATABASE_URL
npx supabase@2.117.0 db push --db-url $env:ORBIT_OS_DATABASE_URL
npx supabase@2.117.0 migration list --db-url $env:ORBIT_OS_DATABASE_URL
```

**Gate:** el último listado debe incluir `0014_copy_hashtags_and_ai_usage`,
`0015_ai_usage_reservations` y `0016_manual_publication_delivery` en local y
remoto. Si hay divergencia, detenerse:
no editar ni repetir migraciones aplicadas.

Luego, en una sesión de operador revisada, establecer un tope inicial pequeño
para la organización de prueba, por ejemplo `$2.00 USD`, y confirmar que no
existan gastos ajenos en el mismo mes. El valor no se establece desde el
navegador en esta fase.

```sql
update public.organizations
set ai_monthly_budget_usd = 2.00
where id = '<organization-id-de-prueba>';
```

## 3. Smoke autenticado de persistencia

1. Crear un usuario Auth de prueba y su organización/membresía con rol
   `owner` mediante el runbook privilegiado existente.
2. Iniciar `npm run dev`, autenticar con ese usuario y seleccionar la
   organización activa.
3. Subir una creatividad PNG/JPEG/WEBP 4:5 menor a 20 MB con brief, hechos
   permitidos y destino HTTPS.
4. Confirmar que el objeto está dentro de `content-assets` y que el bucket no
   es público. Abrir el mismo registro con una segunda cuenta sin membresía:
   debe fallar.
5. Confirmar que el alta creó un job durable o, si la cola responde error, que
   el asset sigue visible en Borradores y el botón de reintento no duplica el
   job.

## 4. Smoke del worker y de costos

En otra terminal con el mismo `.env.local`:

```powershell
npm run worker
```

Verificar para un único job:

- Se reserva como máximo `SNAPGAD_COPY_MAX_REQUEST_COST_USD` antes del llamado.
- El worker recibe una URL firmada temporal, no un bucket público.
- Se generan exactamente dos alternativas con 5–8 hashtags válidos.
- La reserva se concilia a una fila de `ai_usage_events`.
- Un claim prohibido, un precio mayor a la reserva o un presupuesto agotado
  deja el item en `ERROR` sin volver a llamar al proveedor.
- Un timeout deja la reserva temporalmente retenida y el job entra en retry;
  no se debe relanzar manualmente hasta observar su estado durable.

## 5. Salida humana y resultado

Escoger/editar una alternativa, guardar el copy final y aprobar Facebook e
Instagram por separado. La primera entrega se realiza manualmente desde Meta.
Registrar URL final, fecha y nota de resultado en Orbit OS antes de
considerar OAuth/publicación como la siguiente fase.

## Evidencia de cierre

- Captura o query de `migration list` con `0001`–`0016` alineadas.
- Un asset privado asociado a una organización.
- Un job `COMPLETED` o un `ERROR` explicado, nunca un `GENERATING` huérfano.
- Una reserva `SETTLED` y un evento de uso para el job, con costo menor o
  igual a la reserva.
- Aprobación humana por destino y URL/resultado de la entrega manual.
