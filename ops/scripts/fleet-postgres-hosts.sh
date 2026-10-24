#!/usr/bin/env bash
# Writes the current IP of the production Postgres into the fleet controller's hosts file.
# The controller and the signed authority resolve "postgres" through that file (bound as /etc/hosts).
# Docker hands out backend IPs in start order, so a VPS reboot can move Postgres (it happened on
# 24-oct-2026) and both services then lose the database. Installed as /usr/local/sbin/cauce-fleet-postgres-hosts
# and run as ExecStartPre of both units (ops/systemd/cauce-fleet-postgres-hosts.conf).
set -euo pipefail

HOSTS=${CAUCE_FLEET_HOSTS_FILE:-/etc/cauce-v3/fleet-v35/controller/hosts}
CONTAINER=${CAUCE_POSTGRES_CONTAINER:-cauce-v3-prod-postgres-1}
NETWORK=${CAUCE_POSTGRES_NETWORK:-cauce-v3-prod_backend}
WAIT_SECONDS=${CAUCE_POSTGRES_WAIT_SECONDS:-120}

ip=''
for _ in $(seq "$WAIT_SECONDS"); do
  ip=$(docker inspect -f "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{.IPAddress}}{{end}}" "$CONTAINER" 2>/dev/null || true)
  [[ $ip =~ ^[0-9]+(\.[0-9]+){3}$ ]] && break
  ip=''
  sleep 1
done
if [[ -z $ip ]]; then
  echo "$CONTAINER has no IP on $NETWORK after ${WAIT_SECONDS}s; $HOSTS left unchanged" >&2
  exit 1
fi

current=$(awk '$2 == "postgres" && NF == 2 { print $1 }' "$HOSTS")
[[ $current == "$ip" ]] && exit 0

# Rewritten in place, not with mv: a service already running keeps its bind on this inode
# and picks up the new IP on its next lookup.
updated=$(awk -v ip="$ip" '$2 == "postgres" && NF == 2 { next } { print } END { print ip " postgres" }' "$HOSTS")
printf '%s\n' "$updated" > "$HOSTS"
echo "postgres in $HOSTS: ${current:-missing} -> $ip"
