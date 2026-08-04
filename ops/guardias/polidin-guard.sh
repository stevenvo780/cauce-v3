#!/bin/sh
# Repone el tunel de Polidinamica si ws-zeus dejo de escuchar en 12222.
#
# Por que vive en kratos y no en ws-zeus: el tunel corre DENTRO de ws-zeus, pero ese contenedor
# no tiene ni cron ni systemd, asi que no puede vigilarse a si mismo. kratos si tiene systemd de
# usuario (Linger=yes) y llega al contenedor por docker exec.
#
# Cadena que repone:  <contenedor> -> ws-zeus:12222 -> ssh kratos -> 10.88.88.31:22
# El script de dentro (/home/dev/polidin-fwd.sh) ya reconecta solo si se cae la sesion ssh;
# esto cubre el otro caso: que MUERA EL PROCESO entero, que es lo que paso el 02-ago.
LOG=/home/stev/.local/state/polidin-guard.log
mkdir -p /home/stev/.local/state
if docker exec ws-zeus sh -c 'ss -lnt 2>/dev/null | grep -q ":12222 "' 2>/dev/null; then
  exit 0
fi
docker exec -d -u dev ws-zeus sh -c 'setsid nohup /home/dev/polidin-fwd.sh >> /home/dev/polidin-fwd.log 2>&1 < /dev/null &'
sleep 4
if docker exec ws-zeus sh -c 'ss -lnt 2>/dev/null | grep -q ":12222 "' 2>/dev/null; then
  echo "$(date -u +%FT%TZ) repuesto OK" >> "$LOG"
else
  echo "$(date -u +%FT%TZ) FALLO al reponer" >> "$LOG"
fi
