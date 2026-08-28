# Runbook: Autenticación OIDC, mTLS y Token Hashes

## Cuándo usar
Configurar, rotar y verificar identidades mTLS, OIDC y token-hashes para el gateway de Cauce V3 asegurando revocación atómica mediante directorio montado.

> **Importante**: `ops/container-aliases.json` y `ops/manifests/*.yaml` son estrictamente GENERADOS a partir de `ops/flota.json` (exportado desde PostgreSQL). La edición manual de estos archivos está estrictamente PROHIBIDA y bloqueada por el gate de validación (`ops/scripts/validate.sh`). Para el alta, baja o aprovisionamiento de credenciales de agentes, consultar [Runbook: Alta y Baja de Agente](file:///datos/workspaces/zeus/cauce-v3/ops/runbooks/alta-y-baja-de-agente.md) y utilizar `cauce <alias> aprovisionar` / `ops/scripts/regenerate-fleet.sh`.

## Pasos
1. Crear el directorio de identidades en el host y mover registros:
   ```sh
   # [no ejecutable en verificación]
   install -d -o root -g 1000 -m 0750 /etc/cauce-v3/secrets/identities
   install -d -o root -g root -m 0700 /var/backups/cauce-v3
   ```
2. Publicar o actualizar `mtls_identities.json` o `token_hashes.json` mediante rename atómico (para credenciales de agente, usar `cauce <alias> aprovisionar` siguiendo `ops/runbooks/alta-y-baja-de-agente.md`):
   - Archivos modo `0400` y propiedad `1000:1000`.
   - Formato mTLS: `{"version":1,"identities":[{"certificate_sha256":"<64-hex>","expires_at":"...","principal":{...}}]}`.
   - Formato tokens: `{"version":1,"identities":[{"token_sha256":"<64-hex>","expires_at":"...","principal":{...}}]}`.
3. Fijar `CAUCE_GATEWAY_IDENTITY_DIR=/etc/cauce-v3/secrets/identities` en `prod.env` y recrear gateway si se modifica la estructura del montaje:
   ```sh
   # [no ejecutable en verificación]
   docker compose -f deploy/compose.yaml up -d gateway
   ```

## Verificar efecto
1. Verificar que el directorio esté montado y coincidan inodo, tamaño y mtime:
   ```sh
   # [no ejecutable en verificación]
   docker inspect cauce-v3-prod-gateway-1 --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' | grep cauce-identities
   stat -c '%i %s %y' /etc/cauce-v3/secrets/identities/mtls_identities.json
   docker exec cauce-v3-prod-gateway-1 stat -c '%i %s %y' /run/cauce-identities/mtls_identities.json
   ```
2. Verificar conteo de identidades cargadas en el contenedor:
   ```sh
   # [no ejecutable en verificación]
   docker exec cauce-v3-prod-gateway-1 node -e 'console.log(JSON.parse(require("fs").readFileSync("/run/cauce-identities/mtls_identities.json","utf8")).identities.length)'
   ```
3. Probar rechazo con respuesta 401/403 ante certificados o tokens revocados.

## Deshacer
1. Restaurar la versión anterior del archivo de identidades mediante rename atómico dentro del directorio montado:
   ```sh
   # [no ejecutable en verificación]
   mv /var/backups/cauce-v3/mtls_identities.json.bak /etc/cauce-v3/secrets/identities/mtls_identities.json
   ```
2. Confirmar que el gateway relee el inodo y restablece la autenticación esperada.
