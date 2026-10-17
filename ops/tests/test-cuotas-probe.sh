#!/usr/bin/env bash
# La sonda vieja no entiende --refresh-own-session: cuotas solo lo pasa si el texto del contenedor lo nombra.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CUOTAS=$(cd "$HERE/.." && pwd)/cuotas/cuotas
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail=0

run_case() {  # $1 probe body  $2 expected extra arg or empty  $3 detection mode
  local probe=$1 expect=$2 mode=${3:-normal}
  mkdir -p "$WORK/bin" "$WORK/probe"
  printf '%s\n' "$probe" > "$WORK/probe/codex-http-probe.py"
  cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$CUOTAS_LOG"
if [ "$1" = ps ]; then printf 'zz-canary-codex-sample\n'; exit 0; fi
if [ "$1" = exec ]; then
  if [ "$3" = test ]; then exit 0; fi
  if [[ "$*" == *'python3 -I -c'* ]]; then
    case "${CUOTAS_DETECTION_MODE:-normal}" in
      error) printf 'synthetic detection error\n' >&2; exit 1 ;;
      hang) exec sleep 30 ;;
    esac
    python3 -I -c 'import pathlib,sys; text=pathlib.Path(sys.argv[1]).read_text(errors="replace"); sys.exit(0 if "--refresh-own-session" in text else 1)' "$CUOTAS_PROBE"
    exit $?
  fi
  if [[ "$*" == *codex-http-probe.py* ]]; then
    printf '%s\n' '{"identidad":"fixture","plan":"test","ventanas":[{"clave":"7d","usado_pct":1}]}'
    exit 0
  fi
  printf '%s\n' '{"ok":false,"nota":"lector ajeno"}'
  exit 0
fi
exit 97
EOF
  chmod 755 "$WORK/bin/docker"
  : > "$WORK/log"
  PATH="$WORK/bin:$PATH" CUOTAS_LOG="$WORK/log" CUOTAS_PROBE="$WORK/probe/codex-http-probe.py" \
    CUOTAS_DETECTION_MODE="$mode" bash "$CUOTAS" --json > "$WORK/out" 2> "$WORK/err"
  probe_line=$(grep 'codex-http-probe.py /home/node/.codex' "$WORK/log" | tail -1 || true)
  if [ "$expect" = yes ] && [[ $probe_line == *'--refresh-own-session' ]]; then
    printf 'ok: pasa el flag\n'
  elif [ "$expect" = no ] && [[ -n $probe_line && $probe_line != *'--refresh-own-session' ]]; then
    printf 'ok: omite el flag\n'
  else
    printf 'FAIL: expected flag=%s\n%s\n' "$expect" "$(cat "$WORK/log")" >&2
    fail=1
  fi
  if [ ! -s "$WORK/err" ] && python3 - "$WORK/out" <<'PY'
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1])]
assert any(row.get('provider') == 'codex' and row.get('identidad') == 'fixture' for row in rows)
PY
  then
    printf 'ok: detección %s sin ruido y con lectura JSON válida\n' "$mode"
  else
    printf 'FAIL: detección %s sin ruido y con lectura JSON válida\n' "$mode" >&2
    fail=1
  fi
}

run_case 'def main(): pass' no
run_case 'flag = "--refresh-own-session"' yes
run_case 'flag = "--refresh-own-session"' no error
run_case 'flag = "--refresh-own-session"' no hang
exit "$fail"
