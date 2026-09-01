#!/usr/bin/env bash
# `cauce <alias> aprovisionar` must also emit the PTY channel plane (sub-pieces 3b/3c/3d):
# client cert, relay identity registry and launcher env. Dry-run must announce each step as
# 'haria:' WITHOUT writing anything, and an already-provisioned alias must skip every sub-piece.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$HERE/../cli/cauce"

fail=0
ok() { printf 'ok: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1" >&2; fail=1; }
assert_contains() { # $1=haystack $2=needle $3=msg
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3 (missing '$2')" ;;
  esac
}
assert_missing() { # $1=path $2=msg
  if [ -e "$1" ]; then bad "$2 (exists: $1)"; else ok "$2"; fi
}

WORK=$(mktemp -d)
# shellcheck disable=SC2329  # invoked indirectly, via the EXIT trap below
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

H="$WORK/home"
OPSDIR="$H/.local/share/cauce-v3/ops"
mkdir -p "$OPSDIR"
cat > "$OPSDIR/flota.json" <<'JSON'
{"fleet": {"probe": {"enabled": true, "tenant": "Test", "role": "agent"}}, "retired": {}}
JSON
openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=test-ca" -days 2 \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null || { echo "FAIL: cannot mint test CA" >&2; exit 1; }
REG="$WORK/reg.json"

corre_dry() {
  HOME="$H" XDG_CONFIG_HOME="$H/.config" \
    CAUCE_CLIENT_CA_CERT="$WORK/ca.crt" CAUCE_CLIENT_CA_KEY="$WORK/ca.key" \
    CAUCE_PTY_RELAY_IDENTITIES="$REG" \
    "$CLI" probe aprovisionar --dry-run 2>&1
}

# --- 1) fresh alias, dry-run: every PTY sub-piece is announced and NOTHING is written --------
salida=$(corre_dry); rc=$?
if [ "$rc" = 0 ]; then ok "dry-run exits 0"; else bad "dry-run exits 0 (rc=$rc)"; fi
assert_contains "$salida" "[3] haria: publish-alias-key.sh --tenant Test --alias probe" "[3] announces the alias key"
assert_contains "$salida" "[3b] haria: emitir clave RSA 4096 + cert CN=pty-probe (365 dias, firmado por $WORK/ca.crt)" "[3b] announces the PTY cert"
assert_contains "$salida" "[3c] haria: anexar {tenant_id=Test, alias=probe, huella, expires_at} en $REG" "[3c] announces the relay registry append"
assert_contains "$salida" "[3d] haria: escribir $H/.config/cauce-v3/pty/probe.env (RELAY_HOST/RELAY_PORT/PKI_DIR/ALIAS_KEY_FILE, modo 600)" "[3d] announces the launcher env"
assert_contains "$salida" "(dry-run, nada se escribio)" "dry-run closes with the no-writes stamp"
assert_missing "$H/.config/cauce-v3/pty-pki" "dry-run created no PTY pki directory"
assert_missing "$H/.config/cauce-v3/pty" "dry-run created no launcher env directory"
assert_missing "$REG" "dry-run created no relay registry"

# --- 2) already-provisioned alias, dry-run: the three PTY sub-pieces are skipped -------------
PKI="$H/.config/cauce-v3/pty-pki/probe"
mkdir -p "$PKI" "$H/.config/cauce-v3/pty"
openssl rand -hex 32 > "$PKI/alias-key.hex"; chmod 400 "$PKI/alias-key.hex"
openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=pty-probe" -days 2 \
  -keyout "$PKI/client.key" -out "$PKI/client.crt" 2>/dev/null
cp "$WORK/ca.crt" "$PKI/ca.crt"; chmod 600 "$PKI"/client.* "$PKI/ca.crt"
fp=$(openssl x509 -in "$PKI/client.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)
printf '{"version":1,"agents":[{"tenant_id":"Test","alias":"probe","fingerprint_sha256":"%s","expires_at":"x"}]}\n' "$fp" > "$REG"
printf 'RELAY_HOST=100.64.0.6\nRELAY_PORT=8445\nPKI_DIR=%s\nALIAS_KEY_FILE=%s/alias-key.hex\n' "$PKI" "$PKI" > "$H/.config/cauce-v3/pty/probe.env"
chmod 600 "$H/.config/cauce-v3/pty/probe.env"
reg_antes=$(sha256sum "$REG")

salida=$(corre_dry); rc=$?
if [ "$rc" = 0 ]; then ok "dry-run over provisioned alias exits 0"; else bad "dry-run over provisioned alias exits 0 (rc=$rc)"; fi
assert_contains "$salida" "[3] $PKI/alias-key.hex ya existe (se salta)" "[3] skips the existing alias key"
assert_contains "$salida" "[3b] $PKI/client.crt ya existe y no esta vencido (se salta)" "[3b] skips the valid PTY cert"
assert_contains "$salida" "[3c] la huella de pty-probe ya esta en $REG (se salta)" "[3c] skips the registered fingerprint"
assert_contains "$salida" "[3d] $H/.config/cauce-v3/pty/probe.env ya existe (se salta)" "[3d] skips the existing launcher env"
if [ "$reg_antes" = "$(sha256sum "$REG")" ]; then
  ok "the relay registry was not rewritten"
else
  bad "the relay registry was rewritten"
fi

if [ "$fail" = 0 ]; then echo "ALL OK"; else echo "SOME FAILED"; fi
exit "$fail"
