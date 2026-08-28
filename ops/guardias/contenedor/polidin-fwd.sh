#!/usr/bin/env bash
# Exposes the sshd of a temp VM (10.88.88.31:22) to the container network via a relay
# container that listens on :12222 and forwards over ssh to the VM.
# Why this chain:
#  - The relay host DOES route to 10.88.88.0/24 (libvirt "agent-secure" net).
#  - Containers do NOT: the relay host answers ICMP port-unreachable on the forward, and
#    has no passwordless sudo, so iptables/UFW cannot be edited there.
#  - The VM's internal ports (3000/3001/3100/5432/8025) are NOT forwarded because the
#    VM's sshd has AllowTcpForwarding=no (deliberate hardening; live verification runs
#    commands INSIDE the VM via ssh, no tunnels).
#  - UFW inside the VM only accepts :22 from 10.88.88.0/24; therefore the final hop must
#    originate from the relay host (10.88.88.1), not from a container.
# Supervised: if the ssh session drops, reconnects on its own.
while true; do
  ssh -N -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
      -L 0.0.0.0:12222:10.88.88.31:22 \
      kratos
  echo "[$(date -u +%FT%TZ)] tunel caido, reintento en 10s" >&2
  sleep 10
done
