#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted needles below are meant to stay literal
# Empty aliases must not be forwarded as arguments.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$HERE/../cli/cauce"

fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1" >&2; fail=1; }
assert_eq() { # $1=got $2=want $3=msg
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got='$1' want='$2')"; fi
}

WORK=$(mktemp -d)
# shellcheck disable=SC2329,SC2317  # invoked indirectly, via the EXIT trap below
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/runtime_key_de" <<'EOF'
#!/usr/bin/env bash
printf 'physical-%s\n' "$1"
EOF
chmod +x "$BIN/runtime_key_de"
for n in cauce-estado cauce-sesiones; do
  cat > "$BIN/$n" <<EOF
#!/usr/bin/env bash
printf '$n'
for a in "\$@"; do printf ' <%s>' "\$a"; done
printf '\n'
EOF
  chmod +x "$BIN/$n"
done

extraer() { grep -m1 "^$1()" "$CLI"; }
llamar() {  # $1=function name, resto=arguments
  local f=$1; shift
  ( export PATH="$BIN:$PATH"; eval "$(extraer "$f")"; "$f" "$@" )
}

for f in cmd_estado cmd_sesiones; do
  case "$(extraer "$f")" in
    *'$BIN/ia'*) bad "$f ya no delega en el inexistente \$BIN/ia" ;;
    *) ok "$f ya no delega en el inexistente \$BIN/ia" ;;
  esac
done

assert_eq "$(llamar cmd_estado zeus)" "cauce-estado <physical-zeus>" "cauce <alias> estado -> cauce-estado <runtime-key>"
assert_eq "$(llamar cmd_estado)" "cauce-estado" "cauce estado sin alias -> cauce-estado sin argumentos"
assert_eq "$(llamar cmd_estado '')" "cauce-estado" "el alias VACIO no se reenvia: seria un agente llamado ''"
assert_eq "$(llamar cmd_sesiones zeus)" "cauce-sesiones <zeus>" "cauce <alias> sesiones -> cauce-sesiones <alias>"

case "$(grep -m1 '""|flota|estado)' "$CLI")" in
  *cmd_estado*cmd_flota*) ok "el despachador manda 'estado' a cmd_estado y el resto a cmd_flota" ;;
  *) bad "el despachador manda 'estado' a cmd_estado y el resto a cmd_flota" ;;
esac

if grep -q 'exec python3 "\$BIN/cauce-attach"' "$CLI"; then
  ok "el attach exclusivo sigue cayendo en cauce-attach, no en un bash -l pelado"
else
  bad "el attach exclusivo sigue cayendo en cauce-attach, no en un bash -l pelado"
fi

[ "$fail" = 0 ] && echo "ALL OK"
exit "$fail"
