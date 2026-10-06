#!/usr/bin/env sh
set -eu

if [ "${CAUCE_TEST_DOCKER_NETWORK+x}" != "${CAUCE_TEST_DOCKER_NETWORK_OWNER+x}" ] ||
  { [ "${CAUCE_TEST_DOCKER_NETWORK+x}" = x ] &&
    { [ -z "$CAUCE_TEST_DOCKER_NETWORK" ] || [ -z "$CAUCE_TEST_DOCKER_NETWORK_OWNER" ]; }; }; then
  printf '%s\n' 'an optional Docker bridge requires both its name and owner UUID' >&2
  exit 2
fi

exec pnpm exec vitest run "$@"
