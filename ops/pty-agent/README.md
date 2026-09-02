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

**Lanzamiento:** `cauce-pty-launcher.sh` borra y recrea `/var/tmp/cauce-pty-agent-<alias>/` (raíz compartida por todos los releases: un módulo retirado, o cualquier `.py` que el usuario runtime hubiera dejado ahí, no puede sobrevivir en el `PYTHONPATH`), hace `docker cp` del paquete y lo deja root y no escribible; luego `docker exec ... -e PYTHONPATH=<raíz> python3 -m cauce_pty_agent`, supervisado por unidades user `cauce-v3-pty@<alias>` (drop-ins escritos por `rollout-pty.py`). Cada módulo nuevo del paquete tiene que entrar además en `RELEASE_FILES` de `rollout_pty_lib.py`: publicar el paquete a medias arranca con `ModuleNotFoundError` y salida 1, que la unidad reintenta para siempre.

**Los dos peligros conocidos (plan-reestructura/32):**
1. Un rollout mata el `docker exec` del host pero NO el proceso Python dentro del contenedor → quedan huérfanos que comparten certificado con el nuevo y se expulsan mutuamente (`superseded`) en bucle infinito. El launcher debe matar agentes previos del alias dentro del contenedor antes de arrancar.
2. El agente anuncia tags que un relay más viejo no conoce (p.ej. `TAG_READ_DONE` 0x5E) y el relay mata la conexión: **relay y pty-agent se despliegan siempre juntos**, y el contrato de `tests/terminal-pty/vectors.json` debe cubrir todo tag nuevo. Esa regla ya no es una promesa del README: `tests/test_vectors_contract.py` camina los 55 casos del fichero contra este mismo paquete y falla si aparece un `kind` que nadie recorre, si los tags declarados no son los del agente, o si los bloques `geometry`, `limits` y `ttls` dejan de coincidir con sus constantes. Un tag nuevo sin vector es rojo de test, no un descubrimiento en producción.

**Probar:** `python3 -m unittest discover -s ops/pty-agent` (unit, sin socket real); un fichero
suelto, p. ej. `python3 ops/pty-agent/tests/test_vectors_contract.py`.
