#!/usr/bin/env bash
# Issue the mTLS leaf `agent-<alias>` for one fleet agent, signed by the local CA.
# The allowlist is the fleet snapshot (ops/flota.json): an alias that is not in the fleet
# cannot get an identity. Same atomic publication as provision-terminal-client.sh:
# nothing is ever overwritten, the key/cert pair lands all-or-nothing.
set -euo pipefail

usage() {
  printf 'usage: provision-agent-identity.sh ALIAS OUTPUT_DIR\n  env: CAUCE_CLIENT_CA_CERT, CAUCE_CLIENT_CA_KEY (defaults: /etc/cauce-v3/pki/ca.{crt,key})\n' >&2
  exit 2
}
[[ $# -eq 2 ]] || usage
alias_name=$1
output_dir=$2
[[ $alias_name =~ ^[a-z][a-z0-9.-]*$ ]] || { printf 'agent identity failed: invalid alias\n' >&2; exit 2; }

ops_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
snapshot=$ops_root/flota.json
[[ -f $snapshot ]] || { printf 'agent identity failed: %s is missing; export the fleet snapshot first\n' "$snapshot" >&2; exit 2; }
python3 - "$snapshot" "$alias_name" <<'PY' || { printf 'agent identity failed: alias is not in the fleet snapshot (retired or unknown)\n' >&2; exit 2; }
import json, sys
snapshot, alias = sys.argv[1], sys.argv[2]
fleet = json.load(open(snapshot))["fleet"]
sys.exit(0 if alias in fleet and fleet[alias].get("enabled") is True else 1)
PY

client_cn=agent-$alias_name
ca_cert=${CAUCE_CLIENT_CA_CERT:-/etc/cauce-v3/pki/ca.crt}
ca_key=${CAUCE_CLIENT_CA_KEY:-/etc/cauce-v3/pki/ca.key}
[[ $ca_cert == /* && -f $ca_cert && ! -L $ca_cert ]] || { printf 'agent identity failed: CA cert must be an absolute regular non-symlink file\n' >&2; exit 2; }
[[ $ca_key == /* && -f $ca_key && ! -L $ca_key ]] || { printf 'agent identity failed: CA key must be an absolute regular non-symlink file\n' >&2; exit 2; }
[[ $output_dir == /* && ! -L $output_dir ]] || { printf 'agent identity failed: output directory must be absolute and not a symlink\n' >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { printf 'agent identity failed: openssl is unavailable\n' >&2; exit 127; }
command -v flock >/dev/null 2>&1 || { printf 'agent identity failed: flock is unavailable\n' >&2; exit 127; }

umask 077
install -d -m 0700 -- "$output_dir"
exec 9>"$output_dir/.agent-identity-provision.lock"
flock -x 9

final_key=$output_dir/$client_cn.key
final_cert=$output_dir/$client_cn.crt
[[ ! -e $final_key && ! -L $final_key && ! -e $final_cert && ! -L $final_cert ]] || {
  printf 'agent identity failed: %s already has an identity; nothing was overwritten (rotate explicitly)\n' "$client_cn" >&2
  exit 1
}

work=$(mktemp -d "$output_dir/.${client_cn}.XXXXXX")
published_key=0
published_cert=0
cleanup() {
  status=$?
  rm -rf -- "$work"
  if ((status != 0)); then
    ((published_cert == 0)) || rm -f -- "$final_cert"
    ((published_key == 0)) || rm -f -- "$final_key"
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

openssl x509 -in "$ca_cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$ca_cert" -noout -text | grep -q 'CA:TRUE' || { printf 'agent identity failed: signer is not a CA\n' >&2; exit 1; }
openssl x509 -in "$ca_cert" -pubkey -noout >"$work/ca-cert.pub"
openssl pkey -in "$ca_key" -pubout >"$work/ca-key.pub" 2>/dev/null
cmp -s "$work/ca-cert.pub" "$work/ca-key.pub" || { printf 'agent identity failed: CA cert/key do not match\n' >&2; exit 1; }

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/client.key" >/dev/null 2>&1
openssl req -new -sha256 -key "$work/client.key" -subj "/CN=$client_cn" -out "$work/client.csr"
printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=clientAuth' \
  'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid,issuer' >"$work/client.ext"
serial=$(openssl rand -hex 16)
openssl x509 -req -sha256 -in "$work/client.csr" -CA "$ca_cert" -CAkey "$ca_key" \
  -set_serial "0x$serial" -days 730 -extfile "$work/client.ext" -out "$work/client.crt" >/dev/null 2>&1
openssl verify -purpose sslclient -CAfile "$ca_cert" "$work/client.crt" >/dev/null
openssl x509 -in "$work/client.crt" -noout -text | grep -q 'TLS Web Client Authentication' || { printf 'agent identity failed: leaf lacks clientAuth EKU\n' >&2; exit 1; }
subject=$(openssl x509 -in "$work/client.crt" -noout -subject -nameopt RFC2253)
[[ $subject == "subject=CN=$client_cn" ]] || { printf 'agent identity failed: wrong CN issued\n' >&2; exit 1; }

chmod 0400 "$work/client.key"
chmod 0444 "$work/client.crt"
ln "$work/client.key" "$final_key"
published_key=1
ln "$work/client.crt" "$final_cert"
published_cert=1
printf 'agent identity issued: %s -> %s (key 0400, cert 0444, serial %s)\n' "$client_cn" "$output_dir" "$serial"
