#!/bin/sh
# Restores the relay tunnel when the relay container stops listening on 12222.
# Why it lives on the host and not on the relay container: the tunnel runs INSIDE the
# container, but that container has neither cron nor systemd, so it cannot watch itself.
# The host has user systemd (Linger=yes) and reaches the container via docker exec.
# Chain it restores: <container> -> relay:12222 -> ssh host -> 10.88.88.31:22
# The in-VM script already reconnects by itself if the ssh session drops; this covers
# the OTHER case: the whole process dying.
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
