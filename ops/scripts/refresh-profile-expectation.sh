#!/usr/bin/env bash
# Re-registers the alias native-profile runtime expectation against the live container
# incarnation. Rationale and rollback: runbooks/container-adapters.md.
set -euo pipefail

readonly DEADLINE_SECONDS=${CAUCE_PROFILE_EXPECTATION_DEADLINE:-300}
readonly POLL_SECONDS=${CAUCE_PROFILE_EXPECTATION_POLL:-10}
readonly CONFIG_ROOT=${CAUCE_CONTAINER_CONFIG_ROOT:-$HOME/.config/cauce-v3/container-aliases}

log() { printf 'refresh-profile-expectation: %s\n' "$1" >&2; }
die() { log "$1"; exit "${2:-1}"; }

alias_name=${1:-}
[[ $alias_name =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die 'alias is missing or not a safe identifier' 2

config="$CONFIG_ROOT/$alias_name.env"
# Absence is not a fault: an alias may legitimately have no container config on this host.
[[ -f $config ]] || { log "no container config for $alias_name; nothing to refresh"; exit 0; }

read_key() {
  local value
  value=$(sed -n "s/^$1=//p" "$config" | tail -n 1 | tr -d '\r')
  printf '%s' "$value"
}

pki_dir=$(read_key PKI_DIR)
relay_url=$(read_key RELAY_URL)
[[ -n $pki_dir ]] || die 'container config declares no PKI_DIR' 2

# Nothing here copies credential material: curl opens the files the adapter already uses, and the
# alias own certificate is the whole authorization this call carries.
cert="$pki_dir/client.crt"
key="$pki_dir/client.key"
ca="$pki_dir/ca.crt"
for path in "$cert" "$key" "$ca"; do
  [[ -f $path ]] || die "alias PKI file is missing: ${path##*/}" 2
done

if [[ -n ${CAUCE_PROFILE_EXPECTATION_URL:-} ]]; then
  gateway=$CAUCE_PROFILE_EXPECTATION_URL
else
  [[ -n $relay_url ]] || die 'container config declares no RELAY_URL and no override was given' 2
  # The relay and the console share one listener; only the scheme and the path differ.
  gateway=${relay_url%/v3/ws}
  gateway=https://${gateway#wss://}
  gateway=${gateway#https://https://}
fi
[[ $gateway =~ ^https://[A-Za-z0-9._:-]+$ ]] || die 'gateway URL derived from RELAY_URL is not usable' 2

# Alias-self reload: no tenant in the path and an EMPTY body, so nothing here can name a person.
route="/v3/console/agents/$alias_name/context/reload"
body=$(mktemp) || die 'cannot create a temporary file'
trap 'rm -f "$body"' EXIT

answer_of() {
  python3 -c '
import json
import re
import sys


def token(value: object, fallback: str) -> str:
    text = value if isinstance(value, str) else ""
    return text if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", text) else fallback


try:
    document = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    print("unreadable - unreadable_body")
    raise SystemExit(0)
if not isinstance(document, dict):
    print("unreadable - unreadable_body")
    raise SystemExit(0)
verification = document.get("runtime_verification")
verification = verification if isinstance(verification, dict) else {}
print(
    token(verification.get("state"), "absent"),
    token(verification.get("generation"), "-"),
    token(document.get("error"), "-"),
)
' "$body"
}

# Refusals no retry lifts: wrong caller, alias off, or files quarantined until a person looks.
terminal() {
  case "$1" in 400|401|403|404) return 0 ;; esac
  case "$2" in agent_disabled|context_contaminated) return 0 ;; esac
  return 1
}

state=none
generation=-
failure=-
deadline=$(( SECONDS + DEADLINE_SECONDS ))
attempt=0
while :; do
  attempt=$(( attempt + 1 ))
  code=$(curl -sS --max-time 20 --cert "$cert" --key "$key" --cacert "$ca" \
    -X POST -H 'Content-Length: 0' \
    -o "$body" -w '%{http_code}' "$gateway$route" 2>/dev/null) || code=000
  read -r state generation failure <<<"$(answer_of)"
  if [[ $code == 200 ]]; then
    if [[ $state == current && $generation =~ ^[a-f0-9]{32}$ ]]; then
      log "expectation registered for $alias_name generation=$generation attempts=$attempt"
      exit 0
    fi
    log "attempt $attempt: the reload was accepted but the runtime reads $state"
  elif [[ $code == 409 && $failure == profile_absent ]]; then
    # An alias with no authored profile has no expectation to keep fresh; that is not a fault.
    log "$alias_name has no authored profile; nothing to keep fresh"
    exit 0
  elif terminal "$code" "$failure"; then
    die "reload refused for $alias_name: $failure (HTTP $code); no retry can lift this" 1
  else
    log "attempt $attempt: console answered $code ($failure)"
  fi
  (( SECONDS + POLL_SECONDS < deadline )) || break
  sleep "$POLL_SECONDS"
done

# Loud on purpose: this unit is a sibling of the adapter and cannot harm it, so a visible failure
# beats a silent give-up on an alias that would go deaf the moment the flag is switched on. The
# usual cause is a runtime the gateway cannot measure, i.e. no live pty-agent for this alias.
die "expectation NOT registered for $alias_name after $attempt attempts; last answer=$failure state=$state (runtime not measurable? check cauce-v3-pty@$alias_name)" 1
