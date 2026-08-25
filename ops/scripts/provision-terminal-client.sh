#!/usr/bin/env bash
set -euo pipefail

# Issue one of the two dedicated terminal-plane client identities.  The script never reads an
# existing leaf credential, never overwrites one and never prints certificate/key material.
[[ $# == 2 ]] || {
  printf 'usage: CAUCE_CLIENT_CA_CERT=/abs/ca.crt CAUCE_CLIENT_CA_KEY=/abs/ca.key %s <gateway-relay-client|terminal-relay-client> /absolute/output/dir\n' "${0##*/}" >&2
  exit 2
}
client_cn=$1
output_dir=$2
case $client_cn in
  gateway-relay-client|terminal-relay-client) ;;
  *) printf 'terminal client provisioning failed: unsupported client CN\n' >&2; exit 2 ;;
esac

ca_cert=${CAUCE_CLIENT_CA_CERT:-}
ca_key=${CAUCE_CLIENT_CA_KEY:-}
[[ $ca_cert == /* && -f $ca_cert && ! -L $ca_cert ]] || {
  printf 'terminal client provisioning failed: CAUCE_CLIENT_CA_CERT must be an absolute regular non-symlink file\n' >&2
  exit 2
}
[[ $ca_key == /* && -f $ca_key && ! -L $ca_key ]] || {
  printf 'terminal client provisioning failed: CAUCE_CLIENT_CA_KEY must be an absolute regular non-symlink file\n' >&2
  exit 2
}
[[ $output_dir == /* && ! -L $output_dir ]] || {
  printf 'terminal client provisioning failed: output directory must be absolute and not a symlink\n' >&2
  exit 2
}
command -v openssl >/dev/null 2>&1 || {
  printf 'terminal client provisioning failed: openssl is unavailable\n' >&2
  exit 127
}
command -v flock >/dev/null 2>&1 || {
  printf 'terminal client provisioning failed: flock is unavailable\n' >&2
  exit 127
}

umask 077
install -d -m 0700 -- "$output_dir"
exec 9>"$output_dir/.terminal-client-provision.lock"
flock -x 9

final_key=$output_dir/$client_cn.key
final_cert=$output_dir/$client_cn.crt
[[ ! -e $final_key && ! -L $final_key && ! -e $final_cert && ! -L $final_cert ]] || {
  printf 'terminal client provisioning failed: destination credential already exists; nothing was overwritten\n' >&2
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

# Verify the signer itself before creating a leaf.  These commands only compare public keys in
# temporary files and do not emit either key to stdout.
openssl x509 -in "$ca_cert" -noout -checkend 86400 >/dev/null
openssl x509 -in "$ca_cert" -noout -text | grep -q 'CA:TRUE' || {
  printf 'terminal client provisioning failed: signing certificate is not a CA\n' >&2
  exit 1
}
openssl x509 -in "$ca_cert" -pubkey -noout >"$work/ca-cert.pub"
openssl pkey -in "$ca_key" -pubout >"$work/ca-key.pub" 2>/dev/null
cmp -s "$work/ca-cert.pub" "$work/ca-key.pub" || {
  printf 'terminal client provisioning failed: signing certificate/key do not match\n' >&2
  exit 1
}

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
openssl x509 -in "$work/client.crt" -noout -checkend 86400 >/dev/null
openssl x509 -in "$work/client.crt" -noout -text | grep -q 'TLS Web Client Authentication' || {
  printf 'terminal client provisioning failed: issued certificate lacks clientAuth EKU\n' >&2
  exit 1
}
subject=$(openssl x509 -in "$work/client.crt" -noout -subject -nameopt RFC2253)
[[ $subject == "subject=CN=$client_cn" ]] || {
  printf 'terminal client provisioning failed: issued certificate has the wrong CN\n' >&2
  exit 1
}
openssl x509 -in "$work/client.crt" -pubkey -noout >"$work/client-cert.pub"
openssl pkey -in "$work/client.key" -pubout >"$work/client-key.pub" 2>/dev/null
cmp -s "$work/client-cert.pub" "$work/client-key.pub" || {
  printf 'terminal client provisioning failed: issued certificate/key do not match\n' >&2
  exit 1
}

chown 1000:1000 "$work/client.key" "$work/client.crt"
chmod 0400 "$work/client.key"
chmod 0444 "$work/client.crt"
# Hard links publish with O_EXCL-like semantics on the same filesystem.  The lock and cleanup keep
# the pair all-or-nothing for this provisioner, while `ln` still refuses an externally-created path.
ln "$work/client.key" "$final_key"
published_key=1
ln "$work/client.crt" "$final_cert"
published_cert=1

printf 'terminal client provisioning passed: %s issued to private destination (uid 1000, key 0400, cert 0444)\n' "$client_cn"
