#!/usr/bin/env bash
# SSH is isolated so validation failures cannot reach an operator host.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$HERE/../cli/cauce-reponer"
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CAUCE_TEST_SSH_ARGS"
printf '%s\n' "${CAUCE_TEST_HTTP_STATUS:-200}" '{"delivery_id":"fixture-replay"}'
SH
chmod 700 "$WORK/bin/ssh"
export PATH="$WORK/bin:$PATH" CAUCE_TEST_SSH_ARGS="$WORK/ssh-args"

for gateway in unset empty; do
  rc=0
  if [ "$gateway" = unset ]; then
    output=$(env -u CAUCE_GATEWAY bash "$CLI" a-b-c-d-e 2>&1) || rc=$?
  else
    output=$(CAUCE_GATEWAY='' bash "$CLI" a-b-c-d-e 2>&1) || rc=$?
  fi
  [ "$rc" = 2 ] || { printf 'FAIL: %s gateway exited %s instead of 2\n' "$gateway" "$rc" >&2; exit 1; }
  [[ $output == *'falta CAUCE_GATEWAY'* ]] || { printf 'FAIL: missing gateway variable was not named\n' >&2; exit 1; }
  [ ! -e "$WORK/ssh-args" ] || { printf 'FAIL: missing gateway reached SSH\n' >&2; exit 1; }
  printf 'ok: %s gateway fails before SSH and names CAUCE_GATEWAY\n' "$gateway"
done

for delivery in '' invalid; do
  rc=0
  env -u CAUCE_GATEWAY bash "$CLI" "$delivery" > "$WORK/output" 2>&1 || rc=$?
  [ "$rc" = 2 ] && [ ! -e "$WORK/ssh-args" ] || { printf 'FAIL: invalid delivery reached SSH\n' >&2; exit 1; }
done
printf 'ok: missing and invalid delivery ids fail before SSH\n'

output=$(CAUCE_GATEWAY=https://gateway.example.invalid:8443 bash "$CLI" a-b-c-d-e 2>&1)
[[ $output == *'entrega nueva: fixture-replay'* ]] || { printf 'FAIL: configured replay did not report success\n' >&2; exit 1; }
grep -Fq 'https://gateway.example.invalid:8443/v3/console/deliveries/a-b-c-d-e/replay' "$WORK/ssh-args" \
  || { printf 'FAIL: configured gateway did not reach the replay request\n' >&2; exit 1; }
printf 'ok: configured gateway reaches the replay request\n'

rc=0
output=$(CAUCE_GATEWAY=https://gateway.example.invalid:8443 CAUCE_TEST_HTTP_STATUS=409 bash "$CLI" a-b-c-d-e 2>&1) || rc=$?
[ "$rc" = 1 ] && [[ $output == *'HTTP 409'* ]] || { printf 'FAIL: replay conflict was not reported\n' >&2; exit 1; }
printf 'ok: replay conflict exits 1 and reports HTTP 409\n'
printf 'ALL OK\n'
