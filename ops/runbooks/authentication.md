# Runbook: autenticación productiva OIDC, mTLS y piloto por hash

## Invariantes

- `NODE_ENV=production` rechaza dev headers y exige TLS cert/key del gateway.
- Elegir un solo `CAUCE_AUTH_PROVIDER=oidc|mtls|token-file`.
- No colocar tokens, private keys, cookies ni Authorization en env versionado, logs o config JSON.
- Los identity files contienen solo digests SHA-256, principals y expiración; se rotan por rename atómico.
- **El montaje es parte de la garantía de revocación**: `mtls_identities.json` y `token_hashes.json` se
  publican montando read-only el **directorio** que los contiene (`CAUCE_GATEWAY_IDENTITY_DIR` →
  `/run/cauce-identities`), nunca como archivo suelto. Ver "Montaje de los registros".

## Montaje de los registros (requisito de revocación)

Los dos registros que el gateway relee en cada request —`CAUCE_MTLS_IDENTITY_FILE` y
`CAUCE_TOKEN_HASH_FILE`— **no** son secrets de Compose. Un secret de Compose fuera de swarm es un bind
mount de archivo único, y un bind de archivo queda pinneado al **inodo** con el que se creó. El rename
atómico que usamos para rotar publica un inodo nuevo: con un bind de archivo el contenedor sigue
sirviendo el registro previo a la rotación **indefinidamente**, hasta recrear el contenedor.

Consecuencia: montados como archivo suelto, ni un alta ni **una revocación** llegan al gateway, aunque
el host muestre el archivo ya rotado. Es un fallo silencioso: no hay error, no hay log; el gateway
simplemente autentica contra un registro viejo. Incidente real 2026-07-25 en `cauce-v3-prod-gateway-1`
(host inodo 794971 / 6501 B / 15 identidades vs. contenedor inodo 846839 / 5647 B / 13 identidades;
`mTLS certificate is not provisioned`, que el SDK enmascara como `FRAME_BEFORE_HELLO`).

Por eso `deploy/compose.yaml` monta el **directorio**: cada lectura vuelve a resolver el nombre dentro
del directorio del host y ve el inodo actual. Reglas del directorio:

- Contiene **solo** `mtls_identities.json` y `token_hashes.json`. Todo lo que esté adentro queda
  legible para el gateway.
- **No** apuntar `CAUCE_GATEWAY_IDENTITY_DIR` a `/etc/cauce-v3/secrets/`: eso le daría al gateway el
  módulo provider del relay, la password de PostgreSQL y cualquier secreto futuro del directorio.
  Usar un subdirectorio dedicado, p. ej. `/etc/cauce-v3/secrets/identities/`.
- Los backups de rotación (`*.pre-<cambio>`) van **fuera** del directorio montado.
- Permisos del host: directorio `root:1000` `0750` (root rota, el runtime —que corre como `1000:1000`—
  sólo lee) y archivos `uid 1000` `0400`. Compose fuera de swarm ignora `uid`/`gid`/`mode` de los
  secrets, así que los permisos efectivos son siempre los del host.
- Con `CAUCE_AUTH_PROVIDER=oidc` igual hay que apuntar la variable a un directorio existente (puede
  estar vacío); el bind es incondicional y falla cerrado si el path no existe.

Migración desde el montaje viejo de archivo suelto (una vez por host, requiere recrear el gateway):

```sh
install -d -o root -g 1000 -m 0750 /etc/cauce-v3/secrets/identities   # root rota, uid 1000 sólo lee
install -d -o root -g root -m 0700 /var/backups/cauce-v3
mv /etc/cauce-v3/secrets/mtls_identities.json /etc/cauce-v3/secrets/token_hashes.json /etc/cauce-v3/secrets/identities/
mv /etc/cauce-v3/secrets/mtls_identities.json.pre-* /var/backups/cauce-v3/   # backups fuera del mount
# en /etc/cauce-v3/prod.env: borrar CAUCE_GATEWAY_MTLS_IDENTITIES_PATH y CAUCE_GATEWAY_TOKEN_HASHES_PATH,
# agregar CAUCE_GATEWAY_IDENTITY_DIR=/etc/cauce-v3/secrets/identities
docker compose -f /opt/cauce-v3/deploy/compose.yaml up -d gateway
```

Recrear el gateway es obligatorio: cambiar un mount no se aplica a un contenedor vivo. A partir de
ahí las rotaciones ya no necesitan recrearlo.

Verificación del montaje (sin imprimir contenido), después de cada rotación y de cada `up -d`:

```sh
docker inspect cauce-v3-prod-gateway-1 --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' | grep cauce-identities
stat -c '%i %s %y' /etc/cauce-v3/secrets/identities/mtls_identities.json
docker exec cauce-v3-prod-gateway-1 stat -c '%i %s %y' /run/cauce-identities/mtls_identities.json
docker exec cauce-v3-prod-gateway-1 node -e 'console.log(JSON.parse(require("fs").readFileSync("/run/cauce-identities/mtls_identities.json","utf8")).identities.length)'
```

El destino debe ser el directorio `/run/cauce-identities` (no un archivo bajo `/run/secrets/`), y el
inodo, tamaño, mtime y conteo del contenedor deben coincidir con los del host. Si difieren, el montaje
volvió a ser de archivo suelto y **las revocaciones no están surtiendo efecto**.

## OIDC

Configurar paths/URLs no secretos `CAUCE_OIDC_ISSUER`, `CAUCE_OIDC_AUDIENCE` y `CAUCE_OIDC_JWKS_URL=https://...`. El provider limita algoritmos, valida firma, issuer, audience, `exp/nbf` y claims de tenant/alias/session/channel/roles/permissions. JWKS no disponible falla cerrado.

## mTLS

Montar cert/key servidor y CA cliente como secrets; `CAUCE_MTLS_IDENTITY_FILE` apunta dentro del directorio montado (`/run/cauce-identities/mtls_identities.json`). El listener exige certificado verificado por Node TLS; headers forwarded de certificados se ignoran. Formato del mapa (solo fingerprints):

```json
{"version":1,"identities":[{"certificate_sha256":"<64-hex>","expires_at":"2030-01-01T00:00:00Z","principal":{"tenant_id":"Steven","alias":"kant","session_id":"mtls-kant","channel":"adapter","roles":["operator"],"permissions":["route","read","control"]}}]}
```

## Piloto token-file

`CAUCE_TOKEN_HASH_FILE` apunta dentro del directorio montado (`/run/cauce-identities/token_hashes.json`); jamás el token. Calcular el hash fuera del repo/host de CI y guardar solo `<64-hex>`. Browser usa cookie emitida por el autenticador `__Host-cauce_session; Secure; HttpOnly; SameSite=Strict; Path=/`. Un wrapper de adapter productivo puede presentar Bearer solo si su transporte lo implementa y se prueba auténticamente; los protocol doubles y el CLI bundled no acreditan esa capacidad. Presentar cookie y Bearer a la vez se rechaza.

```json
{"version":1,"identities":[{"token_sha256":"<64-hex>","expires_at":"2030-01-01T00:00:00Z","principal":{"tenant_id":"Steven","alias":"kant","session_id":"pilot-kant","channel":"console","roles":["operator"],"permissions":["route","read","control"]}}]}
```

Cada request **vuelve a resolver el path y releer el archivo**: ausencia, JSON inválido, hash
duplicado, expiración o principal inválido falla cerrado. Eso alcanza para que la revocación surta
efecto **solo si el registro se alcanza por el directorio montado** (ver "Montaje de los registros");
con un bind de archivo suelto la relectura devuelve siempre el inodo pinneado y la revocación no
llega. Para revocar: reemplazar el archivo por rename atómico, comprobar que inodo/tamaño/mtime del
contenedor igualan a los del host, y recién entonces verificar 401 con un token de prueba; no imprimir
el valor. Alta y revocación comparten esta condición: si una no se propaga, la otra tampoco.

## Gate

Verificar HTTPS, WSS de adapters, client cert/CA o Bearer auténtico, cookie attributes, Origin/same-origin CSRF, 401 negativos, principal sin spoof headers y rotación. Los manifests contienen nombres `*_PATH`, nunca valores. No aprobar producción con `sslmode=require` ni con health HTTP expuesto.

La rotación **no** se da por verificada mirando el host: hay que evidenciar que el contenedor ve el
registro actual (inodo/tamaño/mtime/conteo iguales) y que una identidad retirada da 401. El guardarraíl
en repo es `tests/gateway-hardening/identity-rotation.test.ts` (rename atómico observado por el
provider + el gateway sin registros por-request bajo `/run/secrets/`) y la aserción de política
homónima de `ops/scripts/validate.sh`.

### Alcance: qué otros secretos tienen el mismo defecto

Sólo estos dos registros se releen en caliente, así que sólo ellos necesitan el bind de directorio.
El resto de los secretos del gateway se leen **una vez al arrancar** (`database_url` en el entrypoint;
`gateway_tls_cert|key|ca`, `gateway_client_ca` al construir el listener; `gateway_oidc_session_key` y
`gateway_oidc_client_secret` al construir el provider; `relay_provider_module` en el import del relay
worker), y `postgres_ca` sólo se relee al abrir conexiones nuevas. Todos ellos ya exigen recrear el
contenedor para rotar, con lo cual el pinning de inodo no cambia nada y siguen como secrets de archivo
único —que además es la superficie mínima—. El bridge de Telegram ya montaba su directorio
(`/run/cauce-telegram`), así que no estaba afectado. Si en el futuro un secreto pasa a releerse por
request, tiene que mudarse al directorio montado o a uno propio con el mismo criterio.
