# Agente PTY (`ops/pty-agent`)

El paquete `cauce_pty_agent/` (Python stdlib, sin dependencias) corre junto al runtime de cada alias, dentro de Docker o en su host nativo y marca SALIENTE por TLS mutuo hacia el terminal-relay — nunca escucha en un puerto. Un módulo por responsabilidad:

| Módulo | Qué contiene |
|---|---|
| `__init__.py` | superficie plana: reexporta todos los nombres para `import cauce_pty_agent as agent` |
| `__main__.py` | punto de entrada de `python3 -m cauce_pty_agent` |
| `framing.py` | tags, límites de trama, codificación/decodificación y verificación del ticket |
| `runtime_facts.py` | lectura y validación del bundle y de los hechos runtime medidos |
| `tmux.py` | resolución de la TUI compartida (tmux y OpenClaw nativo) |
| `session.py` | sesiones PTY: apertura, io, backpressure, cosecha y cierre |
| `input_barrier.py` | sondas en vivo del panel compartido: quién retiene el teclado y qué tamaño real tiene la ventana |
| `governance_paths.py` | listas blancas de gobierno y descriptores de directorio |
| `governance_read.py` | READ: documento e índice de memoria |
| `governance_write.py` | WRITE y WRITE_BATCH con CAS y rollback |
| `agent.py` | `PtyAgent`: conexión al relay, bucle principal y despacho |

Alrededor del paquete, en `ops/pty-agent/`, quedan las piezas del **manager** (no se instalan dentro
del contenedor salvo el propio paquete): `cauce-pty-launcher.sh` (lanzamiento),
`reap_orphan_agent.py` (siega transmitida por stdin),
`rollout-pty.py` + `rollout_pty_lib.py` (despliegue y drop-ins), `derive-alias-key.py` y
`publish-alias-key.sh` (material de ticket por alias), `install-pty-agent.sh`, `systemd/`
(plantillas de unidad) y `tests/`
(unittest, sin socket real). El rollout obtiene los managers de los placements Docker: `local`
corresponde a `server`; cada remoto usa su nombre declarado. El reaper se ejecuta dentro del
contenedor desde stdin y no queda instalado allí. `container-aliases.json` contiene únicamente
contenedores; los agentes `host:` y `vm:` permanecen en `flota.json` y sus manifiestos, y usan
el launcher nativo descrito abajo. El controlador exige un destino por manager, comprueba
duplicados y placement y conserva la reversión por transacción.

**Hace:** abre PTYs bajo demanda (`shell`, o `harness` = TUI real vía `tmux attach` de solo lectura o TUI de OpenClaw) y sirve lectura/escritura de ficheros de gobierno (tags 0x50–0x5E: READ/LIST/WRITE/WRITE_BATCH con CAS y rollback; paths validados con realpath + lista NEVER_SERVE).

**Los tres modos de sesión.** `shell` es un shell propio; `harness` es la TUI real en modo VISOR
(`tmux attach -r -f ignore-size`, o la TUI nativa de OpenClaw) y su STDIN se descarta antes de tocar
el descriptor; `harness_rw` es esa MISMA TUI con el teclado abierto. `READ_ONLY_MODES` sigue siendo
exactamente `{harness}` — el vector `modes` de `tests/terminal-pty/vectors.json` lo lee del propio
`session.py`— y `TUI_MODES` (`{harness, harness_rw}`) es el conjunto que sí puede recibir la
respuesta DA/DSR del emulador: escrito como «lo que no es de solo lectura», una TUI escribible se
quedaba sin el canal técnico que necesita para pintarse.

**Control sobre la conversación actual.** `harness_rw` abre la misma TUI de tmux o la
conversación nativa de OpenClaw. El gateway exige una sesión atribuida, concesión nominal,
grabación y toma de control. Si hay entregas en curso, la toma normal devuelve `agent_busy`;
la consola permite intervenir explícitamente con `allow_busy`, registrado en auditoría.
Tomar el control pausa entregas nuevas; el turno actual sólo se detiene desde su propia TUI.
Los comandos estáticos `HARNESS_COMMAND` siguen sin escritura porque no resuelven una
conversación verificable. En OpenClaw cada ráfaga comprueba que el puntero durable sigue
identificando la conversación abierta; una rotación cierra la sesión sin enviar esos bytes.
El launcher publica el descriptor del binario aunque todavía no exista conversación, y el
agente anuncia los modos únicamente cuando puede resolverla.

Con el teclado abierto, cada ráfaga de STDIN se consulta contra tres fuentes locales e
independientes, las tres a prueba de fallos (lo que no se puede leer cuenta como retenido).
Las sondas de panel y prefijo se aplican a tmux; OpenClaw conserva el bloqueo de escritura
de gobierno, con el control de entregas y el puntero de conversación descritos arriba:

| Motivo de `INPUT_REFUSED` (0x26) | Quién retiene el teclado |
|---|---|
| `pane_input_barrier` | el adaptador está pegando: fija la opción de panel `@cauce_input_barrier` mientras dura la pegada (`acquirePaneInputBarrier`/`releasePaneInputBarrier` en `packages/adapter-sdk/src/shared-session/tmux/mutation.ts`). El agente resuelve primero el panel de la ventana (`tmux list-panes -F '#{pane_id}'`) y lee la opción SOBRE ESE panel con `tmux show-options -pqv`, nunca la escribe, y cachea la respuesta `INPUT_BARRIER_TTL` = 0,25 s para que una pulsación no sea un fork de tmux. Una ventana partida —que el operador puede provocar en cuanto tiene el cliente completo— ya no cumple el `window_panes == 1` del attach y cuenta como retenida: sin eso la sonda leería el panel ACTIVO y un panel vallado que no estuviera activo se leería libre |
| `governance_write_in_flight` | el propio agente tiene una transacción WRITE o WRITE_BATCH viva sobre los ficheros que la TUI lee para contestar el turno (el gate mira los dos diccionarios: un WRITE de un solo fichero retiene igual) |
| `tmux_prefix` | la ráfaga trae el byte de prefijo del servidor tmux del alias (leído una vez con `show-options -gv prefix`/`prefix2`; por defecto `C-b` = 0x02). El attach de `harness_rw` entrega al navegador un cliente tmux COMPLETO, así que el prefijo llega al prompt de comandos de tmux, y desde ahí `run-shell` ejecuta como el usuario runtime y `set-option -pu` borraría la misma barrera de panel de la primera fila. Cierra el prompt, **no** un arnés que de por sí abra shells: eso es una capacidad del arnés, no de este canal |

En los tres casos los bytes se DESCARTAN —nunca se encolan: una ráfaga guardada se vaciaría dentro
del turno de otro en cuanto soltara quien retenía— y se emite UNA trama `INPUT_REFUSED`
`{session_id, reason}` por ráfaga. La sesión no se cierra: es informativa.

**Errores de `WRITE_BATCH` (0x5C).** El commit en sitio (`_commit_in_place`) puede rechazar el
destino antes de escribir nada:

| Código de `WRITE_BATCH_ERR` | Qué significa | Qué hace el operador |
|---|---|---|
| `bind_mount_target` | el fichero de destino es un bind mount de archivo (montaje exacto en `/proc/self/mountinfo`, o mismo `st_dev` si `/proc` no se puede leer): un rename/truncate ahí escribiría al lado equivocado del bind, así que el agente rehúsa el commit en vez de arriesgar una escritura fantasma. `GovernanceBindMountError` va en el `reason` | reubicar el fichero de gobierno fuera del punto de montaje, o hacer el cambio por la vía que gestiona ese bind, no por WRITE_BATCH |

Tras el `OPEN_OK` de un modo TUI, y de nuevo en cada `RESIZE` de `harness_rw`, el agente mide la
ventana real (`tmux display-message -p '#{window_width} #{window_height}'`) y publica `GEOMETRY`
(0x27) con el mismo clamp que OPEN/RESIZE. Si no se puede medir no se envía nada: una geometría
inventada repintaría el panel del operador a un tamaño que no existe. La medida se coalesce con el
mismo `INPUT_BARRIER_TTL` que la sonda de panel: arrastrar el borde de la ventana emite una RESIZE
por cada columna que cambia, y cada medida es un fork bloqueante dentro del `select` monohilo que
además sirve STDOUT y PING de todas las sesiones.

**Lanzamiento:** `cauce-pty-launcher.sh` borra y recrea `/var/tmp/cauce-pty-agent-<alias>/` (raíz compartida por todos los releases: un módulo retirado, o cualquier `.py` que el usuario runtime hubiera dejado ahí, no puede sobrevivir en el `PYTHONPATH`), hace `docker cp` del paquete y lo deja root y no escribible; luego `docker exec ... -e PYTHONPATH=<raíz> python3 -m cauce_pty_agent`, supervisado por unidades user `cauce-v3-pty@<alias>` (drop-ins escritos por `rollout-pty.py`). Cada módulo nuevo del paquete tiene que entrar además en `RELEASE_FILES` de `rollout_pty_lib.py`: publicar el paquete a medias arranca con `ModuleNotFoundError` y salida 1, que la unidad reintenta para siempre.

**Siega previa al exec:** el launcher publica y valida primero el paquete y el bundle, vuelve a
comprobar la generación del contenedor y entonces ejecuta `reap_orphan_agent.py` con el UID/GID
runtime. Reconoce exactamente el argv actual (`python3 -m cauce_pty_agent`) y el argv legado
(`python3 /var/tmp/cauce-pty-agent-<alias>.py`), ambos con la ruta exacta del bundle. Conserva la
identidad `PID + starttime + argv`; los argumentos vacíos también forman parte de esa identidad.

Cada candidato se fija con `pidfd`, se revalida y recibe `SIGTERM`. Tras 2 s, solo la misma
identidad recibe `SIGKILL`; tras otros 2 s, un censo final debe quedar vacío. Un PID desaparecido o
reutilizado no recibe señales. El instalador prueba previamente `pidfd_open` y
`pidfd_send_signal` dentro del contenedor sin matar procesos.

Una ambigüedad semántica o la imposibilidad de demostrar la salida termina con código 78 y no
ejecuta el reemplazo. Un fallo de transporte Docker o su timeout termina con 75 para que systemd
reintente; tampoco ejecuta el reemplazo.

**Compatibilidad de protocolo:** el agente no se publica contra un relay que desconozca sus modos
o tags. El contrato de `tests/terminal-pty/vectors.json` debe cubrir cada tag; la suite
`tests/test_vectors_contract.py` compara los casos, tags, geometría, límites y TTL con el paquete.

**Probar:** `python3 -m unittest discover -s ops/pty-agent` (unit, sin socket real); un fichero
suelto, p. ej. `python3 ops/pty-agent/tests/test_vectors_contract.py`.

## Hosts nativos con Claude o Codex

`cauce-pty-host-launcher.sh` ejecuta el mismo agente Python como el usuario del adaptador.
Acredita `MainPID` de la unidad configurada, tenant, alias, arnés, HOME, perfil y workspace del
proceso; exige el panel `cauce-<alias>:agente` vivo con sus marcadores y directorio exactos.
Anuncia `host:<hostname>` y una generación ligada al arranque del host. Sus modos son
`shell`, `harness` y `harness_rw`, con los mismos controles del gateway y barreras tmux.

Crear `~/.config/cauce-v3/pty-host/<alias>.env` como el usuario runtime, modo 0600 y directorio
0700. El contenido usa valores literales, sin comillas ni expansión de variables:

```ini
TENANT_ID=Steven
ADAPTER_UNIT=cauce-v3-host-astra.service
RELAY_HOST=100.64.0.6
RELAY_PORT=8445
PKI_DIR=/home/ubuntu/.config/cauce-v3/pty-pki/astra
ALIAS_KEY_FILE=/home/ubuntu/.config/cauce-v3/pty-pki/astra/alias-key.hex
```

El endpoint y nombre TLS deben coincidir con el relay de ese despliegue. `PKI_DIR` contiene
`client.crt`, `client.key` y `ca.crt` en 0600, y la clave derivada **de ese alias** en
`alias-key.hex` 0400; todos pertenecen al usuario runtime y el directorio tiene modo 0700.
El launcher crea un bundle temporal privado que el agente consume y elimina inmediatamente.

Publicar la release PTY inmutable, instalar `cauce-v3-pty-host@.service` en el directorio de
unidades del usuario y fijar `CAUCE_PTY_RELEASE_ROOT` a esa release mediante un drop-in de la
instancia. `--preflight-only <alias>` verifica configuración y proceso sin abrir un canal.
Después se puede iniciar `cauce-v3-pty-host@<alias>.service` y verificar los tres modos en el
registro del relay. La unidad acompaña los reinicios de `cauce-v3-host-<alias>.service`; si el
adaptador usa otro nombre, ajustar también `After` y `PartOf` en su drop-in.

El adaptador y su TUI deben estar listos antes de iniciar esta unidad. La publicación de la
release y el preflight no cambian el historial del arnés. Reiniciar sólo el PTY cierra sus
conexiones web y clientes tmux adjuntos; conserva el panel nativo del agente.
