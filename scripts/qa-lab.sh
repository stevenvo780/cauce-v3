#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OWNER=qa0-entorno-exploracion-1025
action=${1:-}
name=${2:-}
[[ $# == 2 && $name =~ ^[a-z][a-z0-9-]{0,19}$ ]] || {
  printf 'Uso: scripts/qa-lab.sh up|status|down <nombre: a-z, 0-9, guion, máximo 20>\n' >&2; exit 2;
}
prefix=zz-canary-qa-$name
receipt=$ROOT/.delegados/v4/recibos/$OWNER/$name
[[ ! -L $receipt ]] || { printf 'Directorio de recibos inseguro\n' >&2; exit 2; }
mkdir -p "$receipt"
chmod 700 "$receipt"
ctx=''
host=''
vmroot=$ROOT
completed=0
selected=0
tunnel_pid=''
waiter_pid=''
labels=(--label "cauce.e2e.owner=$OWNER" --label "cauce.qa.name=$name")

lab() { docker --context "$ctx" "$@" 7>&- 9>&-; }
remote() { ssh -o BatchMode=yes "$host" "$(printf '%q ' "$@")" 7>&- 9>&-; }
read_context() {
  [[ -f $receipt/context ]] || return 1
  read -r ctx < "$receipt/context"
  [[ $ctx =~ ^lab[23]?$ ]] || return 1
  host=$(docker context inspect "$ctx" --format '{{.Endpoints.docker.Host}}')
  [[ $host == ssh://* ]] || return 1
  host=${host#ssh://}
}
assert_vm() {
  local actual
  actual=$(timeout 20 docker --context "$ctx" info --format '{{.Name}}' 7>&- 9>&-)
  [[ $actual =~ ^docker-lab(-[23])?$ ]] || { printf 'El contexto no apunta a docker-lab\n' >&2; return 1; }
}
stop_and_reclaim() {
  local running
  running=$(lab ps -q --filter "name=^/$prefix-runner$" --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1
  [[ -z $running ]] || lab stop -t 90 "$running" >/dev/null || return 1
  running=$(lab ps -q --filter "name=^/$prefix-daemon$" --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1
  if [[ -n $running ]] && lab exec "$running" test -d "/tmp/$prefix-work"; then
    lab exec "$running" chown -R "$(id -u):$(id -g)" "/tmp/$prefix-work" || return 1
  fi
}
save_runner_log() {
  local present
  present=$(lab ps -aq --filter "name=^/$prefix-runner$" --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1
  [[ -n $present ]] || return 0
  lab logs --tail 500 "$present" 2>&1 | python3 -I -c '
import re,sys
body=sys.stdin.read()
body=re.sub(r"-----BEGIN [^-]+-----.*?-----END [^-]+-----", "[private material redacted]", body, flags=re.S)
body=re.sub(r"postgres(?:ql)?://[^\s]+", "postgresql://redacted", body)
body=re.sub(r"(?i)(Bearer\s+)[^\s]+", r"\1[redacted]", body)
body=re.sub(r"[A-Za-z0-9_+/=-]{40,}", "[opaque value redacted]", body)
sys.stdout.write(body)' > "$receipt/runner.log"
}
remove_resources() {
  local ids resource kind label_field
  for kind in container network volume image; do
    case $kind in
      container) ids=$(lab ps -aq --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1 ;;
      *) ids=$(lab "$kind" ls -q --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1 ;;
    esac
    for resource in $ids; do
      label_field='.Labels'; [[ $kind != container && $kind != image ]] || label_field='.Config.Labels'
      [[ $(lab "$kind" inspect --format "{{index $label_field \"cauce.e2e.owner\"}} {{index $label_field \"cauce.qa.name\"}}" "$resource") == "$OWNER $name" ]] || return 1
      case $kind in
        container) lab rm -fv "$resource" >/dev/null || return 1 ;;
        image) lab image rm "$resource" >/dev/null || return 1 ;;
        *) lab "$kind" rm "$resource" >/dev/null || return 1 ;;
      esac
    done
  done
}
assert_empty() {
  local kind found
  for kind in container network volume image; do
    if [[ $kind == container ]]; then found=$(lab ps -aq --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1;
    else found=$(lab "$kind" ls -q --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") || return 1; fi
    [[ -z $found ]] || { printf 'Quedan recursos: %s\n' "$kind" >&2; return 1; }
  done
}
sync_receipts() {
  [[ $ctx != lab ]] || return 0
  rsync -a "$host:$vmroot/.delegados/v4/recibos/$OWNER/$name/" "$receipt/" 7>&- 9>&-
}
choose_context() {
  local candidate slot limit free_space
  local -a candidates=(lab lab2 lab3)
  [[ -z ${CAUCE_QA_CONTEXT:-} ]] || candidates=("$CAUCE_QA_CONTEXT")
  for candidate in "${candidates[@]}"; do
    [[ $candidate =~ ^lab[23]?$ && ! -e /tmp/cauce-e2e-reserva-$candidate ]] || continue
    ctx=$candidate
    assert_vm >/dev/null 2>&1 || continue
    host=$(docker context inspect "$ctx" --format '{{.Endpoints.docker.Host}}') || continue
    [[ $host == ssh://* ]] || continue
    host=${host#ssh://}
    free_space=$(remote df -Pk /var/lib/docker /tmp | awk 'NR > 1 {if (!free || $4 < free) free=$4} END {print free}') || continue
    [[ $free_space =~ ^[0-9]+$ && $free_space -ge 8000000 ]] || continue
    limit=2; [[ $ctx != lab ]] || limit=4
    local configured
    configured=$(awk -v context="$ctx" '$1 == context && $2 ~ /^[0-9]+$/ {print $2}' "${XDG_CONFIG_HOME:-$HOME/.config}/cauce/e2e-contextos" 2>/dev/null || true)
    [[ -z $configured ]] || limit=$configured
    for ((slot=1; slot<=limit; slot++)); do
      exec 7>"/tmp/cauce-e2e-cupo-$ctx-$slot.lock"
      if flock -n 7; then
        selected=1
        printf '%s\n' "$ctx" > "$receipt/context" || return 1
        read_context || return 1
        return 0
      fi
    done
  done
  printf 'No hay cupo libre en los contextos de laboratorio\n' >&2
  return 75
}
mirror() {
  [[ $ctx != lab ]] || return 0
  vmroot=/tmp/$prefix-checkout
  local list=$receipt/source-files
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard | python3 -I -c '
import sys
for path in sys.stdin.buffer.read().split(b"\0"):
    parts=path.split(b"/")
    if not path or any(p in (b"private",b"credentials",b"secrets",b"tokens",b"sessions",b".delegados",b"auth.json",b"settings.local.json") or p.startswith(b".env") for p in parts): continue
    sys.stdout.buffer.write(path+b"\0")' > "$list"
  remote mkdir -p "$vmroot"
  rsync -a --from0 --files-from="$list" "$ROOT/" "$host:$vmroot/" 7>&- 9>&-
  rsync -a "$ROOT/.git" "$host:$vmroot/" 7>&- 9>&-
  local -a modules=()
  mapfile -t modules < <(cd "$ROOT" && git ls-files -- package.json '*/package.json' | xargs -n1 dirname | sort -u | while read -r directory; do
    [[ ! -d $directory/node_modules ]] || printf '%s/node_modules\n' "$directory"
    [[ ! -d $directory/dist ]] || printf '%s/dist\n' "$directory"
  done)
  (cd "$ROOT" && rsync -a -R -- "${modules[@]}" "$host:$vmroot/" 7>&- 9>&-)
}
supervise() {
  local runner=$prefix-runner daemon=$prefix-daemon network=$prefix-network data=$prefix-data
  cleanup() {
    local code=$?
    local absent=false
    trap - EXIT INT TERM HUP
    if (( selected )); then
      stop_and_reclaim || code=1
      save_runner_log || code=1
      remote rm -rf -- "$vmroot/.delegados/v4/recibos/$OWNER/$name/private" || code=1
      sync_receipts || code=1
      if remove_resources && assert_empty; then absent=true; else code=1; fi
      remote rm -rf -- "/tmp/$prefix-runtime" "/tmp/$prefix-work" || code=1
      if [[ $ctx != lab ]]; then remote rm -rf -- "/tmp/$prefix-checkout" || code=1; fi
    fi
    rm -rf -- "$receipt/private" || code=1
    if [[ -n $tunnel_pid ]]; then kill -TERM "$tunnel_pid" 2>/dev/null || true; fi
    if [[ -n $waiter_pid ]] && jobs -pr | rg -qx "$waiter_pid"; then kill -TERM "$waiter_pid" 2>/dev/null || true; fi
    printf '%s\n' "$code" > "$receipt/supervisor.exit"
    printf '{"exit":%s,"resourcesVerifiedAbsent":%s}\n' "$code" "$absent" > "$receipt/cleanup.json"
    if (( completed == 0 )); then printf 'Arranque no completado; consulta supervisor.log\n' >&2; fi
    exit "$code"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  for ((turn=0; turn<18; turn++)); do
    if choose_context; then break; fi
    sleep 10
  done
  (( selected )) || return 75
  assert_empty
  mirror
  local vmdir=$vmroot/.delegados/v4/recibos/$OWNER/$name
  remote install -d -m 0700 "$vmdir" "$vmdir/private" "/tmp/$prefix-runtime/raw"
  remote chmod 0755 "/tmp/$prefix-runtime"
  local recipe=$ROOT/tests/e2e/lab-runner
  lab build -q "${labels[@]}" -t "$prefix:runner" "$recipe" > "$receipt/runner-image.id"
  local dind
  dind=$(sed -n "s/^export const X_DIND_IMAGE = '\([^']*\)';/\1/p" "$ROOT/tests/e2e/v4-agentes-x-docker-isolation.ts")
  [[ $dind == docker@sha256:* ]] || return 1
  lab network create "${labels[@]}" "$network" >/dev/null
  lab volume create "${labels[@]}" "$data" >/dev/null
  lab run -d --name "$daemon" --hostname "$daemon" "${labels[@]}" --privileged --network "$network" \
    --publish 0.0.0.0::4443 --mount "type=volume,src=$data,dst=/var/lib/docker" \
    --mount type=bind,src=/datos,dst=/datos --mount type=bind,src=/tmp,dst=/tmp \
    --mount "type=bind,src=/tmp/$prefix-runtime/raw,dst=/run/qa-docker" -e DOCKER_TLS_CERTDIR= \
    "$dind" dockerd --host unix:///run/qa-docker/docker.sock --storage-driver overlay2 \
    --default-address-pool base=10.240.0.0/16,size=24 --bip 10.241.0.1/24 > "$receipt/daemon.id"
  local port address url
  port=$(lab port "$daemon" 4443/tcp | sed -n 's/^0.0.0.0://p')
  address=$(ssh -G "$host" 2>/dev/null | awk '$1 == "hostname" {print $2; exit}')
  [[ $port =~ ^[0-9]+$ && $address =~ ^[0-9.]+$ ]] || return 1
  url=https://$address:$port
  if [[ $ctx != lab ]]; then
    local local_port
    local_port=$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
    ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L "127.0.0.1:$local_port:127.0.0.1:$port" "$host" 7>&- 9>&- &
    tunnel_pid=$!
    url=https://localhost:$local_port
  fi
  printf '%s\n' "$url" > "$receipt/url"
  for ((attempt=0; attempt<120; attempt++)); do
    lab exec "$daemon" docker --host unix:///run/qa-docker/docker.sock info >/dev/null 2>&1 && break
    sleep 1
  done
  lab exec "$daemon" docker --host unix:///run/qa-docker/docker.sock info >/dev/null
  local socket_group
  socket_group=$(lab exec "$daemon" stat -c %g /run/qa-docker/docker.sock)
  lab run -d --init --name "$runner" "${labels[@]}" --network "container:$daemon" \
    --user "$(id -u):$(id -g)" --group-add "$socket_group" --group-add 65432 \
    --mount type=bind,src=/datos,dst=/datos --mount type=bind,src=/tmp,dst=/tmp \
    -e HOME="$vmdir/private/home" -e NODE_ENV=test -e CI=1 -e DOCKER_BUILDKIT=0 -e QA_LAB_NAME="$name" \
    -e QA_LAB_DIRECTORY="$vmdir" -e QA_LAB_URL="$url" -e TESTCONTAINERS_RYUK_DISABLED=true \
    -e QA_LAB_RAW_SOCKET="/tmp/$prefix-runtime/raw/docker.sock" \
    -e TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1 -e VITE_USE_MOCKS=false \
    --workdir "$vmroot" "$prefix:runner" node --import tsx --import ./tests/e2e/qa-lab-context.mjs \
    tests/e2e/qa-lab.fixture.ts > "$receipt/runner.id"
  completed=1
  docker --context "$ctx" wait "$runner" 7>&- 9>&- > "$receipt/runner.exit" &
  waiter_pid=$!
  wait "$waiter_pid"
  [[ $(cat "$receipt/runner.exit") == 0 ]]
}

case $action in
  __supervise) supervise ;;
  up)
    exec 9>"$receipt/command.lock"
    flock -n 9 || { printf 'Otra orden usa este nombre\n' >&2; exit 75; }
    if read_context && [[ -n $(lab ps -q --filter "name=^/$prefix-runner$" --filter "label=cauce.e2e.owner=$OWNER") ]]; then
      printf 'El laboratorio ya existe; usa status o down\n' >&2; exit 1
    fi
    rm -f "$receipt/ready.json" "$receipt/confirmed" "$receipt/stop" "$receipt/supervisor.exit" "$receipt/runner.exit"
    setsid bash "$ROOT/scripts/qa-lab.sh" __supervise "$name" > "$receipt/supervisor.log" 2>&1 < /dev/null 9>&- &
    supervisor=$!
    abort_up() { kill -TERM "$supervisor" 2>/dev/null || true; }
    trap 'abort_up; exit 130' INT TERM HUP
    for ((attempt=0; attempt<1200; attempt++)); do
      if [[ -f $receipt/supervisor.exit ]]; then
        printf 'El arranque falló; recibo: %s/supervisor.log\n' "$receipt" >&2; exit 1
      fi
      if read_context; then
        vmroot=$ROOT; [[ $ctx == lab ]] || vmroot=/tmp/$prefix-checkout
        sync_receipts >/dev/null 2>&1 || true
        if [[ -f $receipt/ready.json ]] && python3 -I -c 'import json,sys;sys.exit(json.load(open(sys.argv[1])).get("status")!="ready")' "$receipt/ready.json"; then
          if curl --silent --fail --cacert "$receipt/ca.crt" --max-time 10 "$(cat "$receipt/url")/__qa/status" >/dev/null; then
            touch "$receipt/confirmed"
            [[ $ctx == lab ]] || remote touch "$vmroot/.delegados/v4/recibos/$OWNER/$name/confirmed"
            trap - INT TERM HUP
            printf 'Arriba (%s): %s\nUsuario: %s@example.test\nContraseña: %s/password (0600)\n' "$ctx" "$(cat "$receipt/url")" "$prefix" "$receipt"
            exit 0
          fi
        fi
      fi
      sleep 1
    done
    abort_up
    printf 'Venció el plazo de arranque; consulta %s/supervisor.log\n' "$receipt" >&2
    exit 1
    ;;
  status)
    read_context || { printf 'Abajo: %s\n' "$name"; exit 1; }
    assert_vm
    if [[ -n $(lab ps -q --filter "name=^/$prefix-runner$" --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") ]] \
      && curl --silent --fail --cacert "$receipt/ca.crt" --max-time 10 "$(cat "$receipt/url")/__qa/status" >/dev/null; then
      printf 'Arriba (%s): %s\n' "$ctx" "$(cat "$receipt/url")"
    else printf 'Abajo o incompleto: %s\n' "$name"; exit 1; fi
    ;;
  down)
    exec 9>"$receipt/command.lock"
    flock -n 9 || { printf 'Otra orden usa este nombre\n' >&2; exit 75; }
    read_context || { printf 'No hay contexto registrado para %s\n' "$name"; exit 1; }
    assert_vm
    vmroot=$ROOT; [[ $ctx == lab ]] || vmroot=/tmp/$prefix-checkout
    touch "$receipt/stop"
    [[ $ctx == lab ]] || remote touch "$vmroot/.delegados/v4/recibos/$OWNER/$name/stop"
    if [[ -n $(lab ps -aq --filter "name=^/$prefix-runner$" --filter "label=cauce.e2e.owner=$OWNER" --filter "label=cauce.qa.name=$name") ]]; then
      lab stop -t 90 "$prefix-runner" >/dev/null
    fi
    for ((attempt=0; attempt<120; attempt++)); do
      [[ ! -f $receipt/supervisor.exit ]] || break
      sleep 1
    done
    sync_receipts || true
    stop_and_reclaim
    remove_resources
    assert_empty
    remote rm -rf -- "$vmroot/.delegados/v4/recibos/$OWNER/$name/private"
    rm -rf -- "$receipt/private"
    printf '{"status":"down","context":"%s","containers":0,"networks":0,"volumes":0,"images":0}\n' "$ctx" > "$receipt/down.json"
    printf 'Abajo; verificado: 0 contenedores, redes, volúmenes e imágenes con owner/instancia.\n'
    ;;
  *) printf 'Orden inválida: %s\n' "$action" >&2; exit 2 ;;
esac
