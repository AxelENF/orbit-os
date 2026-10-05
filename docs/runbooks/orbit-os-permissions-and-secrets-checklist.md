# Checklist de permisos y secretos: Orbit OS

## Ahora: preparación sin efectos externos

- [x] Acceso de lectura/escritura al repositorio local.
- [x] Acceso MCP autenticado a Supabase para inspección y diagnósticos.
- [x] Migración consolidada aplicada desde el remoto `0017` como `20261005124203`.
- [x] Pruebas estáticas de migración y regresión enfocada.
- [x] Aprobación P2 de Axel y DDL remoto aplicado el 2026-10-05.

## Antes de levantar el piloto

- [ ] `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` configuradas en el entorno de la app.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` solo en servidor; nunca en navegador, logs, Git o formularios.
- [ ] `OPENROUTER_API_KEY` por organización configurada mediante el flujo BYOK; nunca compartida entre clientes.
- [ ] URL pública del portal configurada para callbacks de OAuth.
- [ ] Una organización de prueba y un usuario propietario creados.

## Solo cuando se habilite Meta Publishing

- [ ] App Meta en modo adecuado para el piloto y redirect URI exacta.
- [ ] `META_APP_ID`, `META_APP_SECRET` y URL de callback configurados exclusivamente como secretos de servidor.
- [ ] Página y cuenta Instagram de prueba seleccionadas por un owner.
- [ ] Token temporal y token de página comprobados mediante Vault; no se almacenan en texto plano.
- [ ] La primera publicación se revisa manualmente y se hace sin pauta.

## Lo que Codex necesita que confirmes mañana

1. Qué entorno será el piloto: dominio de producción o URL local/túnel controlado.
2. Las variables de runtime del portal configuradas fuera de Git.
3. Una organización y un usuario propietario de SnapGad para el primer smoke test.

Con esas tres condiciones, el esquema ya está aplicado y el resto son pruebas funcionales reversibles de la aplicación.
