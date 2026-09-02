# Agente PTY (`ops/pty-agent`)

El paquete `cauce_pty_agent/` (Python stdlib, sin dependencias) corre **dentro del contenedor de cada alias** y marca SALIENTE por TLS mutuo hacia el terminal-relay — nunca escucha en un puerto. Un módulo por responsabilidad:

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

Alrededor del paquete, en `ops/pty-agent/`, quedan las piezas del **host** (no viajan al contenedor
salvo el propio paquete): `cauce-pty-launcher.sh` (lanzamiento y siega), `rollout-pty.py` +
`rollout_pty_lib.py` (despliegue y drop-ins), `derive-alias-key.py` y `publish-alias-key.sh`
(material de ticket por alias), `install-pty-agent.sh`, `systemd/` (plantillas de unidad) y `tests/`
(unittest, sin socket real). El paquete es lo único que se copia al contenedor; todo lo demás corre
en kratos.

**Hace:** abre PTYs bajo demanda (`shell`, o `harness` = TUI real vía `tmux attach` de solo lectura o TUI de OpenClaw) y sirve lectura/escritura de ficheros de gobierno (tags 0x50–0x5E: READ/LIST/WRITE/WRITE_BATCH con CAS y rollback; paths validados con realpath + lista NEVER_SERVE).

**Los tres modos de sesión.** `shell` es un shell propio; `harness` es la TUI real en modo VISOR
(`tmux attach -r -f ignore-size`, o la TUI nativa de OpenClaw) y su STDIN se descarta antes de tocar
el descriptor; `harness_rw` es esa MISMA TUI con el teclado abierto. `READ_ONLY_MODES` sigue siendo
exactamente `{harness}` — el vector `modes` de `tests/terminal-pty/vectors.json` lo lee del propio
`session.py`— y `TUI_MODES` (`{harness, harness_rw}`) es el conjunto que sí puede recibir la
respuesta DA/DSR del emulador: escrito como «lo que no es de solo lectura», una TUI escribible se
quedaba sin el canal técnico que necesita para pintarse.

**La escritura es gobernada, no libre.** `harness_rw` sólo se resuelve por la vía tmux, la única con
barrera de panel: `HARNESS_COMMAND` se escribe a mano en el `.env` del alias y la TUI nativa de
OpenClaw no tiene equivalente de `-r`, así que las dos rechazan el modo con `OPEN_ERR`
`writable_tui_unavailable` (el `detail` nombra la vía) en vez de abrir un teclado que nadie puede
frenar. Sobre la vía tmux el ataque es el mismo comando `if-shell` de siempre —mismas seis
condiciones de identidad, misma rama falsa `exit 77`— y lo único que cambia es que el attach pierde
`-r` y `-f ignore-size`, para que la ventana compartida siga al navegador mientras el operador tenga
el control.

Con el teclado abierto, cada ráfaga de STDIN se consulta contra tres fuentes locales e
independientes, las tres a prueba de fallos (lo que no se puede leer cuenta como retenido):

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

> **Despliegue acoplado (no es opcional).** El agente anuncia `harness_rw` en el hello en cuanto la
> vía tmux resuelve, y emite `INPUT_REFUSED` (0x26) y `GEOMETRY` (0x27) —esta última también en el
> modo visor, tras el `OPEN_OK`—. Hoy el relay rompe por los dos lados:
> `services/terminal-relay/src/agent-hello.ts` estrecha `modes` a `shell|harness` y **una entrada
> fuera de ese par invalida el hello entero**, y `services/terminal-relay/src/framing.ts` no tiene
> 0x26 ni 0x27 en `FRAME_TAGS`, donde **un tag desconocido tira la pata multiplexada completa del
> alias**, no una sesión. Ampliar sólo `modes` deja el segundo fallo en pie y el primer OPEN de
> `harness` se lleva por delante todas las terminales del alias. Este paquete no se publica hasta
> que el relay conozca **los dos tags Y `harness_rw`** (W3B-06): relay y pty-agent se despliegan
> juntos, siempre.

**Lanzamiento:** `cauce-pty-launcher.sh` borra y recrea `/var/tmp/cauce-pty-agent-<alias>/` (raíz compartida por todos los releases: un módulo retirado, o cualquier `.py` que el usuario runtime hubiera dejado ahí, no puede sobrevivir en el `PYTHONPATH`), hace `docker cp` del paquete y lo deja root y no escribible; luego `docker exec ... -e PYTHONPATH=<raíz> python3 -m cauce_pty_agent`, supervisado por unidades user `cauce-v3-pty@<alias>` (drop-ins escritos por `rollout-pty.py`). Cada módulo nuevo del paquete tiene que entrar además en `RELEASE_FILES` de `rollout_pty_lib.py`: publicar el paquete a medias arranca con `ModuleNotFoundError` y salida 1, que la unidad reintenta para siempre.

**Los dos peligros conocidos (plan-reestructura/32):**
1. Un rollout mata el `docker exec` del host pero NO el proceso Python dentro del contenedor → quedan huérfanos que comparten certificado con el nuevo y se expulsan mutuamente (`superseded`) en bucle infinito. El launcher debe matar agentes previos del alias dentro del contenedor antes de arrancar.
2. El agente anuncia tags que un relay más viejo no conoce (p.ej. `TAG_READ_DONE` 0x5E) y el relay mata la conexión: **relay y pty-agent se despliegan siempre juntos**, y el contrato de `tests/terminal-pty/vectors.json` debe cubrir todo tag nuevo. Esa regla ya no es una promesa del README: `tests/test_vectors_contract.py` camina TODOS los casos del fichero contra este mismo paquete y falla si aparece un `kind` que nadie recorre, si los tags declarados no son los del agente, o si los bloques `geometry`, `limits` y `ttls` dejan de coincidir con sus constantes. Un tag nuevo sin vector es rojo de test, no un descubrimiento en producción.

**Probar:** `python3 -m unittest discover -s ops/pty-agent` (unit, sin socket real); un fichero
suelto, p. ej. `python3 ops/pty-agent/tests/test_vectors_contract.py`.
