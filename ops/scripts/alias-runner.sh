#!/usr/bin/env bash
set -euo pipefail
umask 077

alias_name=${1:?usage: alias-runner.sh ALIAS}
[[ $alias_name =~ ^[a-z][a-z0-9-]*$ ]] || { printf 'invalid alias\n' >&2; exit 2; }
[[ ${CAUCE_ALIAS:-} == "$alias_name" ]] || { printf 'unit alias mismatch\n' >&2; exit 2; }
[[ ${CAUCE_ORIGIN_TRANSPORT:-} == telegram ]] || { printf 'origin transport must be telegram\n' >&2; exit 2; }
[[ ${CAUCE_ENVIRONMENT:-} == production ]] || { printf 'alias runtime must use production transport policy\n' >&2; exit 2; }
[[ ${CAUCE_INSTANCE_ID:-} == "systemd-$alias_name" ]] || { printf 'alias instance id is not stable\n' >&2; exit 2; }
expected_state="/var/lib/cauce-v3/aliases/$alias_name"
[[ ${CAUCE_STATE_DIR:-} == "$expected_state" && -d $expected_state ]] || { printf 'alias state directory is unavailable\n' >&2; exit 2; }
command -v flock >/dev/null 2>&1 || { printf 'flock is required for the local consumer guard\n' >&2; exit 127; }

indirect() {
  local pointer=${1:?} label=${2:?} value
  [[ $pointer =~ ^CAUCE_[A-Z0-9_]+_(PATH|URL)$ ]] || { printf 'invalid %s placeholder\n' "$label" >&2; exit 2; }
  value=${!pointer:-}
  [[ -n $value ]] || { printf '%s PATH/URL placeholder is unset\n' "$label" >&2; exit 2; }
  printf '%s' "$value"
}

relay_url=$(indirect "${CAUCE_RELAY_URL_ENV:?}" relay)
token_path=$(indirect "${CAUCE_TOKEN_PATH_ENV:?}" token)
cert_path=$(indirect "${CAUCE_CERT_PATH_ENV:?}" certificate)
key_path=$(indirect "${CAUCE_KEY_PATH_ENV:?}" key)
ca_path=$(indirect "${CAUCE_CA_PATH_ENV:?}" ca)
executable=$(indirect "${CAUCE_EXEC_PATH_ENV:?}" executable)

if [[ ${CAUCE_HARNESS:-} == hermes ]]; then
  [[ ${CAUCE_OPERATIONAL_MODEL_ENV:-} == HERMES_INFERENCE_MODEL ]] || { printf 'invalid Hermes model selector name\n' >&2; exit 2; }
  [[ -n ${!CAUCE_OPERATIONAL_MODEL_ENV:-} ]] || { printf 'Hermes operational model selector is unset\n' >&2; exit 2; }
elif [[ -n ${CAUCE_OPERATIONAL_MODEL_ENV:-} ]]; then
  printf 'operational model selector is only valid for Hermes\n' >&2
  exit 2
fi

case "$relay_url" in wss://*) ;; *) printf 'adapter relay URL must use wss\n' >&2; exit 2 ;; esac
authority=${relay_url#wss://}; authority=${authority%%/*}
[[ $authority != *"@"* ]] || { printf 'credentials in relay URL are forbidden\n' >&2; exit 2; }
for path in "$token_path" "$cert_path" "$key_path" "$ca_path"; do
  [[ $path == /* && -f $path && -r $path ]] || { printf 'required credential path is not a readable file\n' >&2; exit 2; }
done
[[ $executable == /* && -x $executable && -f $executable ]] || { printf 'alias executable must be an absolute executable wrapper\n' >&2; exit 2; }

export CAUCE_RELAY_URL="$relay_url"
export CAUCE_TOKEN_FILE="$token_path"
export CAUCE_TLS_CERT_FILE="$cert_path"
export CAUCE_TLS_KEY_FILE="$key_path"
export CAUCE_TLS_CA_FILE="$ca_path"
exec 9>"$expected_state/consumer.lock"
flock -n 9 || { printf 'a local consumer or poller already owns this alias\n' >&2; exit 73; }
exec "$executable"
