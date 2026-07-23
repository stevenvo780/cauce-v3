#!/usr/bin/env sh
set -eu

# A remote Docker API proxy may not expose published ports back to this runtime.
# If this process itself is a container, attach PostgreSQL to its first network.
if [ -z "${CAUCE_TEST_DOCKER_NETWORK:-}" ] && command -v docker >/dev/null 2>&1; then
  networks="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$(hostname)" 2>/dev/null || true)"
  if [ -n "$networks" ]; then
    CAUCE_TEST_DOCKER_NETWORK="${networks%% *}"
    export CAUCE_TEST_DOCKER_NETWORK
  fi
fi

export TESTCONTAINERS_RYUK_DISABLED=true
exec pnpm exec vitest run "$@"
