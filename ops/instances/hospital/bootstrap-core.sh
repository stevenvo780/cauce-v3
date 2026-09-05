#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ejecutá este bootstrap con sudo" >&2
  exit 1
fi

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
INSTANCE_ETC=/etc/cauce-v3-hospital
INSTANCE_STATE=/var/lib/cauce-v3-hospital
ENV_FILE=$INSTANCE_ETC/prod.env
PROJECT=hospital-cauce
PG_CONTAINER=$PROJECT-postgres-1
PG_VOLUME=${PROJECT}_cauce_pgdata
LOCK_FILE=/run/lock/hospital-cauce-bootstrap.lock
EXPECTED_REF=${CAUCE_HOSPITAL_EXPECTED_GIT_REF:-origin/socrates/hospital-fleet-20260905}
BACKUP_STATUS=/var/backups/cauce-v3-hospital/status.json
BACKUP_MONITOR=$REPO/ops/instances/hospital/backup-monitor.sh

[ "$REPO" = /opt/hospital-cauce ] \
  || { echo "El checkout operativo debe ser /opt/hospital-cauce (actual: $REPO)" >&2; exit 1; }

for command in docker git openssl python3 sha256sum flock; do
  command -v "$command" >/dev/null || { echo "Falta $command" >&2; exit 1; }
done
docker compose version >/dev/null

umask 077
install -d -m 0755 /run/lock
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Ya hay un bootstrap Hospital en ejecución" >&2; exit 75; }

install -d -m 0700 "$INSTANCE_ETC" "$INSTANCE_ETC/secrets" "$INSTANCE_ETC/pki"
install -d -o root -g 1000 -m 0750 "$INSTANCE_ETC/identities"
install -d -m 0755 "$INSTANCE_ETC/terminal"
install -d -o 1000 -g 1000 -m 0700 "$INSTANCE_ETC/telegram-runtime"
install -d -m 0700 "$INSTANCE_ETC/container-pki" "$INSTANCE_ETC/container-aliases"
install -d -m 0755 "$INSTANCE_STATE" "$INSTANCE_STATE/release"
install -d -o 1000 -g 1000 -m 0700 "$INSTANCE_STATE/media"
install -d -m 0755 /var/backups/cauce-v3-hospital

if docker inspect "$PG_CONTAINER" >/dev/null 2>&1 \
   || docker volume inspect "$PG_VOLUME" >/dev/null 2>&1; then
  if ! STATUS_FILE="$BACKUP_STATUS" MAX_AGE_HOURS=24 \
    "$BACKUP_MONITOR" >/dev/null; then
    if [ "$(docker inspect --format '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null)" = true ]; then
      echo "La instancia ya tiene almacenamiento sin backup fresco; intento un checkpoint verificado antes de cualquier migración."
      "$REPO/ops/instances/hospital/backup.sh"
      STATUS_FILE="$BACKUP_STATUS" MAX_AGE_HOURS=24 "$BACKUP_MONITOR" >/dev/null \
        || { echo "El checkpoint de recuperación no quedó acreditado; no se permite el redeploy." >&2; exit 1; }
    else
      echo "La instancia ya tiene almacenamiento, PostgreSQL no está activo y no hay backup verificado de menos de 24h; no se permite el redeploy." >&2
      exit 1
    fi
  fi
fi

set_env() {
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
from pathlib import Path
import os
import sys
import tempfile

path, key, value = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text(encoding="utf-8").splitlines()
replacement = f"{key}={value}"
matches = [index for index, line in enumerate(lines) if line.startswith(f"{key}=")]
if len(matches) > 1:
    raise SystemExit(f"duplicate environment key: {key}")
if matches:
    lines[matches[0]] = replacement
else:
    lines.append(replacement)
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

ensure_secret() {
  local path=$1 bytes=$2 owner_uid=$3 owner_gid=$4
  if [ ! -e "$path" ]; then
    openssl rand -hex "$bytes" >"$path.tmp"
    chmod 0400 "$path.tmp"
    mv "$path.tmp" "$path"
  fi
  chown "$owner_uid:$owner_gid" "$path"
  chmod 0400 "$path"
  if [ ! -f "$path" ] || [ -L "$path" ] || [ "$(stat -c '%a' "$path")" != 400 ] \
     || [ "$(stat -c '%u:%g' "$path")" != "$owner_uid:$owner_gid" ]; then
    echo "Secreto inválido: $path" >&2
    exit 1
  fi
}

ensure_ca() {
  local dir=$INSTANCE_ETC/pki key=$INSTANCE_ETC/pki/ca.key cert=$INSTANCE_ETC/pki/ca.crt
  if [ ! -e "$key" ] && [ ! -e "$cert" ]; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$key.tmp" >/dev/null 2>&1
    openssl req -x509 -new -sha256 -key "$key.tmp" -days 3650 -subj "/CN=Hospital Cauce Root CA" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$cert.tmp" >/dev/null 2>&1
    chmod 0400 "$key.tmp"
    chmod 0444 "$cert.tmp"
    mv "$key.tmp" "$key"
    mv "$cert.tmp" "$cert"
  fi
  if [ ! -f "$key" ] || [ -L "$key" ] || [ ! -f "$cert" ] || [ -L "$cert" ]; then
    echo "PKI raíz incompleta" >&2
    exit 1
  fi
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
}

issue_leaf() {
  local kind=$1 name=$2 subject=$3 extensions=$4 key_uid=$5 key_gid=$6
  local dir=$INSTANCE_ETC/pki/$name
  local key=$dir/$kind.key cert=$dir/$kind.crt temp
  install -d -m 0700 "$dir"
  if [ ! -e "$key" ] && [ ! -e "$cert" ]; then
    temp=$(mktemp -d "$dir/.issue.XXXXXX")
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$temp/key" >/dev/null 2>&1
    openssl req -new -sha256 -key "$temp/key" -subj "/CN=$subject" -out "$temp/request.csr" >/dev/null 2>&1
    printf '%s\n' "$extensions" | openssl x509 -req -sha256 -in "$temp/request.csr" \
      -CA "$INSTANCE_ETC/pki/ca.crt" -CAkey "$INSTANCE_ETC/pki/ca.key" \
      -set_serial "0x$(openssl rand -hex 16)" -days 825 -extfile /dev/stdin \
      -out "$temp/cert" >/dev/null 2>&1
    install -m 0400 "$temp/key" "$key"
    install -m 0444 "$temp/cert" "$cert"
    rm -f "$temp/key" "$temp/cert" "$temp/request.csr"
    rmdir "$temp"
  fi
  if [ ! -f "$key" ] || [ -L "$key" ] || [ ! -f "$cert" ] || [ -L "$cert" ]; then
    echo "PKI incompleta: $name" >&2
    exit 1
  fi
  chown "$key_uid:$key_gid" "$key"
  chmod 0400 "$key"
  chown root:root "$cert"
  chmod 0444 "$cert"
  openssl verify -CAfile "$INSTANCE_ETC/pki/ca.crt" "$cert" >/dev/null
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
}

pin_image() {
  local image=$1 digest
  docker pull "$image" >/dev/null
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$image")
  [[ "$digest" =~ @sha256:[a-f0-9]{64}$ ]] \
    || { echo "La imagen $image no produjo un digest inmutable" >&2; exit 1; }
  printf '%s' "$digest"
}

if [ ! -e "$ENV_FILE" ]; then
  install -m 0600 "$REPO/ops/config/hospital.env.example" "$ENV_FILE"
fi
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] && chmod 0600 "$ENV_FILE"

ensure_secret "$INSTANCE_ETC/secrets/postgres-password" 32 0 0
ensure_secret "$INSTANCE_ETC/secrets/console-jwt.key" 64 1000 1000

postgres_password=$(<"$INSTANCE_ETC/secrets/postgres-password")
printf 'postgresql://cauce_hospital:%s@postgres:5432/cauce_hospital\n' "$postgres_password" \
  >"$INSTANCE_ETC/secrets/database-url.tmp"
chmod 0400 "$INSTANCE_ETC/secrets/database-url.tmp"
mv "$INSTANCE_ETC/secrets/database-url.tmp" "$INSTANCE_ETC/secrets/database-url"
chown 1000:1000 "$INSTANCE_ETC/secrets/database-url"
chmod 0400 "$INSTANCE_ETC/secrets/database-url"
unset postgres_password

ensure_ca
issue_leaf server gateway gateway $'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:gateway,DNS:localhost,IP:127.0.0.1,IP:172.17.0.1' 1000 1000
issue_leaf server console console $'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:console,DNS:localhost,IP:127.0.0.1,IP:172.17.0.1' 101 101
issue_leaf server postgres postgres $'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:postgres' 0 0
issue_leaf client console-client console-client $'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth' 101 101

if [ ! -e "$INSTANCE_ETC/identities/mtls_identities.json" ]; then
  printf '{"identities":[],"version":1}\n' >"$INSTANCE_ETC/identities/mtls_identities.json"
fi
if [ ! -e "$INSTANCE_ETC/identities/token_hashes.json" ]; then
  printf '{"identities":[],"version":1}\n' >"$INSTANCE_ETC/identities/token_hashes.json"
fi
chown 1000:1000 "$INSTANCE_ETC/identities/mtls_identities.json" "$INSTANCE_ETC/identities/token_hashes.json"
chmod 0400 "$INSTANCE_ETC/identities/mtls_identities.json" "$INSTANCE_ETC/identities/token_hashes.json"
python3 "$REPO/ops/instances/hospital/register-console-identity.py" \
  --registry "$INSTANCE_ETC/identities/mtls_identities.json" \
  --certificate "$INSTANCE_ETC/pki/console-client/client.crt"

postgres_image=$(pin_image postgres:16-alpine)
prometheus_image=$(pin_image prom/prometheus:v3.5.0)
otel_image=$(pin_image otel/opentelemetry-collector-contrib:0.135.0)
set_env CAUCE_POSTGRES_IMAGE "$postgres_image"
set_env CAUCE_PROMETHEUS_IMAGE "$prometheus_image"
set_env CAUCE_OTEL_IMAGE "$otel_image"

python3 - "$REPO/ops/container-aliases.json" "$INSTANCE_STATE/release/writer-snapshot.json" <<'PY'
from pathlib import Path
import hashlib
import json
import sys

manifest = Path(sys.argv[1]).read_bytes()
aliases = json.loads(manifest)["aliases"]
rows = []
for alias, body in sorted(aliases.items()):
    rows.append({
        "alias": alias,
        "host": body.get("dockerHost", "local"),
        "leaseActive": False,
        "systemdUser": body["systemdUser"],
        "tenant": body["tenant"],
        "units": [],
    })
snapshot = {
    "aliases": rows,
    "composeWriters": [],
    "kind": "cauce-v3-release-writer-snapshot",
    "manifestSha256": "sha256:" + hashlib.sha256(manifest).hexdigest(),
    "schemaVersion": 2,
    "writersExpectedCandidate": 0,
}
Path(sys.argv[2]).write_text(
    json.dumps(snapshot, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "$INSTANCE_STATE/release/writer-snapshot.json"
snapshot_sha="sha256:$(sha256sum "$INSTANCE_STATE/release/writer-snapshot.json" | cut -d' ' -f1)"
set_env CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256 "$snapshot_sha"
updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$INSTANCE_STATE/release/writer-snapshot.json.state.json" \
  "$INSTANCE_STATE/release/writer-snapshot.json" "$snapshot_sha" "$updated_at" <<'PY'
from pathlib import Path
import json
import sys

state = {
    "kind": "cauce-v3-release-state",
    "mode": "candidate",
    "releaseId": "hospital-bootstrap",
    "schemaVersion": 1,
    "snapshotPath": sys.argv[2],
    "snapshotSha256": sys.argv[3],
    "updatedAt": sys.argv[4],
    "writersExpected": 0,
    "writersObserved": 0,
}
Path(sys.argv[1]).write_text(
    json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "$INSTANCE_STATE/release/writer-snapshot.json.state.json"
chown 1000:1000 "$INSTANCE_STATE/release/writer-snapshot.json.state.json"
chmod 0400 "$INSTANCE_STATE/release/writer-snapshot.json.state.json"

printf '{"kind":"hospital-cauce-bootstrap","schemaVersion":1}\n' \
  >"$INSTANCE_STATE/release/rollback-baseline.json"
chmod 0600 "$INSTANCE_STATE/release/rollback-baseline.json"
baseline_sha="sha256:$(sha256sum "$INSTANCE_STATE/release/rollback-baseline.json" | cut -d' ' -f1)"
set_env CAUCE_ROLLBACK_BASELINE_SHA256 "$baseline_sha"

# Docker Compose standalone binds secret source files without applying the Swarm uid/gid fields.
# Exercise the actual bind semantics with the same numeric users before starting any service.
docker run --rm --network none --user 1000:1000 --entrypoint /bin/sh \
  -v "$INSTANCE_ETC/secrets/database-url:/probe/database-url:ro" \
  -v "$INSTANCE_ETC/secrets/console-jwt.key:/probe/console-jwt:ro" \
  -v "$INSTANCE_ETC/pki/gateway/server.key:/probe/gateway-key:ro" \
  -v "$INSTANCE_ETC/identities:/probe/identities:ro" \
  -v "$INSTANCE_STATE/release/writer-snapshot.json.state.json:/probe/release-state:ro" \
  "$postgres_image" -eu -c \
  'test -r /probe/database-url && test -r /probe/console-jwt && test -r /probe/gateway-key && test -r /probe/identities/mtls_identities.json && test -r /probe/identities/token_hashes.json && test -r /probe/release-state'
docker run --rm --network none --user 101:101 --entrypoint /bin/sh \
  -v "$INSTANCE_ETC/pki/console/server.key:/probe/console-key:ro" \
  -v "$INSTANCE_ETC/pki/console-client/client.key:/probe/console-client-key:ro" \
  "$postgres_image" -eu -c \
  'test -r /probe/console-key && test -r /probe/console-client-key'

if ! docker inspect hospital-cauce-registry >/dev/null 2>&1; then
  docker run -d --name hospital-cauce-registry --restart unless-stopped \
    -p 127.0.0.1:5000:5000 registry:2 >/dev/null
elif [ "$(docker inspect --format '{{.State.Running}}' hospital-cauce-registry)" != true ]; then
  docker start hospital-cauce-registry >/dev/null
fi

if [ ! -e "$INSTANCE_STATE/deploy-history.md" ]; then
  install -m 0600 /dev/null "$INSTANCE_STATE/deploy-history.md"
fi
if [ ! -f "$INSTANCE_STATE/deploy-history.md" ] \
   || [ -L "$INSTANCE_STATE/deploy-history.md" ]; then
  echo "Historial de despliegue inválido" >&2
  exit 1
fi
CAUCE_ENV_FILE="$ENV_FILE" \
CAUCE_DEPLOY_EXPECTED_GIT_REF="$EXPECTED_REF" \
CAUCE_DEPLOY_REGISTRY=127.0.0.1:5000 \
CAUCE_DEPLOY_HISTORY_FILE="$INSTANCE_STATE/deploy-history.md" \
CAUCE_DEPLOY_BACKUP_STATUS_FILE="$BACKUP_STATUS" \
CAUCE_DEPLOY_BACKUP_MONITOR="$BACKUP_MONITOR" \
CAUCE_FASE3_CON_DUENO=si \
CAUCE_DEPLOY_CONFIRMADO=si \
  "$REPO/deploy/deploy.sh"

docker exec -i "$PG_CONTAINER" psql -X -v ON_ERROR_STOP=1 \
  -U cauce_hospital -d cauce_hospital <"$REPO/ops/instances/hospital/bootstrap.sql"

python3 "$REPO/ops/scripts/export-fleet-snapshot.py" \
  --postgres-container "$PG_CONTAINER" \
  --placement "$REPO/ops/flota-fisica.json" \
  --out "$REPO/ops/flota.json" --check

install -d -m 0700 "$INSTANCE_ETC/access"
if [ ! -e "$INSTANCE_ETC/access/console" ]; then
  console_password="Hc-$(openssl rand -hex 16)!Aa9"
  gateway_container=$(docker compose --env-file "$ENV_FILE" \
    -f "$REPO/deploy/compose.yaml" -f "$REPO/deploy/compose.postgres.yaml" \
    --project-directory "$REPO/deploy" ps -q gateway)
  [ -n "$gateway_container" ] || { echo "No encuentro el gateway para crear el acceso" >&2; exit 1; }
  printf '%s\n' "$console_password" | docker exec -i "$gateway_container" sh -eu -c '
    IFS= read -r CAUCE_CONSOLE_USER_PASSWORD
    export CAUCE_CONSOLE_USER_PASSWORD
    DATABASE_URL=$(cat /run/secrets/database_url)
    export DATABASE_URL
    exec node /app/services/gateway/dist/console-user-cli.js \
      --email steven@hospital.local --name Steven --role operator \
      --tenant Hospital --alias operador
  ' >/dev/null
  {
    printf 'URL=https://localhost:18444\n'
    printf 'EMAIL=steven@hospital.local\n'
    printf 'PASSWORD=%s\n' "$console_password"
    printf 'TUNNEL=ssh -L 18444:172.17.0.1:18444 ubuntu@51.222.206.51\n'
  } >"$INSTANCE_ETC/access/.console.tmp"
  unset console_password
  chmod 0600 "$INSTANCE_ETC/access/.console.tmp"
  mv "$INSTANCE_ETC/access/.console.tmp" "$INSTANCE_ETC/access/console"
fi

install -m 0755 "$REPO/ops/instances/hospital/backup.sh" \
  /usr/local/sbin/hospital-cauce-backup
install -m 0755 "$REPO/ops/instances/hospital/backup-monitor.sh" \
  /usr/local/sbin/hospital-cauce-backup-monitor
install -m 0644 "$REPO/ops/instances/hospital/hospital-cauce-backup.service" \
  "$REPO/ops/instances/hospital/hospital-cauce-backup.timer" \
  "$REPO/ops/instances/hospital/hospital-cauce-backup-monitor.service" \
  "$REPO/ops/instances/hospital/hospital-cauce-backup-monitor.timer" \
  /etc/systemd/system/
systemctl daemon-reload
/usr/local/sbin/hospital-cauce-backup
STATUS_FILE="$BACKUP_STATUS" MAX_AGE_HOURS=24 \
  /usr/local/sbin/hospital-cauce-backup-monitor >/dev/null
systemctl enable --now hospital-cauce-backup.timer hospital-cauce-backup-monitor.timer

echo "Cauce Hospital: núcleo, PostgreSQL y consola instalados; falta aprovisionar los tres adapters."
