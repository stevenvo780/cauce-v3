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
{"version":1,"grants":[{"alias":"jarvis","tenant":"Steven","operator":"steven","mode":"rw"}]}
JSON
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json                # rename atómico
```

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
# rename atómico de §1.4, con la fila de jarvis
```

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
el motivo escrito a mano.

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

`deploy/compose.dev.yaml` levanta el relay en claro en las dos piernas (8445 y
8446 publicadas en `CAUCE_DEV_BIND_IP`) y el gateway con
`CAUCE_TERMINAL_ENABLED=1`. Como el stack de dev no tiene bloque `secrets:`, la
clave de tickets y el token compartido viven en el mismo directorio de trabajo:

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

El nginx de dev (`console/nginx.conf`) tiene el mismo `location` de match
exacto apuntando a `http://terminal-relay:8446`, sin mTLS. Dev no acredita
producción: no hay TLS, la auth es de desarrollo y los grants son de juguete.

## 6. Pendientes de integración

- `pnpm-lock.yaml` tiene que regenerarse cuando entre `services/terminal-relay`:
  la etapa `build` de la imagen usa `pnpm install --frozen-lockfile` y falla con
  `ERR_PNPM_OUTDATED_LOCKFILE` ante un workspace nuevo que el lockfile no
  conoce.
- `deploy/runtime-package-smoke.mjs` enumera servicios a mano
  (`runtimePackages` y `runtimeModules`). El smoke corre dentro de la imagen; si
  no se agrega `terminal-relay` a esas dos listas, la imagen se construye igual
  pero el relay queda sin validación de dependencias ni de módulo cargable.
- `ops/config/prod.env.example` necesita las variables nuevas
  (`CAUCE_TERMINAL_ENABLED`, `CAUCE_TERMINAL_WS_PATH`, `CAUCE_TERMINAL_OPERATORS`,
  `CAUCE_TERMINAL_CONSOLE_CN`, `CAUCE_TERMINAL_CONFIG_DIR`,
  `CAUCE_TERMINAL_TICKET_KEY_PATH`, `CAUCE_TERMINAL_RELAY_TOKEN_PATH`,
  `CAUCE_TERMINAL_RELAY_TLS_CERT_PATH`, `CAUCE_TERMINAL_RELAY_TLS_KEY_PATH`,
  `TERMINAL_RELAY_AGENT_PORT`).
- El relay no declara `healthcheck` porque todavía no hay contrato de puerto de
  health. Cuando el servicio lo exponga, agregarlo con
  `deploy/readiness-probe.mjs` como el resto.
