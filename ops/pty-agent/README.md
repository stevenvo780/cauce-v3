# Agente PTY de Cauce V3 (`ops/pty-agent`)

Es la única pieza de la terminal que corre **fuera de `agora-storage`**: abre una pseudo-terminal
**dentro del contenedor** de un agente de la flota y la expone por una conexión **saliente** hacia el
`terminal-relay`.

## Por qué siempre marca hacia afuera

El core de Cauce (gateway, consola, postgres, relay) vive en `agora-storage`. Los contenedores de los
14 agentes viven en **otro host, `kratos`**, y sus adaptadores corren como units systemd **de usuario**
del usuario `stev` (shell fish). Desde agora **no se puede iniciar** ninguna conexión hacia kratos: no
hay llave ssh autorizada y crear una sería catastrófico, porque `stev` pertenece al grupo `docker`, o
sea root efectivo sobre kratos y sus 30+ contenedores.

Por eso el agente **nunca escucha en un puerto**. Marca saliente, desde adentro del contenedor, por el
tailnet, a `100.64.0.6:8445`. Es exactamente el patrón que ya usan los adaptadores contra
`wss://100.64.0.6:8443/v3/ws`, así que la conectividad de salida ya está probada en producción.

```
navegador ──HTTPS──> consola (agora) ──> gateway (agora) ──emite ticket──┐
                                                                        v
contenedor en kratos: cauce_pty_agent.py ──TLS mTLS saliente──> terminal-relay :8445 (agora)
```

## Piezas

| Archivo | Dónde corre | Qué hace |
|---|---|---|
| `cauce_pty_agent.py` | dentro del contenedor, como el uid mapeado | abre el PTY, verifica el ticket por segunda vez, habla el protocolo de frames |
| `cauce-pty-launcher.sh` | kratos, como `stev` | resuelve el contenedor, calcula la generación, publica agente + bundle y hace `exec docker exec` |
| `systemd/cauce-v3-pty@.service` | kratos, `systemd --user` de `stev` | mantiene vivo el lanzador por alias |
| `install-pty-agent.sh` | kratos, como `stev` | preflight + instalación idempotente de la unit |
| `derive-alias-key.py` | **agora** | deriva la clave por alias desde la clave maestra |
| `tests/` | cualquier lado | vectores de oro de framing, ticket y HKDF |

## Mapa alias -> contenedor -> usuario

El lanzador **no** conoce este mapa: lo resuelve en vivo con
`python3 ops/scripts/container-alias-query.py <alias>` (sólo lectura). Esta tabla es la foto para leer
de un vistazo qué contenedores están compartidos.

| Alias | Tenant | Contenedor | Usuario | Home | Harness |
|---|---|---|---|---|---|
| argos | Steven | `ctrl-infra` | `dev` | `/home/dev` | claude |
| kant | Steven | `ctrl-infra` | `stev` | `/home/stev` | codex |
| jarvis | Steven | `claw` | `claw` | `/home/claw` | openclaw |
| socrates | Steven | `ws-prizma` | `dev` | `/home/dev` | codex |
| zeus | Steven | `ws-zeus` | `dev` | `/home/dev` | claude |
| kratos | Miguel | `ws-humanizar` | `dev` | `/home/dev` | codex |
| iza | Miguel | `ws-humanizar` | `dev` | `/home/dev` | hermes |
| atlas | Miguel | `ws-humanizar` | `dev` | `/home/dev` | codex |
| janus | Miguel | `claw-miguel` | `claw` | `/home/claw` | openclaw |
| dedalo | Pablo | `ws-pablo` | `dev` | `/home/dev` | codex |
| vulcano | Pablo | `ws-pablo` | `dev` | `/home/dev` | claude |
| midas | Pablo | `agv2-pablo-infra-oc` | `claw` | `/home/claw` | openclaw |
| seneca | Pablo | `agv2-pablo-developer-oc` | `claw` | `/home/claw` | openclaw |
| salva | Isa | `ws-isa` | `dev` | `/home/dev` | codex |
| hegel | Jhon | `agv2-jhon-hegel-oc` | `claw` | `/home/claw` | openclaw |

La tabla refleja el catálogo declarativo exacto de 15 alias. `ops/container-aliases.json` es la
fuente ejecutable; el validador rechaza altas, bajas o placements que no coincidan con ella.

### Contenedores compartidos: qué ve realmente el operador

**Una shell en un contenedor compartido da acceso al home de TODOS los agentes que lo comparten.**
No es una terminal "de argos": es una terminal en `ctrl-infra`, donde argos y kant comparten el
contenedor aunque usen usuarios y homes distintos. `ws-humanizar` reúne kratos, iza y atlas;
`ws-pablo` reúne dedalo y vulcano. La consola lo declara en el diálogo de confirmación y la auditoría
registra el contenedor, no sólo el alias.

Dentro de la flota declarada, los placements no compartidos son jarvis, socrates, zeus, janus,
midas, seneca, salva y hegel.

## Alta de un alias, paso a paso (piloto: `jarvis`)

`jarvis` vive en el contenedor `claw` como usuario `claw` (`/home/claw`), tenant Steven, y es el
primero que se habilita. Los pasos 1 y 2 se hacen en **agora**; del 3 en adelante, en **kratos**.

### 1. Derivar la clave del alias (en agora)

La clave maestra vive **sólo en agora** y nunca se copia a kratos. Lo único que viaja es la clave
derivada, que no sirve para ningún otro alias:

```bash
# en agora-storage
python3 ops/pty-agent/derive-alias-key.py --tenant Steven --alias jarvis \
  --master-file /etc/cauce-v3/pty/master.key   # imprime SÓLO 64 hex por stdout
```

`k_alias = HKDF-SHA256(IKM=master32, salt="cauce-v3/pty-ticket/v1", info="pty:Steven:jarvis", L=32)`.
El gateway deriva la misma clave para firmar tickets; el agente la usa para verificarlos.

### 2. Emitir el material de canal (en agora)

Del PKI del canal PTY (distinto del PKI del bus): `client.crt`, `client.key` para este alias y el
`ca.crt` con el que se valida al relay. El CN del cliente identifica al alias.

### 3. Instalar el material en kratos (como `stev`)

```
~/.config/cauce-v3/pty/jarvis.env            0600
~/.config/cauce-v3/pty-pki/jarvis/client.crt 0600
~/.config/cauce-v3/pty-pki/jarvis/client.key 0600
~/.config/cauce-v3/pty-pki/jarvis/ca.crt     0600
~/.config/cauce-v3/pty-pki/jarvis/alias-key.hex 0400   <- la clave derivada del paso 1
```

`jarvis.env` (claves permitidas: `RELAY_HOST`, `RELAY_PORT`, `RELAY_SERVER_NAME`, `PKI_DIR`,
`ALIAS_KEY_FILE`, `SHELL_CANDIDATES`, `HARNESS_COMMAND`):

```
RELAY_HOST=100.64.0.6
RELAY_PORT=8445
PKI_DIR=/home/stev/.config/cauce-v3/pty-pki/jarvis
ALIAS_KEY_FILE=/home/stev/.config/cauce-v3/pty-pki/jarvis/alias-key.hex
# Opcional. Sólo si el cert del relay NO trae SAN de IP:
# RELAY_SERVER_NAME=relay.cauce.internal
# Opcional. Modo harness: argv FIJO, en JSON, para adjuntarse a la TUI del agente.
# Si NO se declara, el lanzador prueba primero la sesión tmux viva y luego, sólo para un harness
# OpenClaw, publica un resolvedor dinámico que el agente evalúa en cada OPEN (ver abajo).
# HARNESS_COMMAND=["/usr/local/bin/openclaw","attach","--session","jarvis"]
# Opcional. Por defecto: [["/bin/bash","-l"],["/bin/sh","-l"]]
# SHELL_CANDIDATES=[["/bin/bash","-l"],["/bin/sh","-l"]]
```

#### Modo `harness` = la TUI que el agente ya está corriendo

Cada agente de la flota vive dentro de una sesión tmux `cauce-<alias>` **en el socket `cauce`**
(`tmux -L cauce`, no el socket por defecto: `tmux ls` a secas no la ve, y por eso durante meses
pareció que esa TUI no existía). El modo `harness` es lo único que emite esa pantalla; `shell`
abre una terminal nueva, que no es lo que se pide cuando se quiere *ver qué está haciendo*.

Si `HARNESS_COMMAND` no está declarado, `cauce-pty-launcher.sh` prueba primero, dentro del
contenedor y como el usuario del agente, la sesión tmux compartida:

```
tmux -L cauce attach-session -r -f ignore-size -t cauce-<alias>
```

* `-r` → cliente de **solo lectura** como defensa en profundidad. La frontera común a tmux y a
  OpenClaw está en el agente PTY: un `harness` rechaza todo `STDIN` humano y sólo admite por un tag
  separado las respuestas DA/DSR del emulador, validadas contra una lista cerrada en consola,
  relay y agente.
* `-f ignore-size` → el tamaño del navegador no renegocia el de la sesión, así mirar no le
  encoge el panel a la persona que está trabajando en esa misma tmux.

Si no hay tmux viva y el harness medido es `openclaw`, el launcher comprueba la entrada real de
Node y que la versión instalada exponga `tui --session`. No elige una conversación en ese momento:
incluye en el bundle el `stateDirectory` confiable del mapeo del alias y el agente resuelve **en
cada `OPEN`** la única entrada exacta `openclaw:<alias>:shared:<alias>` de
`<stateDirectory>/sessions.json`. No usa el transcript más nuevo ni `mtime`, por lo que un cambio
atómico del pointer se ve en la sesión siguiente sin reiniciar el launcher.

El store falla cerrado: directorio canónico, propiedad del uid efectivo y no escribible por grupo
o mundo; fichero regular 0600 del mismo uid, sin symlink, con un solo enlace, máximo 1 MiB; schema
`{version:1,sessions:{...}}`, pointer inicializado y native id acotado. El store key y el native id
no se escriben en journal ni se publican en presencia. Si falta o no pasa validación, ese `OPEN`
responde `mode_unavailable`; el próximo `OPEN` vuelve a medir el store. Si tampoco existe una TUI
OpenClaw compatible, el agente anuncia sólo `shell`.

En el journal queda la capacidad elegida (`harness derived from tmux ...`, `dynamic openclaw tui
resolver enabled ...` o que no existe TUI), nunca la conversación seleccionada.

Para que la consola pueda pedirlo, el `grants.json` del gateway tiene que listar `harness`
además de `shell` en los modos de ese alias.

Recordá que **kratos usa fish**: los heredocs y las comillas anidadas fallan por ssh. Para ejecutar
algo remoto, empaquetá el comando y decodificalo del otro lado:

```bash
ssh kratos "echo '<base64 del script>' | base64 -d | bash -l"
```

### 4. Preflight y instalación de la unit (en kratos)

```bash
ops/pty-agent/install-pty-agent.sh --preflight-only jarvis   # no instala nada, sólo verifica
ops/pty-agent/install-pty-agent.sh jarvis                    # instala la unit template
ops/pty-agent/install-pty-agent.sh --enable jarvis           # + systemctl --user enable --now
```

El preflight verifica, **desde adentro del contenedor**, que hay salida TCP a `RELAY_HOST:8445`, que
existe `/usr/bin/python3`, que el uid mapeado no es 0, y que `alias-key.hex` tiene modo 0400 y dueño
correcto. Es idempotente y **no reinicia ningún adaptador**.

### 5. Verificar

```bash
systemctl --user status cauce-v3-pty@jarvis.service
journalctl --user -u cauce-v3-pty@jarvis.service -n 30
```

En el journal se ven sólo rutas, dueños, modos e identidades: **nunca** el contenido del bundle, del
certificado ni de la clave. En la consola, `jarvis` pasa a "PTY online".

## Cómo arranca una sesión

1. El lanzador resuelve la tupla del alias, hace `docker inspect` y calcula la **generación**:
   `sha256("<Id>|<StartedAt>|<RestartCount>")` truncado a 32 hex. Si el uid mapeado resuelve a 0,
   aborta con código **78**.
2. Copia el agente a `/var/tmp/cauce-pty-agent-<alias>.py` dentro del contenedor, `chown 0:0`,
   `chmod 0555`: el usuario de runtime lo ejecuta pero no puede reescribirlo.
3. Escribe el bundle JSON con `umask 077` en kratos, lo copia a
   `/var/tmp/.cauce-pty-bundle-<alias>.json`, le pone `chown <uid>:<gid>` y `chmod 0400`, y **borra el
   temporal local**.
4. **Re-verifica la generación.** Si el contenedor se reinició mientras copiábamos, aborta sin
   ejecutar nada: los tickets emitidos para la generación anterior ya no valen.
5. `exec docker exec -i --user <uid>:<gid> ... /usr/bin/python3 <agente> --bundle <bundle>`.

Un `flock` por alias impide dos lanzamientos simultáneos.

El agente **lee el bundle y lo borra (`os.unlink`) inmediatamente**: la clave del alias y el material
de canal no sobreviven a esa única lectura.

## Protocolo

Frames `[tag:1][len:4 big-endian][payload]`, `len <= 65536`.

| Tag | Dirección | Payload |
|---|---|---|
| `0x01` AGENT_HELLO | agente -> relay | JSON `{v, tenant_id, alias, container_id, generation, image_id, runtime_user, runtime_uid, harness, home, agent_version, modes, features}` |
| `0x02` HELLO_ACK | relay -> agente | JSON `{ok, reason?}`; con `ok:false` el agente cierra y reintenta con backoff |
| `0x10` OPEN | relay -> agente | JSON `{session_id, ticket, mode, rows, cols}` |
| `0x11` OPEN_OK | agente -> relay | JSON `{session_id, mode, pid, container_id, generation, image_id, runtime_user, runtime_uid, exp, rows, cols}` |
| `0x12` OPEN_ERR | agente -> relay | JSON `{session_id, reason, detail?}` |
| `0x20` STDIN | relay -> agente | 36 bytes ASCII de session_id + bytes crudos |
| `0x21` STDOUT | agente -> relay | 36 bytes ASCII de session_id + bytes crudos |
| `0x22` RESIZE | relay -> agente | JSON `{session_id, rows, cols}` |
| `0x23` TERMINAL_RESPONSE | relay -> agente | 36 bytes ASCII de session_id + respuesta DA/DSR validada; sólo `harness` |
| `0x24` PAUSE_OUTPUT / `0x25` RESUME_OUTPUT | relay -> agente | JSON `{session_id}`; se negocia con `session_output_flow_control` |
| `0x30` CLOSE | relay -> agente | JSON `{session_id, reason}` |
| `0x31` CLOSED | agente -> relay | JSON `{session_id, exit_code, signal, reason}` |
| `0x40` PING / `0x41` PONG | relay <-> agente | payload vacío |

**Vector de oro del framing** (idéntico en gateway TS, relay TS y agente Python): tag `0x21`, sesión
`11111111-2222-3333-4444-555555555555`, datos `hi`:

```
210000002631313131313131312d323232322d333333332d343434342d3535353535353535353535356869
```

Si pasan **45 s sin PING**, el agente cierra la conexión y reconecta con backoff exponencial de 1 s a
30 s más jitter.

## Verificación del ticket (segunda verificación independiente)

El relay ya validó el ticket antes de reenviar el OPEN. El agente lo valida **otra vez**, con la clave
del alias que sólo existe dentro de ese contenedor. **Un relay comprometido no puede abrir una shell.**

Formato `v1.<b64url(payload)>.<b64url(hmac)>`, con
`hmac_sha256(alias_key, ascii("v1." + b64url_payload))` comparado con `hmac.compare_digest`; b64url
sin padding. Además de la firma se exige **todo** esto:

- `exp` no vencido (tolerancia 5 s)
- `sid == OPEN.session_id`
- `tgt.tenant`, `tgt.alias`, `tgt.container`, `tgt.generation` y `tgt.uid` **iguales a los propios**

Cualquier discrepancia responde `0x12 OPEN_ERR` con el motivo (`ticket_bad_signature`,
`ticket_expired`, `session_mismatch`, `target_mismatch`, ...) y nada más: no se abre ningún proceso.

El vector de oro del ticket y el de HKDF están en `tests/test_ticket.py` y `tests/test_hkdf.py`.

## Qué se ejecuta y con qué entorno

El navegador **jamás** nombra contenedor, usuario ni comando: sólo viaja un alias, y todo lo demás ya
está fijado en el bundle que escribió el lanzador.

- modo `shell`: el primer ejecutable que exista de `shell_candidates` (`/bin/bash -l`, `/bin/sh -l`).
- modo `harness`: el `harness_command` fijo/tmux del bundle o, para OpenClaw, el comando derivado
  del pointer durable exacto en ese `OPEN`. Si la fuente confiable no produce uno:
  `OPEN_ERR mode_unavailable`.

Entorno mínimo y construido por el agente: `TERM=xterm-256color`, `COLORTERM=truecolor`, `HOME`,
`PATH` heredado, `LANG`, `PROMPT_EOL_MARK=''`. Nada más.

## Límites y ciclo de vida

- **Nunca como root.** Si `os.geteuid() == 0` el agente sale con código **78** antes de tocar la red.
  Es la misma negativa fail-closed que ya usa el supervisor de adaptadores.
- Máximo **2 PTYs concurrentes** por proceso; el tercero recibe `OPEN_ERR too_many_sessions`.
- La salida se bufferiza y se vacía cada **16 ms** o al acumular **8192 bytes**, y se fragmenta para no
  pasar 65536 por frame. Cada sesión tiene 256 KiB de high-water. Si un browser lento supera 4 MiB,
  el relay pausa **sólo esa sesión** con `0x24`; el agente sigue leyendo el TLS multiplexado y las
  demás sesiones. Al bajar de 1 MiB llega `0x25`. Un relay que no drena deja como máximo 1 MiB en la
  cola de canal y la presión vuelve a los buffers por sesión.
- La entrada al PTY usa `os.write` no bloqueante y espera writability con `select`; cada sesión admite
  como máximo 256 KiB pendientes. Superarlo manda SIGHUP con razón `input_flood`, sin afectar las
  otras sesiones.
- Cuando la shell muere, `0x31 CLOSED` con `exit_code`/`signal` y **nunca** se respawnea: una TUI que
  el operador creyó terminada no puede revivir sola.
- `0x30 CLOSE` manda SIGHUP, espera 2 s y manda SIGKILL. El `session_id` queda con **tombstone 30 s**
  para ignorar STDIN/RESIZE tardíos.
- Si se cae el relay (`docker stop` del contenedor del relay, corte de red), el agente termina todas
  sus sesiones: sin relay no hay operador del otro lado. El bus **no se ve afectado**: la unit del PTY
  es hermana e independiente de `cauce-v3-container-<alias>.service`.
- El agente vuelve a conectar su canal TLS, pero eso no reanuda un PTY del browser: los tickets son
  de un solo uso y hoy un disconnect cierra la sesión. Un reconnect seguro requiere el contrato de
  resume del gateway descrito en `services/terminal-relay/CONFIGURATION.md`.

## La unit es independiente del adaptador, a propósito

`cauce-v3-pty@<alias>.service` **no** declara `Requires=`/`After=` sobre
`cauce-v3-container-<alias>.service`. Si el adaptador está muerto (argos está hoy en un bucle de
`CONNECTION_ZODERROR`), la terminal tiene que seguir funcionando: ése es justamente el caso de uso más
valioso. Instalar o habilitar el PTY **no reinicia ni toca ningún adaptador**.

## Tests

```bash
python3 -m unittest discover ops/pty-agent/tests
```

Cubren el framing (incluido el vector de oro y la decodificación con fragmentación de 1 byte), la
verificación del ticket (válido, vencido, alias equivocado por target y por clave de firma, tenant
equivocado, generación equivocada, HMAC alterado, sesión equivocada), HKDF, geometría, viewer
read-only, DA/DSR, pausa por sesión, input flood y resolución dinámica de OpenClaw con cambio
atómico del pointer y fuentes hostiles. La negativa a correr como root también está cubierta.
