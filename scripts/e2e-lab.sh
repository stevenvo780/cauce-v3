#!/usr/bin/env bash
# Runs e2e suites (real Chromium, PostgreSQL, gateway) inside a docker-lab VM, never on the workstation daemon.
# The primary VM (docker context lab) mounts /datos and /tmp at the same paths, so the checkout and its node_modules
# are used as they are. Extra VMs, listed as "<context> <slots>" lines in ${XDG_CONFIG_HOME:-~/.config}/cauce/e2e-contextos
# (a "lab <slots>" line sets the primary's), share nothing: before the run the checkout is mirrored to the same path
# there (what git does not ignore plus the build outputs; node_modules only when the lockfile changes) and the receipts
# the run leaves in .delegados/v4/recibos come back afterwards.
# A saturated VM turns every suite into timeouts, so each VM takes a fixed number of runs at a time: a run takes a free
# slot on the least loaded VM and otherwise waits. No new run goes to a VM while /tmp/cauce-e2e-reserva-<context>
# exists (the release gate reserves the primary that way).
#   scripts/e2e-lab.sh <owner> <vitest arguments...>
#   scripts/e2e-lab.sh h7 tests/e2e/v4-office-real-browser.test.ts --reporter=verbose
#   CAUCE_E2E_CONTEXT=lab2 scripts/e2e-lab.sh h7 ...   (fixes the context)
# <owner> labels every container of the run (cauce.e2e.owner) so a lane can find and remove what it left behind.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
owner=${1:?uso: scripts/e2e-lab.sh <etiqueta> <argumentos de vitest...>}
shift
[[ $owner =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { printf 'etiqueta inválida: %s\n' "$owner" >&2; exit 2; }
[[ $# -gt 0 ]] || { printf 'faltan los argumentos de vitest\n' >&2; exit 2; }

declare -A slots=([lab]=4)
contexts=(lab)
conf=${XDG_CONFIG_HOME:-$HOME/.config}/cauce/e2e-contextos
if [[ -r $conf ]]; then
  while read -r c n _; do
    [[ -z $c || $c == \#* ]] && continue
    [[ -v slots[$c] ]] || contexts+=("$c")
    slots[$c]=${n:-2}
  done < "$conf"
fi
# Children never inherit the lock descriptors: an ssh master started here outlives the run and would keep them.
quiet() { "$@" 7>&- 8>&-; }
ssh_host() { docker context inspect "$1" --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed -n 's#^ssh://##p'; }
# Load per CPU in hundredths; a context that does not answer counts as full.
load() {
  local out
  # shellcheck disable=SC2016  # Expanded by the remote shell.
  out=$(quiet timeout 15 ssh -o BatchMode=yes "$(ssh_host "$1")" 'read -r a _ < /proc/loadavg; echo "$a $(nproc)"' 2>/dev/null) || out=
  if [[ -n $out ]]; then awk '{printf "%d\n", $1 * 100 / $2}' <<<"$out"; else echo 999999; fi
}
# Descriptor 7 holds the slot until the script ends.
take_slot() {
  local -a candidates order
  local c i waited=0
  if [[ -n ${CAUCE_E2E_CONTEXT:-} ]]; then candidates=("$CAUCE_E2E_CONTEXT"); else candidates=("${contexts[@]}"); fi
  while :; do
    mapfile -t order < <(for c in "${candidates[@]}"; do
      if [[ ! -e /tmp/cauce-e2e-reserva-$c ]]; then printf '%s %s\n' "$(load "$c")" "$c"; fi
    done | sort -n | awk '$1 < 999999 {print $2}')
    for c in "${order[@]}"; do
      for ((i = 1; i <= ${slots[$c]:-2}; i++)); do
        exec 7>"/tmp/cauce-e2e-cupo-$c-$i.lock"
        if flock -n 7; then ctx=$c slot=$i; return 0; fi
      done
    done
    (( waited < 180 )) || { printf 'e2e-lab: una hora sin cupo libre en %s\n' "${candidates[*]}" >&2; exit 75; }
    (( waited++ % 6 )) || printf 'e2e-lab: sin cupo libre en %s; espero\n' "${candidates[*]}" >&2
    sleep 20
  done
}
ctx='' slot=''
take_slot
lab() { quiet docker --context "$ctx" "$@"; }
host=$(ssh_host "$ctx")
# Only the primary VM sees the workstation's /datos and /tmp; anything else gets a mirror.
shared=0; [[ $ctx == lab ]] && shared=1
on_vm() { if (( shared )); then "$@"; else quiet ssh -o BatchMode=yes "$host" "$(printf '%q ' "$@")"; fi; }
printf 'e2e-lab: contexto %s (cupo %s de %s)\n' "$ctx" "$slot" "${slots[$ctx]:-2}" >&2

mirror() {
  local ignored want
  [[ -n $host ]] || { printf 'el contexto %s no es ssh://\n' "$ctx" >&2; exit 3; }
  ignored=$(mktemp)
  # What git ignores stays out (secrets, local state, receipts), except the build outputs the suites import. The list
  # travels NUL-separated with rsync wildcards escaped, so an unusual file name cannot slip past its exclusion. .git
  # is mirrored: suites record `git rev-parse HEAD` in their receipts.
  git -C "$ROOT" ls-files -z --others --ignored --exclude-standard --directory | python3 -I -c '
import re, sys
for path in sys.stdin.buffer.read().split(b"\0"):
    if not path or re.search(rb"(^|/)(dist|node_modules)/?$", path):
        continue
    if re.search(rb"[*?[]", path):
        path = re.sub(rb"([*?[\\])", rb"\\\1", path)
    sys.stdout.buffer.write(b"/" + path + b"\0")' > "$ignored"
  exec 8>"/tmp/cauce-e2e-espejo-$ctx.lock"
  flock 8  # one sync per mirror at a time; the runs themselves overlap freely
  on_vm mkdir -p "$ROOT"
  quiet rsync -a --delete --exclude=node_modules --exclude=/.e2e-node-modules --from0 --exclude-from="$ignored" \
    "$ROOT/" "$host:$ROOT/"
  want=$(sha256sum "$ROOT/pnpm-lock.yaml" | cut -c1-16)
  if [[ $(on_vm cat "$ROOT/.e2e-node-modules" 2>/dev/null || true) != "$want" ]]; then
    printf 'e2e-lab: sincronizo node_modules en %s\n' "$ctx" >&2
    local -a modules=()
    mapfile -t modules < <(cd "$ROOT" && git ls-files -- package.json '*/package.json' | xargs -n1 dirname | sort -u \
      | while read -r d; do if [[ -d $d/node_modules ]]; then printf '%s/node_modules\n' "$d"; fi; done | sed 's#^\./##')
    (cd "$ROOT" && quiet rsync -a -R --delete -- "${modules[@]}" "$host:$ROOT/")
    on_vm sh -c "printf '%s\n' $want > $ROOT/.e2e-node-modules"
  fi
  exec 8>&-
  rm -f "$ignored"
}
(( shared )) || mirror

recipe=$ROOT/tests/e2e/lab-runner
image=cauce-e2e-lab-runner:$(sha256sum "$recipe/Dockerfile" | cut -c1-12)
lab image inspect "$image" >/dev/null 2>&1 || lab build -q -t "$image" "$recipe" >/dev/null
socket_group=$(lab run --rm --entrypoint stat -v /var/run/docker.sock:/var/run/docker.sock "$image" -c %g /var/run/docker.sock)

name=zz-canary-e2e-$owner-$$
home=/tmp/cauce-e2e-home-$owner-$$
cleanup() {
  lab rm -f "$name" >/dev/null 2>&1 || true
  on_vm rm -rf "$home" || true
  # Receipts written on a mirror come back to the workstation checkout.
  (( shared )) || quiet rsync -a "$host:$ROOT/.delegados/v4/recibos/" "$ROOT/.delegados/v4/recibos/" 2>/dev/null || true
}
trap cleanup EXIT
on_vm install -d -m 0700 "$home"
lab run --rm --init --name "$name" --label cauce.e2e.owner="$owner" \
  --user "$(id -u):$(id -g)" --group-add "$socket_group" --network host \
  --mount type=bind,src=/datos,dst=/datos --mount type=bind,src=/tmp,dst=/tmp \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  -e HOME="$home" -e CI=1 -e DOCKER_HOST=unix:///var/run/docker.sock \
  -e TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1 -e TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
  -e CAUCE_REQUIRE_TESTCONTAINERS=1 \
  --workdir "$ROOT" "$image" pnpm exec vitest run "$@"
