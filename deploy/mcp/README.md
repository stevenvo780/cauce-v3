# Puente MCP remoto

Este despliegue opt-in publica el MCP de solo lectura de `@cauce/mcp-fleet-monitor` en
`/mcp`. No modifica el Compose central ni abre puertos: el proceso usa host networking
y escucha exclusivamente en `127.0.0.1:3101`. La imagen usa Node fijado por digest y
solo instala las dependencias de producción del paquete y sus dependencias workspace.

## Requisitos antes de activarlo

- Un origen HTTPS público ya servido por Caddy y una ruta privada desde este host al gateway.
- Un tenant aprobado para visibilidad y una identidad gateway dedicada con permiso `read`
  limitado a ese ámbito. No reutilizar certificados de consola u operador.
- Un proveedor OAuth externo aprobado, con cliente registrado y authorization code + PKCE
  S256. Debe admitir el registro que ofrezca ChatGPT (CIMD/DCR) o un cliente predefinido
  cuyo redirect URI sea el callback exacto presentado por ChatGPT. El flujo debe propagar
  el indicador `resource` anunciado por el MCP hasta el proveedor y emitir access tokens JWT
  `typ: at+jwt`, RS256 o ES256, con audiencia exacta `<origen-publico>/mcp`, scope
  `cauce.read` y el `sub` configurado.
- CA, certificado y clave mTLS dedicados, legibles por uid 1000 y montados en solo lectura.
  Este Compose exige el directorio mTLS dedicado y no usa una credencial estática para ChatGPT.

El MCP valida OAuth; **no es un emisor**. Los valores `CAUCE_OIDC_*` del gateway son su
cliente del proveedor para el BFF de consola, no convierten al gateway en proveedor OAuth
del MCP. El mismo proveedor externo solo sirve si satisface todos los claims y el registro
anteriores. En esta Compose el modo queda fijado en `oauth` y se usa mTLS al gateway; no
configurar `CAUCE_GATEWAY_BEARER_TOKEN`, `CAUCE_MCP_ACCESS_TOKEN` ni el modo `static`. El
secreto del cliente OAuth vive en el proveedor/registro de ChatGPT, no en el contenedor; no
pasar credenciales por variables de entorno, porque `docker inspect` puede mostrarlas.
Revisar también `offline_access` si se necesita renovar la autorización sin volver a iniciar
sesión, conforme a la [guía oficial de apps MCP de ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

## Preparar imagen y configuración

Construir desde un archivo Git del commit público revisado que incluya estos ficheros;
no usar el workspace compartido como contexto porque puede contener material ignorado.
El archivo solo incluye rutas versionadas. Fijar el digest resultante en `CAUCE_MCP_IMAGE`;
Compose exige una referencia, y el operador debe verificar que sea `@sha256:<64 hex>` antes
de activar (Compose no impone ese formato):

```sh
git archive --format=tar <commit-publico-revisado> | docker build --file deploy/mcp/Dockerfile \
  --build-arg CAUCE_RELEASE_COMMIT=<revision-completa> \
  --build-arg CAUCE_SOURCE_DIGEST=sha256:<digest-de-fuente> \
  --tag <registro>/cauce-v3-mcp-gateway:<release> -
```

Calcular `CAUCE_SOURCE_DIGEST` con `ops/scripts/source-digest.py --domain runtime` sobre
ese mismo archivo extraído; `runtime` cubre todo `deploy/` y `packages/`, incluido el
Dockerfile, healthcheck y código MCP. Ambos argumentos son obligatorios: el build rechaza
valores ausentes o con formato distinto antes de etiquetar la imagen.

Copiar `env.example` a un archivo privado fuera del repo con modo `0600`; completar sus
valores usando el gestor autorizado. Los marcadores del ejemplo son inválidos y hacen
fallar el arranque. `CAUCE_MCP_ENV_FILE` señala ese archivo y `CAUCE_MCP_TLS_DIR` una
carpeta que contiene únicamente la identidad mTLS dedicada. La clave debe ser legible por
uid 1000 y la carpeta solo debe permitir acceso al proceso autorizado. No poner secretos
en Compose, argumentos, Caddy ni registros.

Insertar las líneas de `Caddyfile.snippet` dentro del `route {}` del sitio HTTPS existente
`consola.humanizar.tech`, después de la regla que devuelve 404 para el bus privado y antes
del `reverse_proxy` de fallback SPA. El origen público correspondiente es
`https://consola.humanizar.tech`. Las dos rutas son exactas; el proxy conserva `Host`,
`Authorization` y `Origin` por defecto. No registrar cuerpos ni cabeceras de autorización.
`CAUCE_MCP_PUBLIC_ORIGIN` es el origen exacto del sitio, sin ruta.

## Activación y comprobación

Primero validar la configuración y que Caddy acepte la inclusión. La imagen comprueba cada
15 segundos, con timeout de 3 segundos, que la metadata responda por loopback como JSON,
anuncie exactamente el recurso HTTPS `/mcp` y el issuer OAuth configurado. No obtiene ni
valida tokens ni consulta el gateway. Luego, con imagen por digest, archivo privado completo
y mTLS instalado:

```sh
CAUCE_MCP_IMAGE=<registro>/cauce-v3-mcp-gateway@sha256:<digest> \
CAUCE_MCP_ENV_FILE=/etc/cauce-v3/mcp-gateway.env \
CAUCE_MCP_TLS_DIR=/etc/cauce-v3/mcp-gateway/tls \
docker compose -f deploy/mcp/compose.yaml up -d --wait
```

Comprobar metadata OAuth, desafío 401, handshake MCP autenticado, `tools/list` y lecturas
inocuas desde el cliente final; validar que un sujeto no autorizado y otro tenant no reciben
datos. Un 200 HTML de la SPA no es respuesta MCP. Las pruebas del paquete usan OAuth/JWKS
efímeros y no prueban el proveedor real ni la conexión ChatGPT.

Para desactivar, detener únicamente este Compose (`docker compose -f deploy/mcp/compose.yaml
down`), retirar la ruta Caddy dedicada y revocar la identidad gateway/OAuth si deja de usarse.
No ejecutar un `down` desde el Compose central.
