#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecutá este aprovisionamiento con sudo" >&2
  exit 1
fi

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
[ "$REPO" = /opt/hospital-cauce ] \
  || { echo "El checkout operativo debe ser /opt/hospital-cauce (actual: $REPO)" >&2; exit 1; }
INSTANCE_ETC=/etc/cauce-v3-hospital
ENV_FILE=$INSTANCE_ETC/prod.env
HOSPITAL_ENV=/opt/hospital-agent/runtime/.env
BUNDLE_ROOT=/opt/cauce-v3-hospital-adapter
CONFIG_ROOT=$INSTANCE_ETC/container-aliases
PKI_ROOT=$INSTANCE_ETC/container-pki
LOCK_ROOT=/run/lock/hospital-cauce
RELAY_URL=wss://172.17.0.1:18443/v3/ws
ALIASES=(operador teseo perseo)

for command in docker openssl python3 systemctl flock; do
  command -v "$command" >/dev/null || { echo "Falta $command" >&2; exit 1; }
done
[ -r "$ENV_FILE" ] || { echo "Falta $ENV_FILE" >&2; exit 1; }
[ -r "$HOSPITAL_ENV" ] || { echo "Falta $HOSPITAL_ENV" >&2; exit 1; }

umask 077
install -d -m 0755 /run/lock
exec 9>/run/lock/hospital-cauce-provision.lock
flock -n 9 || { echo "Ya hay un aprovisionamiento Hospital en ejecución" >&2; exit 75; }
install -d -m 0700 "$BUNDLE_ROOT" "$BUNDLE_ROOT/releases" "$CONFIG_ROOT" "$PKI_ROOT" "$LOCK_ROOT"
temporary=
image_container=
units=
cleanup() {
  if [ -n "$image_container" ]; then docker rm -f "$image_container" >/dev/null 2>&1 || true; fi
  if [ -n "$temporary" ] && [ -d "$temporary" ]; then
    chmod -R u+w "$temporary" 2>/dev/null || true
    rm -rf "$temporary"
  fi
  if [ -n "$units" ] && [ -d "$units" ]; then rm -rf "$units"; fi
}
trap cleanup EXIT

env_value() {
  local file=$1 key=$2
  sed -n "s/^${key}=//p" "$file" | tail -1 | tr -d '\r'
}

set_env() {
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
from pathlib import Path
import os
import sys
import tempfile

path, key, value = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines()
matches = [index for index, line in enumerate(lines) if line.startswith(f"{key}=")]
if len(matches) > 1:
    raise SystemExit(f"duplicate environment key: {key}")
line = f"{key}={value}"
if matches:
    lines[matches[0]] = line
else:
    lines.append(line)
descriptor, temporary = tempfile.mkstemp(prefix=".prod-env-", dir=path.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    Path(temporary).unlink(missing_ok=True)
PY
}

container_for() {
  case "$1" in
    operador) printf 'hospital-agent-openclaw-operator-gateway-1' ;;
    teseo) printf 'hospital-agent-openclaw-backend-gateway-1' ;;
    perseo) printf 'hospital-agent-openclaw-frontend-gateway-1' ;;
    *) return 1 ;;
  esac
}

token_key_for() {
  case "$1" in
    operador) printf 'OPENCLAW_OPERATOR_TOKEN' ;;
    teseo) printf 'OPENCLAW_BACKEND_TOKEN' ;;
    perseo) printf 'OPENCLAW_FRONTEND_TOKEN' ;;
    *) return 1 ;;
  esac
}

state_source_for() {
  case "$1" in
    operador) printf '/opt/hospital-agent/runtime/state-operator' ;;
    teseo) printf '/opt/hospital-agent/runtime/state-backend' ;;
    perseo) printf '/opt/hospital-agent/runtime/state-frontend' ;;
    *) return 1 ;;
  esac
}

for alias in "${ALIASES[@]}"; do
  container=$(container_for "$alias")
  [ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" = true ] \
    || { echo "Contenedor ausente o apagado: $container" >&2; exit 1; }
  docker exec -u 1000:1000 "$container" sh -eu -c \
    'test -w /home/node/clawd && test -w /home/node/clawd/AGENTS.md && test -x /usr/local/bin/node'
done

runtime_image=$(env_value "$ENV_FILE" CAUCE_RUNTIME_IMAGE)
[[ "$runtime_image" =~ @sha256:[a-f0-9]{64}$ ]] \
  || { echo "CAUCE_RUNTIME_IMAGE no está fijada por digest" >&2; exit 1; }
release="release-$(git -C "$REPO" rev-parse --short=12 HEAD)"
release_dir=$BUNDLE_ROOT/releases/$release
if [ ! -e "$release_dir" ]; then
  temporary=$(mktemp -d "$BUNDLE_ROOT/releases/.release.XXXXXX")
  image_container=$(docker create "$runtime_image")
  docker cp "$image_container:/app/." "$temporary/"
  docker rm "$image_container" >/dev/null
  image_container=
  chown -R root:root "$temporary"
  chmod -R a-w "$temporary"
  mv "$temporary" "$release_dir"
  temporary=
fi

bundle_sha=$(python3 "$REPO/ops/container-runtime/cauce-container-runtime.py" \
  bundle-digest "$release_dir")
[[ "$bundle_sha" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || { echo "El bundle no produjo un digest válido" >&2; exit 1; }

for alias in "${ALIASES[@]}"; do
  issued=$INSTANCE_ETC/pki/agents/$alias
  if [ ! -f "$issued/agent-$alias.crt" ]; then
    CAUCE_CLIENT_CA_CERT=$INSTANCE_ETC/pki/ca.crt \
    CAUCE_CLIENT_CA_KEY=$INSTANCE_ETC/pki/ca.key \
      "$REPO/ops/scripts/provision-agent-identity.sh" "$alias" "$issued" >/dev/null
  fi
  python3 "$REPO/ops/scripts/register-agent-identity.py" \
    --alias "$alias" --cert-dir "$issued" \
    --identities-dir "$INSTANCE_ETC/identities" \
    --flota-json "$REPO/ops/flota.json" >/dev/null
  [ "$(stat -c '%u:%g:%a' "$INSTANCE_ETC/identities/mtls_identities.json")" = 1000:1000:400 ] \
    || { echo "El registro mTLS perdió su ownership privado" >&2; exit 1; }

  pki=$PKI_ROOT/$alias
  install -d -m 0700 "$pki"
  install -m 0600 "$issued/agent-$alias.crt" "$pki/client.crt"
  install -m 0600 "$issued/agent-$alias.key" "$pki/client.key"
  install -m 0600 "$INSTANCE_ETC/pki/ca.crt" "$pki/ca.crt"

  gateway_token=$(env_value "$HOSPITAL_ENV" "$(token_key_for "$alias")")
  [[ "$gateway_token" =~ ^[a-f0-9]{64}$ ]] \
    || { echo "Token local OpenClaw inválido para $alias" >&2; exit 1; }
  printf '%s\n' "$gateway_token" >"$pki/openclaw-token.tmp"
  unset gateway_token
  chmod 0600 "$pki/openclaw-token.tmp"
  mv "$pki/openclaw-token.tmp" "$pki/openclaw-token"

  container=$(container_for "$alias")
  image_id=$(docker inspect --format '{{.Image}}' "$container")
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || { echo "Image ID inválido para $container" >&2; exit 1; }
  state_source=$(state_source_for "$alias")
  config=$CONFIG_ROOT/$alias.env
  temporary_config=$CONFIG_ROOT/.$alias.env.tmp
  {
    printf 'BUNDLE_RELEASE=%s\n' "$release"
    printf 'BUNDLE_SHA256=%s\n' "$bundle_sha"
    printf 'PKI_DIR=%s\n' "$pki"
    printf 'RELAY_URL=%s\n' "$RELAY_URL"
    printf 'EXPECTED_IMAGE_ID=%s\n' "$image_id"
    printf 'CAUCE_SEMBRAR_PERFIL=1\n'
    printf 'MOUNT_TYPE=bind\n'
    printf 'MOUNT_SOURCE=%s\n' "$state_source"
    printf 'MOUNT_DESTINATION=/home/node/.openclaw\n'
    printf 'MOUNT_RW=true\n'
    printf 'OPENCLAW_WORKSPACE=/home/node/clawd\n'
    printf 'OPENCLAW_TRANSPORT=api\n'
    printf 'OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions\n'
    printf 'OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/%s/openclaw-token\n' "$alias"
    printf 'OPENCLAW_AGENT_TARGET=openclaw/%s\n' "$alias"
    printf 'DEFAULT_TIMEOUT_MS=600000\n'
  } >"$temporary_config"
  chmod 0600 "$temporary_config"
  mv "$temporary_config" "$config"
done

units=$(mktemp -d /tmp/hospital-cauce-units.XXXXXX)
python3 "$REPO/ops/scripts/generate-container-units.py" \
  --ops-root "$REPO/ops" \
  --output "$units" \
  --install-prefix /opt/hospital-cauce \
  --config-root "$CONFIG_ROOT" \
  --pki-root "$PKI_ROOT" \
  --bundle-root "$BUNDLE_ROOT" \
  --lock-root "$LOCK_ROOT" >/dev/null
install -m 0644 "$units"/cauce-v3-container-*.service /etc/systemd/system/
install -m 0644 "$units/cauce-v3-profile-expectation@.service" /etc/systemd/system/
systemctl daemon-reload

for alias in "${ALIASES[@]}"; do
  systemctl enable --now "cauce-v3-container-$alias.service"
done

for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  active=0
  for alias in "${ALIASES[@]}"; do
    [ "$(systemctl is-active "cauce-v3-container-$alias.service" 2>/dev/null)" = active ] \
      && active=$((active + 1))
  done
  [ "$active" -eq 3 ] && break
  sleep 3
done
[ "${active:-0}" -eq 3 ] || { echo "No arrancaron los tres adapters" >&2; exit 1; }

leases=0
for _attempt in $(seq 1 24); do
  leases=$(docker exec hospital-cauce-postgres-1 psql -XAtq -U cauce_hospital -d cauce_hospital \
    -c "SELECT count(*) FROM connection_leases WHERE tenant_id='Hospital' AND lease_until > now() AND last_heartbeat_at > now() - interval '60 seconds'")
  [ "$leases" = 3 ] && break
  sleep 5
done
[ "$leases" = 3 ] || { echo "Se esperaban 3 leases y se observaron $leases" >&2; exit 1; }

set_env CAUCE_SMOKE_EXPECTED_AGENTS 3
set_env CAUCE_SMOKE_REQUIRE_GOVERNANCE_AGENT 1
set_env CAUCE_SMOKE_MAX_ATTEMPTS 6
set_env CAUCE_SMOKE_RETRY_SECONDS 5
CAUCE_ENV_FILE="$ENV_FILE" "$REPO/deploy/smoke.sh"

echo "Cauce Hospital: tres adapters activos y tres leases verificados."
