# Runbook: canal PTY de la consola (`terminal-relay`)

## Qué es y qué no es

La consola absorbe las terminales. El transporte de bytes es un servicio nuevo,
`terminal-relay`; el gateway sólo autoriza (ticket), decide (grants) y audita.
El PTY **no** viaja por el bus: no toca `deliveries`, `adapter_outbox` ni el
dispatcher. Cortar el PTY nunca corta mensajes, y cortar el bus nunca corta el
PTY salvo por la autorización.

La frontera de hosts es real y hay que decirla en voz alta:

- El core (gateway, dispatcher, consola, postgres, telegram-bridge) corre en
  **`agora-storage`**. Ahí corre también `terminal-relay`, hermano del gateway
  en la red `edge`.
- Los contenedores de los agentes (`claw`, `ctrl-infra`, `ws-prizma`, …) corren
  en **`kratos`**, bajo units systemd de usuario del usuario `stev`.
- Por lo tanto **toda terminal cruza agora→kratos**. La pata que cruza es
  agente→relay, no relay→agente: el agente PTY de kratos disca hacia la pierna
  de agentes del relay, `8445`, publicada en la IP privada del tailnet
  (`CAUCE_PRIVATE_BIND_IP`), con mTLS contra la CA interna. Así kratos no
  necesita puertos entrantes nuevos y agora no necesita alcanzar contenedores
  ajenos.

Piernas del relay:

| Pierna | Puerto | Publicada al host | Quién entra | Cómo se autentica |
|---|---|---|---|---|
| navegador | 8446 | **no** | sólo el nginx de la consola por la red `edge` | mTLS: cert de cliente `console_gateway_client_cert`, CN exigido en `CAUCE_TERMINAL_RELAY_CONSOLE_CN` |
| agentes | 8445 | sí, `${CAUCE_PRIVATE_BIND_IP}:8445` | agentes PTY en kratos, por el tailnet | mTLS contra `gateway_client_ca` + registro `pty_agent_identities.json` |

El nginx de la consola rutea `/v3/console/terminal/ws` al relay con un `location`
de **match exacto**, que gana sobre el prefijo `/v3/`. Todo el resto de
`/v3/console/terminal/*` (capability, targets, sessions) sigue yendo al gateway.
El upstream del relay se resuelve por variable contra el DNS embebido de Docker
a propósito: con el nombre estático, un `docker stop` del relay haría que el
nginx **no arranque** en su próximo reinicio y se llevaría puesta la consola
entera. Con resolver, un relay caído es un 502 en esa ruta y nada más.

## 1. Aprovisionamiento

Todo vive fuera del repo, en `agora-storage`, con dueño `1000:1000` (el usuario
del runtime). Nunca imprimir el contenido de estos archivos: para verificar,
usar longitud (`wc -c`) y hash truncado (`sha256sum | cut -c1-12`).

| Variable del env privado | Ruta sugerida en el host | Dueño/modo | Se monta como |
|---|---|---|---|
| `CAUCE_TERMINAL_TICKET_KEY_PATH` | `/etc/cauce-v3/secrets/terminal-ticket.key` | `1000:1000` `0400` | secret `terminal_ticket_key` (gateway) |
| `CAUCE_TERMINAL_RELAY_TOKEN_PATH` | `/etc/cauce-v3/secrets/terminal-relay.token` | `1000:1000` `0400` | secret `terminal_relay_token` (gateway **y** relay) |
| `CAUCE_TERMINAL_RELAY_TLS_CERT_PATH` | `/etc/cauce-v3/secrets/terminal-relay.crt` | `1000:1000` `0444` | secret `terminal_relay_tls_cert` (relay) |
| `CAUCE_TERMINAL_RELAY_TLS_KEY_PATH` | `/etc/cauce-v3/secrets/terminal-relay.key` | `1000:1000` `0400` | secret `terminal_relay_tls_key` (relay) |
| `CAUCE_TERMINAL_CONFIG_DIR` | `/etc/cauce-v3/terminal/` | `1000:1000` `0750` | bind read-only `/run/cauce-terminal` (gateway **y** relay) |

Sin aprovisionar, cada secret y el bind del directorio apuntan a `/dev/null` y
el stack sigue levantando: el gateway arranca igual (verificado: bindear
`/dev/null` sobre `/run/cauce-terminal` deja ahí un char device y el contenedor
levanta), queda con `CAUCE_TERMINAL_ENABLED=0`, y el relay falla cerrado por
falta de certificado. Esa es la posición de reposo. Aun así, en producción
conviene apuntar `CAUCE_TERMINAL_CONFIG_DIR` a un directorio real vacío desde el
primer deploy: es gratis y evita que el día del encendido haya que recrear el
gateway sólo para cambiar un bind.

### 1.1 Clave maestra de tickets (32 bytes)

```sh
umask 077
openssl rand -out /etc/cauce-v3/secrets/terminal-ticket.key 32
chown 1000:1000 /etc/cauce-v3/secrets/terminal-ticket.key
chmod 0400 /etc/cauce-v3/secrets/terminal-ticket.key
wc -c < /etc/cauce-v3/secrets/terminal-ticket.key   # debe decir 32
```

Es la clave con la que el gateway firma el ticket de un solo uso. Rotarla
invalida todos los tickets vivos y exige reiniciar el gateway, así que se rota
en la misma ventana que un reinicio ya anunciado, nunca sola.

### 1.2 Certificado del relay

CN `terminal-relay`, con SAN `DNS:terminal-relay`, firmado por **la misma CA
interna que firmó el certificado del gateway** (`CAUCE_GATEWAY_TLS_CA_PATH`).
No es opcional: el nginx de la consola hace `proxy_ssl_verify on` contra
`/run/secrets/gateway_tls_ca`; con otra CA la consola devuelve 502 y no hay
manera de "acomodarlo" bajando la verificación.

```sh
umask 077
openssl req -new -newkey rsa:4096 -nodes \
  -keyout /etc/cauce-v3/secrets/terminal-relay.key \
  -out /tmp/terminal-relay.csr -subj "/CN=terminal-relay"
printf 'subjectAltName=DNS:terminal-relay\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > /tmp/terminal-relay.ext
openssl x509 -req -in /tmp/terminal-relay.csr -days 397 \
  -CA "$CAUCE_INTERNAL_CA_CERT" -CAkey "$CAUCE_INTERNAL_CA_KEY" -CAcreateserial \
  -extfile /tmp/terminal-relay.ext -out /etc/cauce-v3/secrets/terminal-relay.crt
rm -f /tmp/terminal-relay.csr /tmp/terminal-relay.ext
chown 1000:1000 /etc/cauce-v3/secrets/terminal-relay.crt /etc/cauce-v3/secrets/terminal-relay.key
chmod 0444 /etc/cauce-v3/secrets/terminal-relay.crt
chmod 0400 /etc/cauce-v3/secrets/terminal-relay.key
openssl x509 -in /etc/cauce-v3/secrets/terminal-relay.crt -noout -subject -ext subjectAltName
```

La consola presenta su `console_gateway_client_cert` y el relay lo valida contra
`gateway_client_ca` exigiendo el CN de `CAUCE_TERMINAL_RELAY_CONSOLE_CN`
(default `console`). Los agentes PTY presentan su propio cert contra la misma CA
y además tienen que figurar en `pty_agent_identities.json`.

### 1.3 Token compartido relay→gateway

```sh
umask 077
openssl rand -hex 32 | tr -d '\n' > /etc/cauce-v3/secrets/terminal-relay.token
chown 1000:1000 /etc/cauce-v3/secrets/terminal-relay.token
chmod 0400 /etc/cauce-v3/secrets/terminal-relay.token
```

El mismo archivo se monta en el gateway y en el relay (`terminal_relay_token`).
Es lo que le permite al relay preguntar "¿este ticket sigue autorizado?" cada
`CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS` sin ser un cliente anónimo.

### 1.4 Directorio de configuración caliente

```sh
install -d -o 1000 -g 1000 -m 0750 /etc/cauce-v3/terminal
umask 027
printf '{"version":1,"grants":[]}\n' > /etc/cauce-v3/terminal/grants.json
printf '{"version":1,"agents":[]}\n' > /etc/cauce-v3/terminal/pty_agent_identities.json
chown 1000:1000 /etc/cauce-v3/terminal/*.json
chmod 0440 /etc/cauce-v3/terminal/*.json
```

Arranca **vacío**: sin filas en `grants.json` nadie puede abrir una terminal, y
esa es la posición segura desde la que se enciende todo.

**Rotar SIEMPRE por rename atómico.** Nunca redirigir (`>`) ni editar en el
lugar sobre estos archivos: un lector puede ver el archivo truncado a la mitad
y quedarse con una lista de permisos incompleta o vacía por accidente.

```sh
umask 027
tmp=$(mktemp /etc/cauce-v3/terminal/.grants.json.XXXXXX)   # mismo filesystem
cat > "$tmp" <<'JSON'
{"version":1,"grants":[{"operator":"<correo de console_users>","tenant_id":"Steven","alias":"jarvis","modes":["shell","harness"]}]}
JSON
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json                # rename atómico
docker exec cauce-v3-prod-gateway-1 node -e 'const g=JSON.parse(require("fs").readFileSync("/run/cauce-terminal/grants.json","utf8"));console.log(g.version, g.grants.length)'
```

Los cuatro campos son exactamente los que exige `parseGrants`
(`services/gateway/src/terminal/authority.ts:110-115`): `operator`, `tenant_id` y `alias` no
vacíos, y `modes` como **array de cadenas**. Escribir `tenant` o `mode` en singular levanta
`grant fields are invalid`, y `rw` ni siquiera es un modo: los únicos son `shell`, `harness` y
`harness_rw` (`services/gateway/src/terminal/types.ts:7`). Con el login por contraseña el
`operator_id` es el **correo** de `console_users` (`ops/runbooks/console-login.md:235`), así que
poner `steven` repite el fallo de atribución ya documentado ahí: la sesión es válida y todos los
destinos contestan `authorized:false`.

**El comodín `"*"` sólo abre lo que se mira, nunca lo que se teclea.** Sigue siendo el único
comodín y sólo en `operator`, pero ahora únicamente con `harness`, el modo de sólo lectura. Una
fila `"*"` que lleve `shell` o `harness_rw` levanta `wildcard operator cannot hold a writable
mode` y, como cualquier otro error de este fichero, deja el archivo ENTERO en `grants: []`: para
escribir dentro del contenedor la fila tiene que **nombrar** al operador.

**Un error tipográfico cierra la puerta a todos.** Cualquier excepción dentro de `parseGrants`
deja el archivo ENTERO en `grants: []` y se registra una sola vez por minuto
(`authority.ts:144-158`): no hay rechazo por fila ni lista parcialmente válida, y la consola sólo
muestra un `no_grant` genérico que no distingue "a este operador no le toca" de "el archivo no
parseó".

**Ese log no sirve como comprobación inmediata.** `GrantStore` lee el archivo de forma perezosa,
dentro de una request (`authority.ts:142-145`): nadie vigila la ruta ni la sondea, así que recién
renombrado el archivo `docker logs ... | grep 'terminal grants'` sale vacío tanto si el JSON es
bueno como si es basura. Por eso la comprobación pegada al rename es el `docker exec ... node -e`
de arriba, que lee el mismo inodo montado y revienta ruidosamente si el fichero no parsea. La
validación de campos de `parseGrants` sólo se ve **forzando una lectura**: recargar la barra de
flota en la consola y recién entonces
`docker logs --since 2m cauce-v3-prod-gateway-1 | grep 'terminal grants'`, que ya sí es concluyente
(sin salida = la lista nueva se aplicó).

Por eso `/run/cauce-terminal` se monta como **bind de DIRECTORIO y no como
secret de archivo**, con el mismo razonamiento que el bind de identidades: el
rename crea un inodo nuevo, y un bind de archivo deja al proceso leyendo el
inodo viejo para siempre. Montado el archivo, una revocación no llegaría jamás.
Montado el directorio, el gateway relee la ruta en cada request y ve la lista
nueva sin reiniciar nada.

## 2. Encendido, en el orden correcto

Precondiciones, todas verificadas antes de empezar:

- Imágenes publicadas y pinneadas por digest (`CAUCE_RUNTIME_IMAGE`,
  `CAUCE_CONSOLE_IMAGE` con `@sha256:`). Anotar el digest anterior: es el
  rollback.
- Ventana anunciada a la flota, compartida con la tarea #9, y **socrates ya
  terminó el despliegue de su cliente**.
- `grants.json` vacío y `CAUCE_TERMINAL_ENABLED=0` todavía.

### Paso 1 — migrator, relay y consola (no se toca el gateway)

```sh
export CAUCE_ENV_FILE=/etc/cauce-v3/prod.env
ops/scripts/compose.sh prod up -d --no-build migrator          # one-shot, sólo si el merge trae migraciones
ops/scripts/compose.sh prod up -d --no-build --no-deps terminal-relay
ops/scripts/compose.sh prod up -d --no-build --no-deps console
```

`--no-deps` es **obligatorio**. El archivo ya tiene la configuración nueva del
gateway (variables `CAUCE_TERMINAL_*`, secretos y bind); sin `--no-deps`,
Compose ve que el hash de configuración del gateway cambió y lo recrea. Eso
sería un reinicio no anunciado del gateway y ahí se rompen adaptadores.

Verificación de este paso:

```sh
docker ps --filter name=cauce-v3-prod-terminal-relay --format '{{.Names}} {{.Status}}'
docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Health.Status}}' cauce-v3-prod-console-1
curl -sk -o /dev/null -w '%{http_code}\n' https://100.64.0.6:8444/        # 200, la consola sigue entera
curl -sk -o /dev/null -w '%{http_code}\n' https://100.64.0.6:8444/v3/console/terminal/ws   # 400/426, no 502: el relay contesta
```

Un 502 acá significa relay caído o certificado firmado por otra CA. Un 501
significa que el gateway todavía no tiene el canal habilitado, que es lo
esperado hasta el paso 3.

### Paso 2 — agente PTY en kratos

Instalación por alias, según el runbook del agente. kratos usa fish, así que las
órdenes remotas van en base64:

```sh
ssh kratos "echo '<b64>' | base64 -d | bash -l"
```

El alta del agente escribe su identidad en `pty_agent_identities.json` con el
rename atómico de §1.4. No reinicia el gateway ni toca el bus. Al terminar, el
relay tiene que ver al agente conectado y la consola tiene que mostrar el alias
en "PTY online" con el resto en "agente PTY no instalado".

### Paso 3 — el ÚNICO reinicio del gateway

Anunciado, en la ventana compartida con la tarea #9, con socrates fuera de su
despliegue. Anotar la hora exacta.

```sh
# en el env privado: CAUCE_TERMINAL_ENABLED=1
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env ops/scripts/compose.sh prod up -d --no-build --wait gateway
```

**Riesgo, textual:** reiniciar el gateway mata adaptadores con trabajo en vuelo.
Hoy dejó a `argos` muerto en un bucle de `CONNECTION_ZODERROR` del que no se
recupera ni reiniciándolo. Por eso es un único reinicio, anunciado, y por eso
todo lo demás se hizo antes con `--no-deps`.

Verificación de que los 13 adaptadores vivos volvieron. La única señal fiable es
la cadencia de ACKs `started`; `systemd`, el lease y `auth status` mienten. SQL
siempre en solo lectura:

```sql
BEGIN READ ONLY;
-- 1. presencia declarada (necesaria, no suficiente)
SELECT tenant_id, alias, instance_id, epoch, last_heartbeat_at
  FROM connection_leases
 WHERE lease_until > now()
 ORDER BY tenant_id, alias;

-- 2. la señal que importa: ACK started reciente por alias
SELECT d.recipient_tenant, d.recipient_alias,
       count(*) AS acks_started,
       max(a.created_at) AS ultimo_ack
  FROM delivery_acks a
  JOIN deliveries d ON d.id = a.delivery_id
 WHERE a.status = 'started'
   AND a.created_at > now() - interval '15 minutes'
 GROUP BY 1, 2
 ORDER BY 1, 2;
COMMIT;
```

Criterio: 13 filas en la consulta 1 con `last_heartbeat_at` dentro de los
últimos 90 s, y ningún alias vivo sin ACK `started` en la ventana después de
recibir tráfico. `argos` se cuenta aparte: sigue muerto por su propio bug.

Rollback, por digest pinneado, sin tocar schema ni datos (ver
`el historial de git rollback.md`, histórico del último rollback aplicado):

```sh
CAUCE_PREVIOUS_RUNTIME_IMAGE=repo/cauce-runtime@sha256:<digest-anterior> \
CAUCE_ROLLBACK_CONFIRM=runtime-only:repo/cauce-runtime@sha256:<digest-anterior> \
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env python3 ops/scripts/pin-container-release.py rollback runtime
```

Para el canal PTY el rollback barato no es ese: es vaciar `grants.json`
(§3, kill switch 1), que no reinicia nada.

### Paso 4 — la primera fila en `grants.json`

Recién ahora se abre la puerta, y se abre para un alias:

```sh
umask 027
tmp=$(mktemp /etc/cauce-v3/terminal/.grants.json.XXXXXX)
cat > "$tmp" <<'JSON'
{"version":1,"grants":[{"operator":"<correo de console_users>","tenant_id":"Steven","alias":"jarvis","modes":["shell","harness"]}]}
JSON
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json
docker exec cauce-v3-prod-gateway-1 node -e 'const g=JSON.parse(require("fs").readFileSync("/run/cauce-terminal/grants.json","utf8"));console.log(g.version, g.grants.length)'
```

Los nombres de los campos y por qué el operador es un correo están en §1.4. Si ese `node -e`
falla, la fila no se aplicó y además quedaron revocados los grants que ya hubiera: corregir el
JSON y repetir el rename antes de seguir. El `grep 'terminal grants'` del log sólo dice algo
**después** de una lectura real (§1.4), así que va al final de la verificación de abajo, no acá.

Verificación de extremo a extremo, en la consola publicada
(https://consola.elenxos.com, detrás de Caddy con basic auth, que no se toca):
la barra de flota muestra el estado de PTY de los 15 alias, `jarvis` habilitado,
el diálogo exige motivo de 8 caracteres o más y nombra a los agentes que
comparten el contenedor destino (por ejemplo `ctrl-infra` es compartido por
`argos` y `kant`; el mapa vive en `ops/container-aliases.json`). Dentro de la
shell, `id -un` devuelve el usuario del contenedor (`claw` para `jarvis`,
nunca root) y `hostname` devuelve el contenedor esperado. En `/audit` tienen que
aparecer `terminal.session.request` (allow), `terminal.session.consume` y
`terminal.session.close` con alias, contenedor, digest de imagen, generación y
el motivo escrito a mano. Cargada esa barra, el gateway ya leyó `grants.json`: ahí
`docker logs --since 2m cauce-v3-prod-gateway-1 | grep 'terminal grants'` sin salida confirma que
la lista se aplicó, y con salida delata la errata que dejó a los 15 alias sin puerta.

## 3. Los tres kill switches

De más rápido a más lento. El primero es el que se usa; el tercero es el que
casi nunca se usa.

| # | Acción | Tiempo | Alcance | Qué NO toca |
|---|---|---|---|---|
| 1 | Vaciar `grants.json` por rename atómico | instantáneo | nadie puede pedir una terminal nueva; las sesiones abiertas se cortan solas | no reinicia nada, no ejecuta SQL, no toca el bus ni la consola |
| 2 | `docker stop cauce-v3-prod-terminal-relay-1` | ~1 s | mata todas las shells de golpe | no toca el bus: los adaptadores siguen entregando y la consola sigue entera, con el canal PTY marcado como no disponible |
| 3 | `CAUCE_TERMINAL_ENABLED=0` + reinicio del gateway | minutos | el gateway deja de emitir tickets y vuelve al 501 de hoy | reinicia el gateway, con todo el riesgo del paso 3 de §2 |

Kill switch 1:

```sh
umask 027
tmp=$(mktemp /etc/cauce-v3/terminal/.grants.json.XXXXXX)
printf '{"version":1,"grants":[]}\n' > "$tmp"
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json
```

Efecto esperado: pedidos nuevos rechazados en menos de un segundo (el gateway
relee el archivo en cada request) y las sesiones ya abiertas cortadas en menos
de 30 s con el mensaje "permiso revocado" y código de cierre `4403`, porque el
relay revalida cada `CAUCE_TERMINAL_AUTHZ_INTERVAL_SECONDS` (30 s) y falla
cerrado pasado `CAUCE_TERMINAL_AUTHZ_GRACE_SECONDS` (90 s) si el gateway no
contesta.

Kill switch 2:

```sh
docker stop cauce-v3-prod-terminal-relay-1
# verificar que el bus sigue: ACKs started nuevos con la consulta de §2
# volver: docker start cauce-v3-prod-terminal-relay-1
```

El relay está sólo en la red `edge` y no tiene `DATABASE_URL`: por construcción
no puede afectar a postgres ni al dispatcher. La consola sobrevive porque su
nginx resuelve el upstream del relay por variable; esa ruta devuelve 502 y el
resto de la consola no se entera.

Kill switch 3 sólo si hay que cortar la emisión de tickets de raíz (por ejemplo
una clave maestra comprometida). Se anuncia como cualquier reinicio del gateway
y se verifica igual que el paso 3 de §2.

## 4. Deuda con fecha: las dos puertas

Mientras la consola sirva terminales, los workers de **ultimate-terminal**
siguen corriendo en 9 de los 11 contenedores de la flota. Eso significa **dos
puertas a la misma shell con dos modelos de autorización distintos**, y revocar
en una **no** revoca en la otra: vaciar `grants.json` cierra la puerta de la
consola y deja abierta la de ultimate-terminal.

El retiro de esos workers es entregable de la fase siguiente, contenedor por
contenedor, en el mismo cambio en que la consola cubre ese contenedor: se apaga
el worker de ultimate-terminal del contenedor en el mismo despliegue en que su
alias pasa a "PTY online" en la consola. La fase no se da por cerrada mientras
quede un contenedor con las dos puertas abiertas.

## 5. Dev: probar el circuito completo antes de tocar producción

`deploy/compose.dev.yaml` publica las dos piernas del relay (8445 y 8446) en
`CAUCE_DEV_BIND_IP` y levanta el gateway con `CAUCE_TERMINAL_ENABLED=1`. Las dos piernas van con
TLS, no en claro: el relay construye siempre un listener HTTPS con `requestCert: true` y
`rejectUnauthorized: true` (`services/terminal-relay/src/browser-leg.ts:113-122`), y dev apunta
certificado, clave, CA de cliente y CA de agentes al mismo `relay.crt`/`relay.key`
(`deploy/compose.dev.yaml:123-126`) — dos archivos que el script de abajo **no** crea. Como el
stack de dev no tiene bloque `secrets:`, la clave de tickets y el token compartido viven en el
mismo directorio de trabajo:

```sh
install -d -m 0750 /ruta/privada/cauce-terminal-dev
umask 077
openssl rand -out /ruta/privada/cauce-terminal-dev/ticket.key 32
openssl rand -hex 32 | tr -d '\n' > /ruta/privada/cauce-terminal-dev/relay.token
printf '{"version":1,"grants":[]}\n' > /ruta/privada/cauce-terminal-dev/grants.json
printf '{"version":1,"agents":[]}\n' > /ruta/privada/cauce-terminal-dev/pty_agent_identities.json

CAUCE_TERMINAL_CONFIG_DIR=/ruta/privada/cauce-terminal-dev \
CAUCE_ENV_FILE=/ruta/privada/dev.env ops/scripts/compose.sh dev up --build -d --wait
```

El nginx de dev (`console/nginx.conf:15`) **no** tiene el mismo `location` que producción:
declara el literal viejo `location = /v3/console/terminal/ws` y hace `proxy_pass` en claro a
`http://terminal-relay:8446`, sin ninguna directiva `proxy_ssl_*`. Producción declara otro
literal, el de la identidad del relay
(`deploy/console/nginx-console-tls.conf:28`), con mTLS completo contra la CA interna. Dev no
acredita producción: la auth es de desarrollo y los grants son de juguete.

### 5.1 Pendiente abierto: hoy el circuito de dev no cierra

Esto es trabajo del workstream de consola/deploy; acá sólo queda anotado el orden real en que
falla, que no es el orden en que se descubre. Los cuatro puntos, en cascada:

1. **El stack de dev no arranca.** `deploy/compose.dev.yaml` no define
   `CAUCE_TERMINAL_RELAY_INSTANCE_ID` ni para el gateway (env en las líneas 57-68) ni para el
   relay (118-136), y los dos lo exigen: el gateway tira
   `CAUCE_TERMINAL_RELAY_INSTANCE_ID is required when the terminal plane is enabled`
   (`services/gateway/src/terminal/config.ts:66-73`, alcanzado porque dev trae
   `CAUCE_TERMINAL_ENABLED` en `1`) y el relay lo pide por `requiredEnv`
   (`services/terminal-relay/src/config.ts:84-90`). Esto precede a cualquier problema de PTY: sin
   resolverlo no hay nada que probar.
2. **La ruta que reparte el gateway no existe en el nginx de dev.** El grant devuelve
   `/v3/console/terminal/relays/<64hex>/ws`
   (`services/gateway/src/terminal/session-control.ts:60-63`), y dev sólo declara
   `location = /v3/console/terminal/ws` (`console/nginx.conf:15`). El upgrade del navegador cae
   entonces en `location /v3/` (`console/nginx.conf:36-40`), que va al gateway y **no** manda
   `Upgrade` ni `Connection`: el WebSocket no llega a nacer.
3. **El `Origin` es el primer rechazo de la capa de aplicación.** El handler de upgrade comprueba
   en este orden (`services/terminal-relay/src/browser-leg.ts:203-220`): ruta → `origin_mismatch`
   (`:210-211`) → `untrusted_client_certificate` (`:217-218`). Y `isSameOrigin` exige
   `protocol === 'https:'` (`:157-165`), así que un dev servido por HTTP cae ahí **antes** de que
   se mire ningún certificado.
4. **Con el proxy en claro el relay no registra nada.** El nginx de dev proxea
   `http://terminal-relay:8446` sin `proxy_ssl_certificate` contra un listener construido con
   `requestCert: true, rejectUnauthorized: true`
   (`services/terminal-relay/src/browser-leg.ts:113-122`): el handshake muere en el transporte y el
   evento `upgrade` no llega a dispararse, así que no se emite ni `origin_mismatch` ni
   `untrusted_client_certificate`. Lo que ve el operador es un 502 de nginx o un error de TLS, no
   un rechazo del relay — por eso este punto se descubre el último aunque falle el primero.

**El `location` de match exacto de producción no se convierte en prefijo.** El literal está
fijado por `tests/unit/terminal-relay-operability.test.ts:57-59`, y el match exacto es una
propiedad de cerco: la identidad de otro relay tiene que seguir siendo un 404 en el borde. Lo que
se arregla es dev, alineándolo con el literal de producción; no al revés.

## 6. Integración con el resto del árbol

Las cuatro piezas que hacían falta para que `terminal-relay` empaquetara y desplegara junto al
resto del runtime ya están cerradas:

- `pnpm-lock.yaml` incluye el workspace `services/terminal-relay`: la etapa `build` de la imagen
  (`pnpm install --frozen-lockfile`) no falla con `ERR_PNPM_OUTDATED_LOCKFILE`.
- `deploy/runtime/runtime-package-smoke.mjs` (se movió desde `deploy/runtime-package-smoke.mjs`)
  lista `terminal-relay` tanto en `runtimePackages` como en `runtimeModules`: el smoke que corre
  dentro de la imagen valida sus dependencias y que `dist/main.js` cargue.
- `ops/config/prod.env.example` ya trae las variables del plano (`CAUCE_TERMINAL_ENABLED`,
  `CAUCE_TERMINAL_WS_PATH`, `CAUCE_TERMINAL_OPERATORS`, `CAUCE_TERMINAL_CONSOLE_CN`,
  `CAUCE_TERMINAL_CONFIG_DIR`, `CAUCE_TERMINAL_TICKET_KEY_PATH`,
  `CAUCE_TERMINAL_RELAY_TOKEN_PATH`, `CAUCE_TERMINAL_RELAY_TLS_CERT_PATH`,
  `CAUCE_TERMINAL_RELAY_TLS_KEY_PATH`, `TERMINAL_RELAY_AGENT_PORT`).
- El relay declara `healthcheck` en `deploy/compose.yaml` sobre su puerto de salud
  (`CAUCE_TERMINAL_RELAY_HEALTH_PORT`), igual que el resto de los servicios del runtime.

### 6.1 Constantes que deberían salir de `vectors.json`, no re-declararse

`tests/terminal-pty/vectors.json` no es solo un fichero de pruebas: es el contrato del canal, y
lleva los bloques `geometry`, `limits`, `ttls`, `ws_close_codes` y `framing.tags`. Hoy ninguna pieza
de runtime lo lee; cada una re-declara los mismos números a mano, y cuando dos copias divergen el
síntoma no es un error de compilación sino una sesión que se cierra sin explicación.

Lo que debería importarse en vez de copiarse:

| Bloque | Qué fija |
|---|---|
| `geometry` | cotas de `cols`/`rows` (20–500 × 5–200) |
| `limits` | tope de trama y de dato, altas marcas de stdin/salida y presupuestos de gobierno |
| `ttls` | plazos de `ping`, `hello`, lápida, TTL de sesión y ocio |
| `ws_close_codes` | los códigos de cierre 4400–4423 y el `1011` interno |
| `framing.tags` | los tags, incluidos los de gobierno 0x50–0x5E |

Las cuatro copias que existen hoy:

- `services/gateway/src/terminal/plugin.ts:49-52` — `COLS_MIN`/`COLS_MAX`/`ROWS_MIN`/`ROWS_MAX`.
- `services/terminal-relay/src/session-limits.ts:28-31` — `MIN_COLS`/`MAX_COLS`/`MIN_ROWS`/`MAX_ROWS`,
  con `CLOSE_CODES` en `:12-26` y los topes de stdin y de ventana justo debajo.
- El agente PTY: `ops/pty-agent/cauce_pty_agent/framing.py:63-66` (`MAX_FRAME`,
  `SESSION_ID_BYTES`, `MAX_DATA`; los tags `TAG_*` están arriba, en `:23-61`, y `DATA_TAGS` en
  `:67`) y `ops/pty-agent/cauce_pty_agent/session.py:47-59` (plazos y cotas de geometría).
- `console/src/features/terminal/pty-types.ts:73-76` — `MAX_FILAS_REMOTAS`, `MAX_COLUMNAS_REMOTAS`,
  `MAX_INPUT_FRAME_BYTES`, `MAX_PENDING_INPUT_BYTES`.

El agente Python es la referencia de la que salieron los valores, y
`ops/pty-agent/tests/test_vectors_contract.py` ya falla si el agente y el fichero se separan. La
procedencia escrita en el propio fichero es parcial: sólo `geometry`, `limits` y `ttls` llevan
campo `sources` (`ws_close_codes` y `framing.tags` no lo tienen). Esas fuentes se citan por
módulo y nombre de constante (`cauce_pty_agent/session.py:MIN_COLS,…`,
`cauce_pty_agent/framing.py:MAX_FRAME`), no por número de línea, así que no envejecen con cada
edición; `limits.stdin_coalesce_ms` apunta al relay (`services/terminal-relay/src/session-limits.ts`),
que es donde vive ese tope. Los valores no corren peligro porque el contrato los verifica contra el
paquete vivo. La mitad que falta es la TypeScript: **generar un módulo desde
`vectors.json`** —y hacer que relay, gateway y consola lo importen— es trabajo del frente de
servicios, no de este sector; aquí solo queda anotado qué habría que generar y desde dónde.
