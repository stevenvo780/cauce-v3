#!/usr/bin/env bash
# Runs e2e suites (real Chromium, PostgreSQL, gateway) inside the docker-lab VM, never on the workstation daemon.
# The VM mounts /datos and /tmp at the same paths, so the checkout and its node_modules are used as they are.
#   scripts/e2e-lab.sh <owner> <vitest arguments...>
#   scripts/e2e-lab.sh h7 tests/e2e/v4-office-real-browser.test.ts --reporter=verbose
# <owner> labels every container of the run (cauce.e2e.owner) so a lane can find and remove what it left behind.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
owner=${1:?uso: scripts/e2e-lab.sh <etiqueta> <argumentos de vitest...>}
shift
[[ $owner =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { printf 'etiqueta inválida: %s\n' "$owner" >&2; exit 2; }
[[ $# -gt 0 ]] || { printf 'faltan los argumentos de vitest\n' >&2; exit 2; }
lab() { docker --context lab "$@"; }

recipe=$ROOT/tests/e2e/lab-runner
image=cauce-e2e-lab-runner:$(sha256sum "$recipe/Dockerfile" | cut -c1-12)
lab image inspect "$image" >/dev/null 2>&1 || lab build -q -t "$image" "$recipe" >/dev/null
socket_group=$(lab run --rm --entrypoint stat -v /var/run/docker.sock:/var/run/docker.sock "$image" -c %g /var/run/docker.sock)

name=zz-canary-e2e-$owner-$$
home=/tmp/cauce-e2e-home-$owner-$$
cleanup() { lab rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$home"; }
trap cleanup EXIT
install -d -m 0700 "$home"
lab run --rm --init --name "$name" --label cauce.e2e.owner="$owner" \
  --user "$(id -u):$(id -g)" --group-add "$socket_group" --network host \
  --mount type=bind,src=/datos,dst=/datos --mount type=bind,src=/tmp,dst=/tmp \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  -e HOME="$home" -e CI=1 -e DOCKER_HOST=unix:///var/run/docker.sock \
  -e TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1 -e TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
  -e CAUCE_REQUIRE_TESTCONTAINERS=1 \
  --workdir "$ROOT" "$image" pnpm exec vitest run "$@"
