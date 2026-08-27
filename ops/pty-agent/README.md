# Agente PTY (`ops/pty-agent`)

`cauce_pty_agent.py` (un solo fichero, Python stdlib) corre **dentro del contenedor de cada alias** y marca SALIENTE por TLS mutuo hacia el terminal-relay — nunca escucha en un puerto.

**Hace:** abre PTYs bajo demanda (`shell`, o `harness` = TUI real vía `tmux attach` de solo lectura o TUI de OpenClaw) y sirve lectura/escritura de ficheros de gobierno (tags 0x50–0x5E: READ/LIST/WRITE/WRITE_BATCH con CAS y rollback; paths validados con realpath + lista NEVER_SERVE).

**Lanzamiento:** `cauce-pty-launcher.sh` hace `docker cp` del .py al contenedor y lo ejecuta con `docker exec` supervisado por unidades user `cauce-v3-pty@<alias>` (drop-ins escritos por `rollout-pty.py`).

**Los dos peligros conocidos (plan-reestructura/32):**
1. Un rollout mata el `docker exec` del host pero NO el proceso Python dentro del contenedor → quedan huérfanos que comparten certificado con el nuevo y se expulsan mutuamente (`superseded`) en bucle infinito. El launcher debe matar agentes previos del alias dentro del contenedor antes de arrancar.
2. El agente anuncia tags que un relay más viejo no conoce (p.ej. `TAG_READ_DONE` 0x5E) y el relay mata la conexión: **relay y pty-agent se despliegan siempre juntos**, y el contrato de `tests/terminal-pty/vectors.json` debe cubrir todo tag nuevo.

**Probar:** `ops/pty-agent/tests/` (unit, sin socket real).
