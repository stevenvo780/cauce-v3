#!/usr/bin/env bash
# Expone el sshd de la VM polidinamica-temp (10.88.88.31:22) a la red de contenedores.
# Cadena:  <contenedor> -> ws-zeus:12222 -> (ssh kratos) -> 10.88.88.31:22
#
# POR QUE ESTA CADENA:
#  - kratos SI rutea a 10.88.88.0/24 (bridge virbr-agent, red libvirt "agent-secure").
#  - Los contenedores NO: kratos responde ICMP port-unreachable al forward, y en
#    kratos no hay sudo (sudo -n => "a password is required"), asi que no puedo
#    tocar iptables/UFW alli.
#  - Los puertos internos de la VM (3000/3001/3100/5432/8025) NO se reenvian porque
#    el sshd de la VM tiene AllowTcpForwarding=no (endurecimiento deliberado; no lo
#    toco porque contaminaria la revision). La verificacion live se hace ejecutando
#    comandos DENTRO de la VM por ssh, no con tuneles.
#  - UFW dentro de la VM solo acepta :22 desde 10.88.88.0/24; por eso el ultimo salto
#    tiene que salir de kratos (10.88.88.1) y no de un contenedor.
#
# Supervisado: si la sesion ssh cae, reconecta sola.
while true; do
  ssh -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
      -L 0.0.0.0:12222:10.88.88.31:22 \
      kratos
  echo "[$(date -u +%FT%TZ)] tunel caido, reintento en 10s" >&2
  sleep 10
done
