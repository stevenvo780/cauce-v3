#!/usr/bin/env bash
# Provisioning uses isolated fixtures; no production credentials or hosts are accessed.
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
# shellcheck disable=SC2329,SC2317  # invoked indirectly, via the EXIT trap below
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

H="$WORK/home"
OPSDIR="$H/.local/share/cauce-v3/ops"
mkdir -p "$OPSDIR/scripts"
cp "$HERE/../scripts/"{container-alias-query.py,container_alias_lib.py,fleet_derive.py,fleet_runtime_inventory.py} "$OPSDIR/scripts/"
cat > "$OPSDIR/flota.json" <<'JSON'
{"schemaVersion":1,"fleet":{"probe":{"enabled":true,"tenant":"Test","role":"agent","room":"grp.test","harness":"codex","container":"fixture-probe","user":"dev","home":"/home/dev","runtimeStateDirectory":"/home/dev/.local/state/cauce-v3/probe"}},"retired":{}}
JSON
openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=test-ca" -days 2 \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null || { echo "FAIL: cannot mint test CA" >&2; exit 1; }
REG="$WORK/reg.json"
OPS="$OPSDIR"
c_err='' c_reset='' c_dim='' c_warn='' c_b='' c_ok=''
# shellcheck source=../cli/cauce-credenciales.lib.sh
source "$HERE/../cli/cauce-credenciales.lib.sh"

corre_dry() (
  # shellcheck disable=SC2329,SC2317
  getent() { printf 'test:x:1000:1000::%s:/bin/bash\n' "$HOME"; }
  export -f getent
  HOME="$H" XDG_CONFIG_HOME="$H/.config" \
    CAUCE_CLIENT_CA_CERT="$WORK/ca.crt" CAUCE_CLIENT_CA_KEY="$WORK/ca.key" \
    CAUCE_PTY_RELAY_IDENTITIES="$REG" \
    CAUCE_PTY_RELAY_HOST="${TEST_RELAY_HOST-relay.example.invalid}" CAUCE_PTY_RELAY_PORT=9445 \
    "$CLI" probe aprovisionar --dry-run 2>&1
)

salida=$(corre_dry); rc=$?
if [ "$rc" = 0 ]; then ok "dry-run exits 0"; else bad "dry-run exits 0 (rc=$rc)"; fi
assert_contains "$salida" "[3] haria: publish-alias-key.sh --tenant Test --alias probe" "[3] announces the alias key"
assert_contains "$salida" "[3b] haria: emitir clave RSA 4096 + cert CN=pty-probe (365 dias, firmado por $WORK/ca.crt)" "[3b] announces the PTY cert"
assert_contains "$salida" "[3c] haria: anexar {tenant_id=Test, alias=probe, huella, expires_at} en $REG" "[3c] announces the relay registry append"
assert_contains "$salida" "[3d] haria: escribir $H/.config/cauce-v3/pty/probe.env (RELAY_HOST=relay.example.invalid RELAY_PORT=9445, PKI_DIR/ALIAS_KEY_FILE, modo 600)" "[3d] announces the configured relay and launcher env"
assert_contains "$salida" "(dry-run, nada se escribio)" "dry-run closes with the no-writes stamp"
assert_missing "$H/.config/cauce-v3/pty-pki" "dry-run created no PTY pki directory"
assert_missing "$H/.config/cauce-v3/pty" "dry-run created no launcher env directory"
assert_missing "$REG" "dry-run created no relay registry"

salida=$(TEST_RELAY_HOST='' corre_dry); rc=$?
if [ "$rc" = 1 ]; then ok "dry-run without relay host exits 1"; else bad "dry-run without relay host exits 1 (rc=$rc)"; fi
assert_contains "$salida" "falta CAUCE_PTY_RELAY_HOST" "dry-run names the missing relay host variable"
assert_missing "$H/.config/cauce-v3/pty" "failed dry-run created no launcher env directory"

cat > "$OPSDIR/scripts/provision-agent-identity.sh" <<'SH'
#!/usr/bin/env bash
printf 'called\n' > "$CAUCE_TEST_WRITES"
exit 1
SH
chmod 700 "$OPSDIR/scripts/provision-agent-identity.sh"

provision_invalid_relay() (
  HOME="$H" XDG_CONFIG_HOME="$H/.config"
  PKI_ROOT_AGENTE="$WORK/agent-pki"
  TOKENS_DIR_ALIAS="$WORK/tokens"
  IDENTIDADES_DIR="$WORK/identities"
  export CAUCE_TEST_WRITES="$WORK/provision-writes"
  CAUCE_CLIENT_CA_CERT="$WORK/ca.crt" CAUCE_CLIENT_CA_KEY="$WORK/ca.key" \
    CAUCE_PTY_RELAY_HOST=$1 CAUCE_PTY_RELAY_PORT=$2 cmd_aprovisionar probe 2>&1
)

for invalid in missing-host invalid-host invalid-port; do
  case "$invalid" in
    missing-host) host='' port=8445 variable=CAUCE_PTY_RELAY_HOST ;;
    invalid-host) host=$'relay.example.invalid\nRELAY_PORT=1' port=8445 variable=CAUCE_PTY_RELAY_HOST ;;
    invalid-port) host=relay.example.invalid port=65536 variable=CAUCE_PTY_RELAY_PORT ;;
  esac
  salida=$(provision_invalid_relay "$host" "$port"); rc=$?
  if [ "$rc" = 1 ]; then ok "provision rejects $invalid"; else bad "provision accepted $invalid (rc=$rc)"; fi
  assert_contains "$salida" "$variable" "provision names $variable before issuing credentials"
  assert_missing "$WORK/provision-writes" "provision with $invalid called no credential writer"
  assert_missing "$WORK/agent-pki" "provision with $invalid created no mTLS material"
  assert_missing "$WORK/tokens" "provision with $invalid created no bearer token"
  assert_missing "$WORK/identities" "provision with $invalid created no identity registry"
  assert_missing "$H/.config/cauce-v3/pty-pki" "provision with $invalid created no PTY key or certificate"
  assert_missing "$REG" "provision with $invalid created no relay registry"
  rm -f -- "$WORK/provision-writes"
done

PKI="$H/.config/cauce-v3/pty-pki/probe"
mkdir -p "$PKI" "$H/.config/cauce-v3/pty"
openssl rand -hex 32 > "$PKI/alias-key.hex"; chmod 400 "$PKI/alias-key.hex"
openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=pty-probe" -days 2 \
  -keyout "$PKI/client.key" -out "$PKI/client.crt" 2>/dev/null
cp "$WORK/ca.crt" "$PKI/ca.crt"; chmod 600 "$PKI"/client.* "$PKI/ca.crt"
fp=$(openssl x509 -in "$PKI/client.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)
printf '{"version":1,"agents":[{"tenant_id":"Test","alias":"probe","fingerprint_sha256":"%s","expires_at":"x"}]}\n' "$fp" > "$REG"
printf 'RELAY_HOST=relay.example.invalid\nRELAY_PORT=8445\nPKI_DIR=%s\nALIAS_KEY_FILE=%s/alias-key.hex\n' "$PKI" "$PKI" > "$H/.config/cauce-v3/pty/probe.env"
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

env_antes=$(sha256sum "$H/.config/cauce-v3/pty/probe.env")
salida=$(TEST_RELAY_HOST='' corre_dry); rc=$?
if [ "$rc" = 0 ]; then ok "provisioned alias needs no relay variable"; else bad "provisioned alias failed without relay variable (rc=$rc)"; fi
assert_contains "$salida" "[3d] $H/.config/cauce-v3/pty/probe.env ya existe (se salta)" "existing launcher env skips relay validation"
if [ "$env_antes" = "$(sha256sum "$H/.config/cauce-v3/pty/probe.env")" ]; then
  ok "existing launcher env was preserved without relay variable"
else
  bad "existing launcher env changed without relay variable"
fi

write_fixture_env() (
  HOME="$H" XDG_CONFIG_HOME="$H/.config"
  unset CAUCE_PTY_RELAY_HOST CAUCE_PTY_RELAY_PORT
  [ -z "$2" ] || CAUCE_PTY_RELAY_HOST=$2
  [ -z "$3" ] || CAUCE_PTY_RELAY_PORT=$3
  write_pty_launcher_env "$H/.config/cauce-v3/pty/$1.env" "$PKI" "$PKI/alias-key.hex" 0 2>&1
)

salida=$(write_fixture_env probe '' ''); rc=$?
if [ "$rc" = 0 ]; then ok "env writer skips existing env without relay variable"; else bad "env writer failed for existing env (rc=$rc)"; fi
assert_contains "$salida" "ya existe (se salta)" "env writer reports the preserved env"

for port in '' 9445; do
  alias_name="port-${port:-default}"
  salida=$(write_fixture_env "$alias_name" relay.example.invalid "$port"); rc=$?
  if [ "$rc" = 0 ]; then ok "configured relay writes env (port=${port:-default})"; else bad "configured relay writes env (rc=$rc)"; fi
  env_path="$H/.config/cauce-v3/pty/$alias_name.env"
  printf 'RELAY_HOST=relay.example.invalid\nRELAY_PORT=%s\nPKI_DIR=%s\nALIAS_KEY_FILE=%s/alias-key.hex\n' \
    "${port:-8445}" "$PKI" "$PKI" > "$WORK/expected-env"
  if cmp -s "$env_path" "$WORK/expected-env"; then ok "env contains the relay and PKI values"; else bad "incorrect launcher env"; fi
  if [ "$(stat -c %a "$env_path" 2>/dev/null)" = 600 ]; then ok "launcher env mode is 600"; else bad "launcher env mode is not 600"; fi
done

salida=$(write_fixture_env missing-host '' ''); rc=$?
if [ "$rc" = 1 ]; then ok "missing relay host exits 1"; else bad "missing relay host exits 1 (rc=$rc)"; fi
assert_contains "$salida" "[3d] falta CAUCE_PTY_RELAY_HOST" "error names the required relay host variable"
assert_missing "$H/.config/cauce-v3/pty/missing-host.env" "missing relay host created no env"
assert_missing "$H/.config/cauce-v3/pty/missing-host.env.tmp" "missing relay host created no temporary env"

salida=$(write_fixture_env invalid-host $'relay.example.invalid\nRELAY_PORT=1' ''); rc=$?
if [ "$rc" = 1 ]; then ok "relay host with an injected env line is rejected"; else bad "invalid relay host was accepted (rc=$rc)"; fi
assert_contains "$salida" "CAUCE_PTY_RELAY_HOST" "invalid host error names the variable"
assert_missing "$H/.config/cauce-v3/pty/invalid-host.env" "invalid relay host created no env"

for port in 0 65536 text; do
  salida=$(write_fixture_env invalid-port relay.example.invalid "$port"); rc=$?
  if [ "$rc" = 1 ]; then ok "invalid relay port is rejected ($port)"; else bad "invalid relay port was accepted ($port, rc=$rc)"; fi
  assert_contains "$salida" "CAUCE_PTY_RELAY_PORT" "invalid port error names the variable"
  assert_missing "$H/.config/cauce-v3/pty/invalid-port.env" "invalid relay port created no env"
done

if [ "$fail" = 0 ]; then echo "ALL OK"; else echo "SOME FAILED"; fi
exit "$fail"
