#!/bin/sh
set -eu

install -d -m 0700 -o postgres -g postgres /run/cauce-pg
install -m 0644 -o postgres -g postgres /run/secrets/postgres_server_cert /run/cauce-pg/server.crt
install -m 0600 -o postgres -g postgres /run/secrets/postgres_server_key /run/cauce-pg/server.key
install -m 0644 -o postgres -g postgres /run/secrets/postgres_ca /run/cauce-pg/ca.crt

exec /usr/local/bin/docker-entrypoint.sh "$@"
