#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/fault-compose.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"

if [[ ${1:-} == inspect ]]; then
  if [[ -f $FAKE_DOCKER_RESTARTED ]]; then printf '202\n'; else printf '101\n'; fi
  exit 0
fi
[[ ${1:-} == compose ]] || exit 64
shift
if [[ ${1:-} == version ]]; then exit 0; fi
while [[ ${1:-} == -f || ${1:-} == --env-file ]]; do shift 2; done
case "${1:-}" in
  ps) printf '%064d\n' 1 ;;
  kill) ;;
  up) : >"$FAKE_DOCKER_RESTARTED" ;;
  *) exit 64 ;;
esac
SH
chmod +x "$tmp/bin/docker"
: >"$tmp/dev.env"

failures=0
run_case() {
  local name=$1 expected_status=$2 expected_text=$3 stack=$4 target=$5 confirmation=$6 env_file=$7
  local output status
  rm -f "$tmp/restarted" "$tmp/docker.log"
  set +e
  if [[ -n $env_file ]]; then
    output=$(env CAUCE_COMPOSE_TARGET="$stack" CAUCE_FAULT_CONFIRM="$confirmation" \
      CAUCE_ENV_FILE="$env_file" CAUCE_FAULT_HOLD_SECONDS=0 \
      FAKE_DOCKER_LOG="$tmp/docker.log" FAKE_DOCKER_RESTARTED="$tmp/restarted" \
      PATH="$tmp/bin:$PATH" "$SCRIPT" "$target" 2>&1)
  else
    output=$(env -u CAUCE_ENV_FILE CAUCE_COMPOSE_TARGET="$stack" CAUCE_FAULT_CONFIRM="$confirmation" \
      CAUCE_FAULT_HOLD_SECONDS=0 FAKE_DOCKER_LOG="$tmp/docker.log" \
      FAKE_DOCKER_RESTARTED="$tmp/restarted" PATH="$tmp/bin:$PATH" \
      "$SCRIPT" "$target" 2>&1)
  fi
  status=$?
  set -e

  if [[ $status -ne $expected_status || $output != *"$expected_text"* ]]; then
    printf 'not ok - %s (status=%s output=%q)\n' "$name" "$status" "$output" >&2
    failures=$((failures + 1))
  else
    printf 'ok - %s\n' "$name"
  fi
}

targets=(gateway postgres telegram-bridge relay-worker)
for target in "${targets[@]}"; do
  run_case "test/$target is ephemeral" 0 "service=$target stack=test" test "$target" ephemeral-only ''
  run_case "dev/$target needs env" 1 'CAUCE_ENV_FILE is required for dev/prod fault injection' dev "$target" ephemeral-only ''
  run_case "dev/$target with env remains allowed" 0 "service=$target stack=dev" dev "$target" ephemeral-only "$tmp/dev.env"
  run_case "prod/$target needs env" 1 'CAUCE_ENV_FILE is required for dev/prod fault injection' prod "$target" ephemeral-only ''
  run_case "prod/$target rejects ephemeral confirmation" 2 'ephemeral-only cannot target prod' prod "$target" ephemeral-only "$tmp/dev.env"
done

run_case 'unsupported service is rejected' 2 'unsupported fault target' test dispatcher ephemeral-only ''
run_case 'unsupported stack is rejected' 2 'unsupported compose target: staging' staging gateway ephemeral-only ''

(( failures == 0 )) || exit 1
printf 'fault-compose policy matrix passed\n'
