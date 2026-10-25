# Runbook: canal PTY de la consola (`terminal-relay`)

## Qué es y qué no es

La consola absorbe las terminales. El transporte de bytes es un servicio nuevo,
`terminal-relay`; el gateway sólo autoriza (ticket), decide (grants) y audita.
El PTY **no** viaja por el bus: no toca `deliveries`, `adapter_outbox` ni el
dispatcher. Cortar el PTY nunca corta mensajes, y cortar el bus nunca corta el
PTY salvo por la autorización.

La frontera de hosts es real y hay que decirla en voz alta:

- El core (gateway, dispatcher, consola, postgres, telegram-bridge) corre en **un** host, y ahí
  corre también `terminal-relay`, hermano del gateway en la red `edge`.
- Los contenedores de los agentes pueden correr en **otro** host, bajo units systemd de usuario.
- Cuando es así, **toda terminal cruza de un host al otro**. La pata que cruza es
  agente→relay, no relay→agente: el agente PTY disca hacia la pierna
  de agentes del relay, `8445`, publicada en la IP privada del tailnet
  (`CAUCE_PRIVATE_BIND_IP`), con mTLS contra la CA interna. Así el host de los agentes no
  necesita puertos entrantes nuevos y el del core no necesita alcanzar contenedores
  ajenos.

Piernas del relay:

| Pierna | Puerto | Publicada al host | Quién entra | Cómo se autentica |
|---|---|---|---|---|
| navegador | 8446 | **no** | sólo el nginx de la consola por la red `edge` | mTLS: cert de cliente `console_gateway_client_cert`, CN exigido en `CAUCE_TERMINAL_RELAY_CONSOLE_CN` |
| agentes | 8445 | sí, `${CAUCE_PRIVATE_BIND_IP}:8445` | agentes PTY de cualquier host, por el tailnet | mTLS contra `gateway_client_ca` + registro `pty_agent_identities.json` |

El nginx de producción declara un `location` de **match exacto** para
`/v3/console/terminal/relays/${CAUCE_TERMINAL_RELAY_INSTANCE_ID}/ws`, que gana sobre el prefijo
`/v3/`. La ruta corta `/v3/console/terminal/ws` no se enruta al relay en producción y cae en el
gateway. Todo el resto de `/v3/console/terminal/*` (capability, targets, sessions) sigue yendo al
gateway.
El upstream del relay se resuelve por variable contra el DNS embebido de Docker
a propósito: con el nombre estático, un `docker stop` del relay haría que el
nginx **no arranque** en su próximo reinicio y se llevaría puesta la consola
entera. Con resolver, un relay caído es un 502 en esa ruta y nada más.

## 1. Aprovisionamiento

Todo vive fuera del repo, en el host del core, con dueño `1000:1000` (el usuario
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
temp_dir=$(mktemp -d)
openssl req -new -newkey rsa:4096 -nodes \
  -keyout /etc/cauce-v3/secrets/terminal-relay.key \
  -out "$temp_dir/terminal-relay.csr" -subj "/CN=terminal-relay"
printf 'subjectAltName=DNS:terminal-relay\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > "$temp_dir/terminal-relay.ext"
openssl x509 -req -in "$temp_dir/terminal-relay.csr" -days 397 \
  -CA "$CAUCE_INTERNAL_CA_CERT" -CAkey "$CAUCE_INTERNAL_CA_KEY" -CAcreateserial \
  -extfile "$temp_dir/terminal-relay.ext" -out /etc/cauce-v3/secrets/terminal-relay.crt
rm -f "$temp_dir/terminal-relay.csr" "$temp_dir/terminal-relay.ext"
rmdir "$temp_dir"
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
{"version":1,"grants":[{"operator":"<correo de console_users>","tenant_id":"<tenant>","alias":"<alias>","modes":["shell","harness"]}]}
JSON
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json                # rename atómico
docker exec cauce-v3-prod-gateway-1 node -e 'const g=JSON.parse(require("fs").readFileSync("/run/cauce-terminal/grants.json","utf8"));console.log(g.version, g.grants.length)'
```

Los cuatro campos son exactamente los que exige `parseGrants`
(`services/gateway/src/terminal/authority.ts`): `operator`, `tenant_id` y `alias` no
vacíos, y `modes` como **array de cadenas**. Escribir `tenant` o `mode` en singular levanta
`grant fields are invalid`, y `rw` ni siquiera es un modo: los únicos son `shell`, `harness` y
`harness_rw` (`services/gateway/src/terminal/types.ts:7`). Con el login por contraseña el
`operator_id` es el **correo** de `console_users` (`ops/runbooks/console-login.md:178`), así que
poner un nombre de usuario en lugar del correo repite el fallo de atribución ya documentado ahí:
la sesión es válida y todos los destinos contestan `authorized:false`.

**El comodín `"*"` en `operator` sólo abre lo que se mira, nunca lo que se teclea.** Sólo
vale con `harness`, el modo de sólo lectura. Una
fila `"*"` que lleve `shell` o `harness_rw` levanta `wildcard operator cannot hold a writable
mode` y, como cualquier otro error de este fichero, deja el archivo ENTERO en `grants: []`: para
escribir dentro del contenedor la fila tiene que **nombrar** al operador.

**`alias: "*"` cubre todos los agentes de un tenant para un operador exacto.** Los agentes creados
desde la consola no tienen fila propia en `grants.json` y su terminal salía «Sin autoridad»; una fila
con `"alias":"*"` los cubre, también los creados después. Exige `tenant_id` y `operator` exactos: una
fila con `operator` y `alias` ambos `"*"` levanta `wildcard operator cannot hold a wildcard alias` y
deja el archivo entero en `grants: []`.

**Un error tipográfico cierra la puerta a todos.** Cualquier excepción dentro de `parseGrants`
deja el archivo ENTERO en `grants: []` y se registra una sola vez por minuto
(`GrantStore.grants`, en `authority.ts`): no hay rechazo por fila ni lista parcialmente válida, y la consola sólo
muestra un `no_grant` genérico que no distingue "a este operador no le toca" de "el archivo no
parseó".

**Ese log no sirve como comprobación inmediata.** `GrantStore` lee el archivo de forma perezosa,
dentro de una request (`GrantStore.grants`, en `authority.ts`): nadie vigila la ruta ni la sondea, así que recién
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

**Segunda fuente: la tabla `terminal_grants` (migración `086`).** Las concesiones
también se administran desde la consola (Ajustes → Acceso → Concesiones de
terminal): alta por persona, agente y modos (`shell`, `harness`, `harness_rw`),
caducidad opcional y revocación con confirmación. Solo el dueño o un admin de la
empresa del agente concede sobre sus agentes; el admin de plataforma, sobre
cualquiera. Cada alta, cambio y baja queda en `audit_events`
(`terminal.grant.create|update|revoke`) con su actor, y revocar corta las
sesiones abiertas de esa concesión en la misma transacción.

Al crear un agente (`grantCreatorTerminalAccess`), el creador humano activo recibe automáticamente concesión de terminal en los tres modos (`shell`, `harness`, `harness_rw`), pero solo si pertenece a la misma empresa que el agente (`company_id = $2 AND active`). Un creador de otra empresa (como un administrador de plataforma operando sobre una empresa ajena) no recibe concesión en el agente creado y no se emiten filas ni eventos de auditoría. Al purgar o eliminar un agente mediante configuración, sus concesiones de terminal en `terminal_grants` se eliminan dentro del plan de purga atómica junto con el resto de su configuración (`PURGE_CONFIGURATION`).

En la consola el panel vive en **Ajustes → Acceso y roles** y se titula **Concesiones de terminal**. No se pinta si quien mira no es dueño, administrador de la empresa o administrador de plataforma. Aunque lo sea, falta mientras el relé no está en estado `available`: mientras se comprueba, o si está `no-desplegado`, `sin-permiso` o `sin-comprobar`, no hay formulario deshabilitado y no se consultan las concesiones. Los modos del formulario son **Shell**, **Visor de TUI** y **TUI escribible**. Un 403 dice «Solo el dueño o un administrador de la empresa del agente puede conceder acceso a su terminal.»

**Precedencia: ninguna fuente prevalece; vale la UNIÓN.** Una sesión se admite
si la concede el archivo **o** una fila viva de la tabla (no revocada y sin
caducar), sobre cada alias de la cohorte del contenedor. Se eligió la unión para
que la transición no deje a nadie fuera: lo que hoy concede `grants.json` sigue
valiendo sin migrar filas, y lo que la consola concede no exige tocar el archivo.
La contrapartida, asumida: revocar en una fuente **no** revoca la otra. Para
quitar un acceso hay que mirar las dos, y el kill switch 1 de §3 cierra las dos.
Un error de parseo del archivo sigue anulando solo la fuente del archivo; la
tabla no depende de ese fichero.

## 2. Encendido, en el orden correcto

Precondiciones, todas verificadas antes de empezar:

- Imágenes publicadas y pinneadas por digest (`CAUCE_RUNTIME_IMAGE`,
  `CAUCE_CONSOLE_IMAGE` con `@sha256:`). Anotar el digest anterior: es el
  rollback.
- Ventana anunciada a la flota, y **ningún despliegue de agente en curso**.
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
curl -sk -o /dev/null -w '%{http_code}\n' https://<ip-privada-consola>:8444/        # 200, la consola sigue entera
```

El `curl` a `/v3/console/terminal/ws` no verifica el relay: esa ruta llega al gateway. Verifica el
transporte abriendo una sesión PTY real desde la consola; el grant entrega la ruta por instancia
que enruta al relay. Un 502 en ese `location` puede indicar que el relay está caído o que falla
la validación TLS del upstream. Un 501 en la ruta de capability indica que el gateway todavía no
tiene habilitado el canal, lo esperado hasta el paso 3.

### Paso 2 — agente PTY en el host de los agentes

Instalación por alias, según el runbook del agente. Si el shell de login de ese host no es POSIX
(fish, por ejemplo), las órdenes remotas van en base64:

```sh
ssh <host> "echo '<b64>' | base64 -d | bash -l"
```

El alta del agente escribe su identidad en `pty_agent_identities.json` con el
rename atómico de §1.4. No reinicia el gateway ni toca el bus. Al terminar, el
relay tiene que ver al agente conectado y la consola tiene que mostrar el alias
en "PTY online" con los destinos sin presencia observada en "Conexión sin comprobar". Ese estado no
confirma si el paquete está instalado.

#### Contenedores de flota V4 de solo lectura

Estos contenedores corren con raíz de solo lectura y sin capacidades: `/var/tmp` no se puede escribir y
`docker cp` no llega a un tmpfs. Con `CONTAINER_RUNTIME_DIR=<directorio tmpfs>` en el `.env` del alias, el
launcher publica el agente con `docker exec` y `tar` en `<dir>/cauce-pty-agent-<alias>`, el usuario runtime
escribe su bundle (0400) en `<dir>/cauce-pty-<alias>` (sticky, `1733`) y el agente recibe ese directorio como
`TMPDIR` para los PEM de TLS. La guarda exige que `CONTAINER_RUNTIME_DIR` sea un directorio `root:root` `0755`
y no un enlace; si no, el launcher se niega a escribir. Sin la clave no cambia nada.

Alta de un alias de contenedor de solo lectura:

1. Declarar el alias en `ops/flota.json` con su contenedor V4 y el ordenador donde corre, y regenerar los derivados con los scripts de `ops/scripts/`.
2. Identidad del alias (§1.4): la clave privada se genera en el host del agente y no sale de allí; el
   certificado `CN=pty-<alias>` lo firma la CA del relay; la clave de alias se deriva con la clave maestra de
   tickets. Su fila entra en `pty_agent_identities.json` por rename atómico. Si el alias ya tenía identidad
   en el host anterior, se reutiliza su PKI y no se emite otra.
3. En el host del agente: el PKI del alias en `~/.config/cauce-v3/pty-pki/<alias>/` (directorio `0700`,
   ficheros `0600`, clave de alias `0400`) y el `.env` del alias como en el
   [README del agente PTY](../ops/pty-agent/README.md), añadiendo `CONTAINER_RUNTIME_DIR`.
4. Publicar una release PTY construida desde el `ops/` actual (lleva la guarda del launcher y el mapa de
   contenedores) y apuntar a ella el drop-in `20-cauce-release.conf` de `cauce-v3-pty@<alias>`; habilitar y
   arrancar la unidad. Comprobar en el journal «relay connected» y «relay accepted … modes=shell», y en la
   consola que el alias deja de mostrar «Conexión sin comprobar».
5. Si el alias tenía una unidad PTY en el host anterior, desactivarla: su contenedor ya no existe y quedaría
   reiniciándose en bucle con el mismo certificado.
6. Añadir la fila de `grants.json` (Paso 4) o cubrirlo con `alias: "*"` del tenant.

#### Rollout acotado y traslado de una terminal

`ops/pty-agent/rollout-pty.py`, en `status`, `preflight` y `rollout`, acepta `--scope-manager` junto con `--aliases` explícitos. Esos alias tienen que pertenecer a ese manager. No se combina con `--retire-historical`. Quien lo lanza tiene que acreditar que la identidad ya no está en el origen del traslado. `rollback <alias> --scope-manager` exige además `--transaction` y se limita al manager declarado de ese alias. Sin `--scope-manager` el comando sigue cubriendo todos los managers declarados.

El traslado de una identidad PTY lo hace `ops/scripts/v4_mover_terminal.py`. Lo despacha `ops/scripts/v4_mover_host.py` para las acciones que empiezan por `terminal-`, salvo `terminal-probe`. El mover de agente llama `terminal-export` y después `terminal-install`. Si hay que revertir, `terminal-start` reactiva el origen cuando el paro se intentó, y `terminal-cleanup` retira el destino cuando la instalación se intentó. Las acciones, sin el prefijo, son `preflight`, `export`, `stop`, `start`, `install`, `destination-preflight` y `cleanup`. En el origen, el usuario systemd tiene que coincidir con el del inventario.

Mueve una sola identidad. Antes de activarla en el destino, cerca el manager anterior: `stop` deshabilita la unidad de origen y siega el proceso viejo; `install` se niega si el destino ya tiene una identidad que no es de esta migración. Reutiliza la PKI que ya existía y no imprime el material. El PTY de un agente cuya colocación es server2 lo atiende el manager de ese host, el usuario `server`, no el manager anterior. Qué alias están en ese host: [La flota y sus participantes](flota-y-participantes.md#máquinas).

#### Canal PTY automático de la flota dinámica (pendiente de desplegar)

Los agentes creados o actualizados por la flota dinámica aprovisionan su canal PTY automáticamente antes de la admisión del agente, sin requerir generación manual de claves ni despliegue manual de unidades:

1. **Aprovisionamiento y autoridad:** el ejecutor del host (`fleet_executor_terminal_provision.py`) solicita a la autoridad firmada los certificados e identidades mTLS con alcance acotado (`fleet-authority-issuer.py`). Instala la unidad systemd de usuario `cauce-v3-pty@<alias>.service` con las variables del selector gestionado (`CAUCE_PTY_FLEET_*`).
2. **Arranque y verificación:** el ejecutor inicia la unidad de usuario y espera la confirmación en el diario de systemd de que el relé aceptó el alias (`relay accepted alias=<wire> modes=...`). Si el canal PTY no queda verificado, la admisión del agente no se completa.
3. **Modos publicados:**
   - Arnés con TUI compartida aprobada (`claude`, `codex`, `muse`, `grok`) con `CAUCE_PTY_FLEET_SHARED_TUI=1`: publica los modos `shell`, `harness` y `harness_rw`. Conecta con la sesión compartida de tmux del contenedor mediante el resolvedor dinámico `tmux_tui`.
   - Sin TUI compartida aprobada: publica únicamente el modo `shell`.
   - OpenClaw (PTY nativo): OpenClaw utiliza su resolvedor PTY nativo (`openclaw_tui`: `node`, `entry`, `state_directory`, `history_limit`). OpenClaw rechaza la configuración de TUI compartida del SDK (`CAUCE_PTY_FLEET_SHARED_TUI=1` aborta con `approved shared TUI harness is unavailable`), conservando su PTY nativo cuando está disponible; si el resolvedor nativo no está acreditado, publica solo `shell`.
4. **Acceso interactivo:** tanto el CLI (`cauce attach <alias>` / `cauce terminal <alias>`) como la consola web (sección **Terminal**) se conectan inmediatamente una vez que el relé acepta la conexión del alias y existe una concesión autorizada.

### Paso 3 — el ÚNICO reinicio del gateway

Anunciado, en una ventana sin despliegues de agente en curso. Anotar la hora exacta.

```sh
# en el env privado: CAUCE_TERMINAL_ENABLED=1
CAUCE_ENV_FILE=/etc/cauce-v3/prod.env ops/scripts/compose.sh prod up -d --no-build --wait gateway
```

**Riesgo, textual:** reiniciar el gateway mata adaptadores con trabajo en vuelo, y un adaptador
puede quedarse muerto en un bucle de `CONNECTION_ZODERROR` del que no se recupera ni
reiniciándolo. Por eso es un único reinicio, anunciado, y por eso
todo lo demás se hace antes con `--no-deps`.

Verificación de que los adaptadores vivos volvieron. La única señal fiable es
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

Criterio: una fila en la consulta 1 por cada alias habilitado, con `last_heartbeat_at` dentro de
los últimos 90 s, y ningún alias vivo sin ACK `started` en la ventana después de
recibir tráfico. Un adaptador con un fallo propio se cuenta aparte.

Rollback del bundle de un adapter por alias, mediante compare-and-swap y sin tocar schema ni
datos: `pin-container-release.py rollback <alias>` requiere `--release`, `--sha256`,
`--expected-release` y `--expected-sha256`. Sigue el procedimiento [Deshacer del runbook de
adaptadores](../ops/runbooks/container-adapters.md#deshacer), que también reinicia el servicio del
alias para aplicar el pin anterior.

Para el canal PTY el rollback barato no es ese: es vaciar `grants.json`
(§3, kill switch 1), que no reinicia nada.

### Paso 4 — la primera fila en `grants.json`

La vía normal ya no es esta: se concede desde la consola (Ajustes → Acceso →
Concesiones de terminal), que escribe en `terminal_grants` sin SSH. El archivo
sigue valiendo por la unión de §1.4 y este paso queda para el encendido inicial
o cuando la consola no está disponible.

Recién ahora se abre la puerta, y se abre para un alias:

```sh
umask 027
tmp=$(mktemp /etc/cauce-v3/terminal/.grants.json.XXXXXX)
cat > "$tmp" <<'JSON'
{"version":1,"grants":[{"operator":"<correo de console_users>","tenant_id":"<tenant>","alias":"<alias>","modes":["shell","harness"]}]}
JSON
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json
docker exec cauce-v3-prod-gateway-1 node -e 'const g=JSON.parse(require("fs").readFileSync("/run/cauce-terminal/grants.json","utf8"));console.log(g.version, g.grants.length)'
```

Los nombres de los campos y por qué el operador es un correo están en §1.4. Si ese `node -e`
falla, la fila no se aplicó y además quedaron revocados los grants que ya hubiera: corregir el
JSON y repetir el rename antes de seguir. El `grep 'terminal grants'` del log sólo dice algo
**después** de una lectura real (§1.4), así que va al final de la verificación de abajo, no acá.

Verificación de extremo a extremo, en la consola publicada (`https://<dominio-consola>`): la barra
de flota muestra el estado de PTY de cada alias, el alias con grant habilitado y el diálogo nombra
a los agentes que comparten el contenedor destino (el mapa de
contenedor↔alias vive en `ops/container-aliases.json`). Dentro de la
shell, `id -un` devuelve el usuario del contenedor —nunca root— y `hostname` devuelve el contenedor
esperado. En `/audit` tienen que
aparecer `terminal.session.request` (allow), `terminal.session.consume` y
`terminal.session.close` con alias, contenedor, digest de imagen, generación y
la identidad de la persona que opera. Cargada esa barra, el gateway ya leyó `grants.json`: ahí
`docker logs --since 2m cauce-v3-prod-gateway-1 | grep 'terminal grants'` sin salida confirma que
la lista se aplicó, y con salida delata la errata que dejó a TODOS los alias sin puerta.

## 3. Los tres kill switches

De más rápido a más lento. El primero es el que se usa; el tercero es el que
casi nunca se usa.

| # | Acción | Tiempo | Alcance | Qué NO toca |
|---|---|---|---|---|
| 1 | Vaciar `grants.json` por rename atómico **y** revocar las filas vivas de `terminal_grants` | instantáneo | nadie puede pedir una terminal nueva; las sesiones abiertas se cortan solas | no reinicia nada, no toca el bus ni la consola |
| 2 | `docker stop cauce-v3-prod-terminal-relay-1` | ~1 s | mata todas las shells de golpe | no toca el bus: los adaptadores siguen entregando y la consola sigue entera, con el canal PTY marcado como no disponible |
| 3 | `CAUCE_TERMINAL_ENABLED=0` + reinicio del gateway | minutos | el gateway deja de emitir tickets y vuelve al 501 de hoy | reinicia el gateway, con todo el riesgo del paso 3 de §2 |

Kill switch 1 (las DOS fuentes, porque vale la unión de §1.4):

```sh
umask 027
tmp=$(mktemp /etc/cauce-v3/terminal/.grants.json.XXXXXX)
printf '{"version":1,"grants":[]}\n' > "$tmp"
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json
# Y la tabla: revocar desde Ajustes → Acceso → Concesiones, o por SQL en la misma ventana:
docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -c \
  "UPDATE terminal_grants SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL"
```

Vaciar solo el archivo ya no basta: una fila viva de `terminal_grants` seguiría
abriendo terminales. Los kill switches 2 y 3 cortan todo sin mirar fuentes.

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

Hay un **cuarto**, que no está en la tabla porque no apaga el canal sino sólo la escritura sobre la
TUI: `CAUCE_TERMINAL_RW_ENABLED=0`. Va en §4.2, junto con lo que estos cuatro interruptores **no**
cierran.

## 4. El modo escribible (`harness_rw`) y el control de la TUI

Éste es el único modo en que un operador **teclea** en la TUI real del alias. `harness` sigue
siendo el visor de sólo lectura y `shell` un shell propio; los tres valores viven en
`services/gateway/src/terminal/types.ts`, y `WRITABLE_MODES` (`{shell, harness_rw}`) es lo que el
gateway y la consola usan para decidir, nunca el nombre del modo. El «por qué» de cada decisión
está en [ADR-009](adr/009-control-de-tui-desde-la-consola.md).

### 4.1 Las seis compuertas de la toma

`POST /v3/console/terminal/sessions` con `mode: "harness_rw"` pasa por seis compuertas, en este
orden (`services/gateway/src/terminal/session-control.ts`). Cada denegación escribe su fila
`terminal.session.request` con `decision: "deny"` y el motivo:

| # | Compuerta | Denegación |
|---|---|---|
| 1 | Interruptor del modo escribible (`CAUCE_TERMINAL_RW_ENABLED`), **antes** de leer la tabla de flota | `writable_tui_disabled` (403) |
| 2 | Permiso canónico `control` del principal, y visibilidad del alias destino **y de todos los que comparten su contenedor** | `control_permission_required` (403) · `target_unavailable` (404) |
| 3 | Atribución: operador **nombrado** (no `unattributed:console-basic-auth`) y atribuido, sobre el destino y sobre toda la cohorte | `writable_requires_named_operator` · `writable_requires_attribution` · `attribution_required` (403) |
| 4 | Autoridad de ruteo sobre **cada** alias del contenedor, réplica del camino de publicación | `no_routing_authority` (403) |
| 5 | Concesión con el modo `harness_rw` sobre **toda** la cohorte: `grants.json` releído del disco **o** fila viva de `terminal_grants` (unión de §1.4) | `no_grant_for_operator` (403) |
| 6 | Un agente PTY vivo en ese contenedor que anuncie `harness_rw` en su hello | `no_recognized_mode` · `agent_offline` (409) |

La regla de cohorte de las compuertas 2, 3, 4 y 5 es la misma de siempre (`containerCohort` en
`services/gateway/src/terminal/authority.ts`): un teclado dentro de un contenedor compartido ve los
directorios de todos sus alias, así que la autoridad sobre uno no puede abrir a los otros por la
puerta de atrás. En un contenedor compartido por dos alias, tomar la TUI de uno exige permiso y
grant sobre el otro también.

**El comodín `"*"` no sirve para escribir.** `parseGrants`
(`services/gateway/src/terminal/authority.ts`) levanta `wildcard operator cannot hold a writable
mode` en cuanto una fila `"*"` lleva `shell` o `harness_rw`, y —como cualquier error de ese
fichero— deja el documento ENTERO en `grants: []`. Y `GrantStore.allows` sólo acepta `"*"` cuando
el modo **no** es escribible. Para teclear, la fila tiene que nombrar al operador:

```sh
umask 027
tmp=$(mktemp /etc/cauce-v3/terminal/.grants.json.XXXXXX)
cat > "$tmp" <<'JSON'
{
  "version": 1,
  "grants": [
    {"operator": "<correo de console_users>", "tenant_id": "<tenant>", "alias": "<alias>",
     "modes": ["shell", "harness", "harness_rw"],
     "note": "teclado sobre la TUI de <alias>"}
  ]
}
JSON
chown 1000:1000 "$tmp"; chmod 0440 "$tmp"
mv -f "$tmp" /etc/cauce-v3/terminal/grants.json
```

**Un operador no atribuido tampoco escribe.** Con la credencial compartida de basic auth el
`operator_id` es `unattributed:console-basic-auth`
(`services/gateway/src/terminal/types.ts`) y la compuerta 3 lo rechaza. Un `shell` sí se abre así
—es el comportamiento de hoy y cerrarlo dejaría al operador fuera de sus propias consolas—, pero un
teclado sobre la TUI de un agente, no: una traza de auditoría que no puede nombrar a la persona no
es una traza.

### 4.2 El cuarto kill switch, y lo que los cuatro NO cierran

`CAUCE_TERMINAL_RW_ENABLED=0` (por defecto; `services/gateway/src/terminal/config.ts`) apaga **la
escritura, no el canal**: `harness` y `shell` siguen abriéndose, y tanto `POST /sessions` con
`harness_rw` como la toma de control contestan `403 writable_tui_disabled`. Frente a los tres de
§3 es más quirúrgico y más lento: exige reiniciar el gateway, igual que el kill switch 3, así que
para cortar en caliente el orden sigue siendo grants → relay → gateway.

Junto a él hay dos ajustes nuevos en el mismo fichero:

| Variable | Por defecto | Techo | Qué acota |
|---|---|---|---|
| `CAUCE_TERMINAL_SESSION_MAX_TOTAL_SECONDS` | `3600` | `14400` | Vida total de una sesión desde `consumed_at`, prórrogas incluidas. No puede quedar por debajo de `CAUCE_TERMINAL_SESSION_TTL_SECONDS` o el gateway no arranca. |
| `CAUCE_TERMINAL_CONTROL_HOLD_SECONDS` | `900` | el valor de la variable anterior | Ventana que pide un arriendo de control. La base la recorta igual (§4.4). |

**Las tres están declaradas para el servicio `gateway` en `deploy/compose.yaml`** con sustitución
de entorno y defaults `CAUCE_TERMINAL_RW_ENABLED=0`, `CAUCE_TERMINAL_CONTROL_HOLD_SECONDS=900` y
`CAUCE_TERMINAL_SESSION_MAX_TOTAL_SECONDS=3600`. La posición segura arranca con el modo escribible
apagado y sin directorio de grabación; se configura en el env file, sin editar `deploy/`.

Y una corrección a §3, que promete de más: **vaciar `grants.json` no cierra todas las puertas al
contenedor.** Cierra la del canal PTY de la consola y nada más.

- El worker legado de **ultimate-terminal** sigue vivo en los contenedores que la consola todavía
  no cubre, con su propio modelo de autorización (§5).
- La **escritura de ficheros de gobierno** desde la consola (`CLAUDE.md`, `AGENTS.md`, workspaces
  de OpenClaw) no pasa por `grants.json`: va por las rutas
  `/v3/console/agents/...` del gateway (`services/gateway/src/console/agent-documents.routes.ts`,
  `agent-context-reload.routes.ts`), gobernadas por el RBAC de la consola. Un `grants.json` vacío
  las deja intactas.

### 4.3 Tomar y devolver el control

Dos verbos sobre la misma ruta, `POST /v3/console/terminal/sessions/:sid/control`
(`services/gateway/src/terminal/session-control/control.ts`). El cuerpo es exacto —una clave de
más lo rechaza— y lleva siempre la valla de dueño del navegador
(`request_id`, `owner_generation`, `owner_token`):

| Campo | Toma | Devolución |
|---|---|---|
| `action` | `"take"` | `"release"` |
| `authority_proof` | obligatoria | obligatoria |
| `allow_busy` | opcional, sólo `"take"` | no se admite |
| `request_id` · `owner_generation` · `owner_token` | obligatorios | obligatorios |

La toma y la apertura no piden justificación de texto. El cuerpo de `POST /sessions` contiene
`tenant_id`, `alias`, `mode`, `cols`, `rows`, `request_id` y `owner_token`; `initiator` es opcional.
El cuerpo de `/control` contiene `action`, `authority_proof`, `request_id`, `owner_generation` y
`owner_token`, más `allow_busy` opcional sólo al tomar. La identidad de la persona y los `reason`
que el gateway devuelve al explicar un rechazo siguen formando parte de la atribución y los errores.

Las columnas históricas `terminal_sessions.reason` y `terminal_control_holds.reason` conservan
sus restricciones y registros anteriores; las nuevas inserciones escriben `''` internamente.
No hay migración ni lectura de esa columna para pedir, validar o auditar una justificación humana.
Los clientes que aún envían `reason` deben actualizarse junto al gateway: el contrato lo rechaza
como campo inesperado.

Una reserva anterior conserva su proof para consumir, retomar y prorrogar la sesión. Un nuevo
intento con el mismo identificador y el hash antiguo recibe `request_conflict`; no se sustituye
la identidad, el propietario ni la semántica de una reserva existente.

La toma vuelve a correr las compuertas 1, 2, 3 y 5 —el `grants.json` se relee del disco sobre toda
la cohorte, otra vez—, exige que la sesión sea `harness_rw` (`no_recognized_mode`, 409) y devuelve
`409 control_held` con `held_by` y `expires_at` si otro operador ya lo tiene. La devolución sólo la
acepta quien lo tomó (`409 control_held` si no), y un arriendo que ya no existe es un **éxito**:
la consola la reintenta desde `beforeunload` y fallar ahí no ayudaría a nadie.

`POST /v3/console/terminal/sessions/:sid/extend`
(`services/gateway/src/terminal/session-control/extend.ts`) empuja la ventana de la **sesión**, no
la del arriendo, y nunca más allá de `consumed_at + CAUCE_TERMINAL_SESSION_MAX_TOTAL_SECONDS`
(`extension_exhausted`, 409). No toca `consumed_at`: la prórroga vive en `window_extended_to`, una
columna propia de la migración `040`, porque `consumed_at` alimenta la contabilidad de plazas de la
consola. La prórroga empuja la ventana de la sesión, **no** el temporizador de inactividad: en una
sesión escribible ese temporizador sólo lo rearma teclear — ni la salida del PTY, ni el `ping` del
navegador, ni esta llamada lo tocan (`resetIdle` no está en el camino de `/extend` ni de la
revalidación). Quien mire una compilación sin teclear cae por inactividad (`4408`) aunque acabe de
prorrogar. Una pestaña olvidada delante de un proceso hablador mantendría viva una shell abandonada
para siempre.

Y para el operador que sale de la consola: `POST /sessions` acepta `initiator: "operator" | "auto"`
(`services/gateway/src/terminal/plugin.ts`), y `auto` **nunca** abre un modo escribible — un visor
automático no toma teclados.

### 4.4 El arriendo: un alias callado, y por cuánto

La toma inserta una fila en `terminal_control_holds` (migración
`packages/store/migrations/040_terminal_control_holds.sql`, API en
`packages/store/src/terminal-control-holds.ts`). Un índice único parcial
`(tenant_id, alias) WHERE released_at IS NULL` garantiza **un arriendo vivo por alias**.

Mientras vive, `claimOne` (`packages/store/src/repository/deliveries/claims.ts`) deja de
seleccionar las entregas de ese alias con un `NOT EXISTS` sobre la tabla. Es todo lo que hace: no
toca `status`, ni `available_at`, ni `attempt`. Las filas **se acumulan `pending`** y salen en el
mismo orden al devolver el control. Una entrega ya arrendada antes de la toma termina su turno: el
arriendo cierra la puerta a leases nuevos, nunca a los que están en vuelo.

El vencimiento se calcula **en SQL**, dentro de la misma transacción que inserta, leyendo la sesión
bajo `FOR UPDATE`: `LEAST(ventana de la sesión, now() + CAUCE_TERMINAL_CONTROL_HOLD_SECONDS)`. Un
arriendo no puede sobrevivir a la sesión que lo abrió. Encima de eso, un `CHECK` de la migración
impone el techo duro de **12 h** desde `taken_at`, y la prórroga del arriendo se recorta contra ese
mismo `CHECK`, no contra la palabra del proceso que extiende.

Se suelta por cuatro caminos, y sólo el último es la red de seguridad:

1. el operador devuelve el control desde la consola;
2. el desmontaje del panel o el `beforeunload` de la pestaña lo devuelven por él;
3. el cierre o la revocación de la sesión lo sueltan **dentro de la misma transacción** que liquida
   la sesión (`releaseHeldControl`); si esa suelta falla, se lleva el cierre con ella —el relay
   respool y reintenta— en vez de dejar al alias callado sin nada en el log;
4. vencido, la **siguiente toma** de ese alias lo suelta como `expired` antes de insertar la suya.

El relay se entera por el ciclo de `/authz` de 30 s: el gateway contesta `403` con
`reason: "control_released"` y sólo entonces
(`services/gateway/src/terminal/relay-proxy/authorization.ts`), y el relay cierra la pierna del
navegador con **`4410 control_released`**
(`services/terminal-relay/src/session-limits.ts`); un visor de sólo lectura, que nunca sostuvo
nada, recibe el `4403` de siempre.

**Comprobación operativa.** Contra la base, un alias con el control tomado tiene entregas
`pending` acumulándose y **ninguna** `failed` por esta causa:

```sh
docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce <<'SQL'
SELECT h.tenant_id, h.alias, h.operator_id, h.taken_at, h.expires_at,
       count(*) FILTER (WHERE d.status IN ('pending','retry')) AS encoladas,
       count(*) FILTER (WHERE d.status = 'leased')             AS en_vuelo,
       count(*) FILTER (WHERE d.status = 'failed')             AS fallidas
  FROM terminal_control_holds h
  LEFT JOIN deliveries d
    ON d.recipient_tenant = h.tenant_id AND d.recipient_alias = h.alias
 WHERE h.released_at IS NULL AND h.expires_at > now()
 GROUP BY h.id, h.tenant_id, h.alias, h.operator_id, h.taken_at, h.expires_at;
SQL
```

`encoladas` sube mientras dura el arriendo y baja sola al devolverlo; `en_vuelo` es como mucho el
turno que ya estaba empezado; `fallidas` **no se mueve**. Si `fallidas` sube durante un arriendo,
el problema no es el control: es el mismo fallo que tendría el alias sin él. Y si `encoladas` no
baja después de devolver el control, mirar primero si quedó un arriendo vivo (la misma consulta sin
el filtro de `expires_at`) antes de tocar el dispatcher.

### 4.5 La grabación

Una sesión escribible sin grabación **no es un modo degradado: no se abre**. Sin un
`CAUCE_TERMINAL_RECORDING_DIR` escribible el relay rechaza la apertura con `recording_unavailable`
(`1011`) antes de que exista el PTY, y un fallo de escritura a mitad de sesión la cierra con
`recording_failed` (`services/terminal-relay/src/session-instance.ts`,
`services/terminal-relay/src/recording.ts`).

| Qué | Dónde |
|---|---|
| Formato | asciicast v2, un evento `o` por ráfaga de salida y uno `i` por ráfaga de entrada |
| Fichero | `<CAUCE_TERMINAL_RECORDING_DIR>/<session_id>.cast` |
| Permisos | directorio `0700`, fichero `0600`, abierto con `O_EXCL` para que dos escritores no se intercalen jamás en el mismo fichero |
| Tope | `CAUCE_TERMINAL_RECORDING_MAX_BYTES`, 32 MiB por defecto; al llegar se para con un evento marcador y la sesión **sigue** |
| Quién NO se graba | los modos de sólo lectura (no tienen teclado); un `shell` sólo detrás de `CAUCE_TERMINAL_RECORD_SHELL_SESSIONS`, apagado por defecto |

Lo que la grabación tiene y lo que **no** sale de ella: los bytes viven en el `.cast` y en ningún
otro sitio. El informe de cierre y las filas de auditoría llevan sólo `bytes_in`, `input_batches`,
la `sha256` del fichero y el flag `recording_capped`. Nunca un byte de lo tecleado, ni un fragmento,
ni la salida del PTY. Ésa es la desviación consciente de D3 —no hay una fila de auditoría por
ráfaga de teclas—: el relay coalesce cada 8 ms y no tiene `DATABASE_URL`, así que el registro por
ráfaga vive en el fichero y la fila agregada `terminal.session.input` se escribe al cierre.

`recording_capped` es lo que impide leer una grabación truncada como si fuera completa: pasado el
tope el fichero deja de crecer, `input_batches` se congela con él y `bytes_in` sigue contando. La
`sha256` acredita el fichero truncado, no la sesión.

**La retención no está resuelta.** Nada poda ese directorio. Cuánto se guarda, en qué volumen y
quién borra es una decisión de operación que no está tomada; hasta que lo esté, el directorio acumula
material con el mismo perfil de amenaza que el propio flujo del PTY.

Las series del relay que miran este modo están en `/metrics`
(`services/terminal-relay/CONFIGURATION.md`): `cauce_terminal_control_sessions_open` (gauge de
sesiones escribibles atadas) y `cauce_terminal_recordings_total{result}` con
`started|refused|capped|failed`. Prometheus descubre el relay por DNS en el job `cauce-relay`
(`ops/observability/prometheus.yaml`) y las alertas del grupo `cauce-v3-terminal`
(`ops/observability/alerts.yaml`) no usan `absent()` a propósito: sin el perfil `terminal` el
nombre no resuelve, no hay target y nadie pagina. El relay vive sólo en la red `edge`, así que para
que ese job resuelva el nombre Prometheus tiene que estar también en `edge` —hoy `deploy/compose.yaml`
lo declara en `[backend, edge]`—; nada en el árbol fija esa pertenencia, así que el raspado se
verifica por efecto, mirando el job `cauce-relay` en `up` dentro de `/targets`.

### 4.6 Cuando el agente rechaza el teclado

Con el teclado abierto, el agente PTY consulta cada ráfaga de STDIN contra tres sondas locales, las
tres a prueba de fallos —lo que no se puede leer cuenta como retenido— y descarta los bytes en vez
de encolarlos: una ráfaga guardada se vaciaría dentro del turno de otro. Emite **una** trama
`INPUT_REFUSED` (`0x26`) `{session_id, reason}` por ráfaga y **no cierra la sesión**
(`ops/pty-agent/README.md`):

| `reason` | Qué está pasando | Qué hace el operador |
|---|---|---|
| `pane_input_barrier` | el adaptador está pegando en el panel: `@cauce_input_barrier` está puesta, o la ventana está partida (una ventana con más de un panel cuenta como retenida) | esperar; la pegada dura lo que dura, y una ventana partida se une |
| `governance_write_in_flight` | el propio agente tiene una transacción `WRITE`/`WRITE_BATCH` viva sobre los ficheros de gobierno que la TUI lee para contestar | esperar a que termine el turno |
| `tmux_prefix` | la ráfaga trae el byte de prefijo del servidor tmux del alias (`C-b` por defecto) | no es un rechazo transitorio: el prompt de comandos de tmux está cerrado a propósito, porque desde ahí `run-shell` ejecuta como el usuario runtime y `set-option -pu` borraría la barrera de panel |

El agente también publica `GEOMETRY` (`0x27`) `{session_id, cols, rows}` con el tamaño real de la
ventana remota tras el `OPEN_OK` y en cada `RESIZE`, para que la consola ajuste la fuente en vez de
imprimir un cartel de «caben N columnas». Si no puede medirla no envía nada: una geometría inventada
repintaría el panel a un tamaño que no existe.

Las dos tramas son informativas, el relay las reenvía sin interpretarlas y **las contabiliza**: van
contra la misma ventana de salida y la misma comprobación de backpressure que la salida del PTY, así
que un agente comprometido que repita `GEOMETRY` en bucle dispara `4413` o `4415` igual que un `cat`
de un binario.

## 5. Deuda con fecha: las dos puertas

Mientras la consola sirva terminales, los workers de **ultimate-terminal**
siguen corriendo en los contenedores que la consola todavía no cubre. Eso significa **dos
puertas a la misma shell con dos modelos de autorización distintos**, y revocar
en una **no** revoca en la otra: vaciar `grants.json` cierra la puerta de la
consola y deja abierta la de ultimate-terminal.

El retiro de esos workers es entregable de la fase siguiente, contenedor por
contenedor, en el mismo cambio en que la consola cubre ese contenedor: se apaga
el worker de ultimate-terminal del contenedor en el mismo despliegue en que su
alias pasa a "PTY online" en la consola. La fase no se da por cerrada mientras
quede un contenedor con las dos puertas abiertas.

## 6. Dev: probar el circuito completo antes de tocar producción

`deploy/compose.dev.yaml` publica las dos piernas del relay (8445 y 8446) en
`CAUCE_DEV_BIND_IP` y levanta el gateway con `CAUCE_TERMINAL_ENABLED=1`. Las dos piernas van con
TLS, no en claro: el relay construye siempre un listener HTTPS con `requestCert: true` y
`rejectUnauthorized: true` (función `createBrowserHttpsServer` de
`services/terminal-relay/src/browser-leg.ts`), y dev apunta
certificado, clave, CA de cliente y CA de agentes al mismo `relay.crt`/`relay.key`
(`CAUCE_TERMINAL_RELAY_TLS_CERT_FILE`, `CAUCE_TERMINAL_RELAY_TLS_KEY_FILE`,
`CAUCE_TERMINAL_RELAY_CLIENT_CA_FILE` y `CAUCE_TERMINAL_RELAY_AGENT_CA_FILE` en
`deploy/compose.dev.yaml`) — dos archivos que el script de abajo **no** crea. Como el
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

El nginx de dev, en el bloque `location = /v3/console/terminal/ws` de `console/nginx.conf`,
**no** tiene el mismo `location` que producción: declara el literal viejo y hace `proxy_pass` en
claro a
`http://terminal-relay:8446`, sin ninguna directiva `proxy_ssl_*`. Producción declara otro
literal, el de la identidad del relay
(`location = "/v3/console/terminal/relays/${CAUCE_TERMINAL_RELAY_INSTANCE_ID}/ws"` en el bloque
correspondiente de `deploy/console/nginx-console-tls.conf`), con mTLS completo contra la CA
interna. Dev no
acredita producción: la auth es de desarrollo y los grants son de juguete.

### 6.1 Pendiente abierto: hoy el circuito de dev no cierra

Esto es trabajo del workstream de consola/deploy; acá sólo queda anotado el orden real en que
falla, que no es el orden en que se descubre. Los cuatro puntos, en cascada:

1. **El stack de dev no arranca.** Los bloques `environment` de `gateway` y `terminal-relay` en
   `deploy/compose.dev.yaml` no definen `CAUCE_TERMINAL_RELAY_INSTANCE_ID`, y ambos lo exigen:
   el gateway tira
   `CAUCE_TERMINAL_RELAY_INSTANCE_ID is required when the terminal plane is enabled`
   (función `relayInstanceIds` de `services/gateway/src/terminal/config.ts`, alcanzada porque dev
   trae `CAUCE_TERMINAL_ENABLED` en `1`) y el relay lo pide en `relayInstanceId` de
   `services/terminal-relay/src/config.ts`. Esto precede a cualquier problema de PTY: sin
   resolverlo no hay nada que probar.
2. **La ruta que reparte el gateway no existe en el nginx de dev.** El grant devuelve
   `/v3/console/terminal/relays/<64hex>/ws`
   (función `terminalRelayWebsocketPath` de `services/gateway/src/terminal/session-control.ts`),
   y dev sólo declara `location = /v3/console/terminal/ws` en `console/nginx.conf`. El upgrade del
   navegador cae entonces en el bloque `location /v3/` de `console/nginx.conf`, que va al gateway y
   **no** manda
   `Upgrade` ni `Connection`: el WebSocket no llega a nacer.
3. **El `Origin` es el primer rechazo de la capa de aplicación.** El handler `server.on('upgrade')`
   de `BrowserLeg` en `services/terminal-relay/src/browser-leg.ts` comprueba en este orden: ruta →
   `origin_mismatch` (`isSameOrigin`) → `untrusted_client_certificate` (`consoleCommonName`).
   `isSameOrigin` exige `protocol === 'https:'`, así que un dev servido por HTTP cae ahí **antes**
   de que se mire ningún certificado.
4. **Con el proxy en claro el relay no registra nada.** El nginx de dev proxea
   `http://terminal-relay:8446` sin `proxy_ssl_certificate` contra un listener construido con
   `requestCert: true, rejectUnauthorized: true`
   (función `createBrowserHttpsServer` de `services/terminal-relay/src/browser-leg.ts`): el
   handshake muere en el transporte y el
   evento `upgrade` no llega a dispararse, así que no se emite ni `origin_mismatch` ni
   `untrusted_client_certificate`. Lo que ve el operador es un 502 de nginx o un error de TLS, no
   un rechazo del relay — por eso este punto se descubre el último aunque falle el primero.

**El `location` de match exacto de producción no se convierte en prefijo.** El literal está
fijado por la prueba «ships one manifest-pinned relay route and no wildcard/client-selected upstream»
de `tests/unit/terminal-relay-operability.test.ts`, y el match exacto es una
propiedad de cerco: la identidad de otro relay tiene que seguir siendo un 404 en el borde. Lo que
se arregla es dev, alineándolo con el literal de producción; no al revés.

## 7. Integración con el resto del árbol

Las cuatro piezas que hacían falta para que `terminal-relay` empaquetara y desplegara junto al
resto del runtime ya están cerradas:

- `pnpm-lock.yaml` incluye el workspace `services/terminal-relay`: la etapa `build` de la imagen
  (`pnpm install --frozen-lockfile`) no falla con `ERR_PNPM_OUTDATED_LOCKFILE`.
- `deploy/runtime/runtime-package-smoke.mjs` lista `terminal-relay` tanto en `runtimePackages` como
  en `runtimeModules`: el smoke que corre dentro de la imagen valida sus dependencias y que
  `dist/main.js` cargue.
- `ops/config/prod.env.example` ya trae las variables del plano (`CAUCE_TERMINAL_ENABLED`,
  `CAUCE_TERMINAL_WS_PATH`, `CAUCE_TERMINAL_OPERATORS`, `CAUCE_TERMINAL_CONSOLE_CN`,
  `CAUCE_TERMINAL_CONFIG_DIR`, `CAUCE_TERMINAL_TICKET_KEY_PATH`,
  `CAUCE_TERMINAL_RELAY_TOKEN_PATH`, `CAUCE_TERMINAL_RELAY_TLS_CERT_PATH`,
  `CAUCE_TERMINAL_RELAY_TLS_KEY_PATH`, `TERMINAL_RELAY_AGENT_PORT`).
- El relay declara `healthcheck` en `deploy/compose.yaml` sobre su puerto de salud
  (`CAUCE_TERMINAL_RELAY_HEALTH_PORT`), igual que el resto de los servicios del runtime.

### 7.1 Constantes que deberían salir de `vectors.json`, no re-declararse

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

- `services/gateway/src/terminal/plugin.ts:51-54` — `COLS_MIN`/`COLS_MAX`/`ROWS_MIN`/`ROWS_MAX`.
- `services/terminal-relay/src/session-limits.ts:48-51` — `MIN_COLS`/`MAX_COLS`/`MIN_ROWS`/`MAX_ROWS`,
  con `CLOSE_CODES` en `:13-29` y los topes de stdin y de ventana en el mismo módulo.
- El agente PTY: `ops/pty-agent/cauce_pty_agent/framing.py` declara `MAX_FRAME`,
  `SESSION_ID_BYTES`, `MAX_DATA`, `DATA_TAGS` y los tags `TAG_*`; `session.py:45-61` contiene los
  plazos y las cotas de geometría.
- `console/src/features/terminal/pty-types.ts` declara `MAX_FILAS_REMOTAS`, `MAX_COLUMNAS_REMOTAS`,
  `MAX_INPUT_FRAME_BYTES` y `MAX_PENDING_INPUT_BYTES`.

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
