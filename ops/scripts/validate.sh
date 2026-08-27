#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROJECT="$ROOT/.."

for file in "$ROOT"/scripts/*.sh "$PROJECT"/deploy/*.sh "$PROJECT"/deploy/runtime/*.sh "$PROJECT"/deploy/postgres/*.sh; do bash -n "$file"; done
for file in "$ROOT"/scripts/*.mjs "$ROOT"/harness/*.mjs "$ROOT"/tests/*.mjs "$PROJECT"/deploy/*.mjs "$PROJECT"/deploy/runtime/*.mjs; do node --check "$file"; done
PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT" <<'PY'
import json, pathlib, sys, yaml
from jsonschema import Draft202012Validator
root = pathlib.Path(sys.argv[1])
for path in sorted(root.glob('*.yaml')) + sorted((root.parent / 'deploy').glob('*.yaml')) + sorted((root / 'observability').glob('*.yaml')) + sorted((root / 'manifests').glob('*.yaml')):
    with path.open(encoding='utf-8') as stream:
        yaml.safe_load(stream)
    print(f'yaml ok: {path}')
for path in sorted((root / 'schemas').glob('*.json')):
    with path.open(encoding='utf-8') as stream:
        schema = json.load(stream)
    Draft202012Validator.check_schema(schema)
    print(f'json schema ok: {path}')
for path in sorted((root / 'scripts').glob('*.py')):
    compile(path.read_text(encoding='utf-8'), str(path), 'exec')
    print(f'python syntax ok: {path}')
for path in sorted((root / 'container-runtime').glob('*.py')):
    compile(path.read_text(encoding='utf-8'), str(path), 'exec')
    print(f'python syntax ok: {path}')
for path in sorted((root / 'guardias').glob('*.py')):
    compile(path.read_text(encoding='utf-8'), str(path), 'exec')
    print(f'python syntax ok: {path}')
PY
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/validate-manifests.py"
fleet_size=$(python3 - "$ROOT/container-aliases.json" <<'PY'
import json, pathlib, sys
print(len(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))['aliases']))
PY
)
tmp_units=$(mktemp -d)
tmp_container_units=$(mktemp -d)
tmp_release_state=$(mktemp -d)
chmod 0700 "$tmp_release_state"
trap 'rm -rf "$tmp_units" "$tmp_container_units" "$tmp_release_state"' EXIT
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/generate-units.py" --output "$tmp_units" >/dev/null
[[ $(printf '%s\n' "$tmp_units"/cauce-v3-alias-*.service | wc -l) -eq "$fleet_size" ]] || { printf 'unit generator did not emit the declarative fleet size (%s)\n' "$fleet_size" >&2; exit 1; }
(cd "$tmp_units" && sha256sum -c SHA256SUMS >/dev/null)
for unit in "$tmp_units"/cauce-v3-alias-*.service "$tmp_units/SHA256SUMS"; do
  cmp -s "$unit" "$ROOT/generated/systemd/$(basename "$unit")" || {
    printf 'checked-in systemd output is stale: %s\n' "$(basename "$unit")" >&2
    exit 1
  }
done
(cd "$ROOT/generated/systemd" && sha256sum -c SHA256SUMS >/dev/null)

PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/generate-container-units.py" --rootless --home /home/dev --output "$tmp_container_units" >/dev/null
container_units=("$tmp_container_units"/cauce-v3-container-*.service)
container_configs=("$tmp_container_units"/configs/*.env.example)
[[ ${#container_units[@]} -eq "$fleet_size" && ${#container_configs[@]} -eq "$fleet_size" ]] || {
  printf 'container unit generator did not emit the declarative fleet size (%s)\n' "$fleet_size" >&2
  exit 1
}
(cd "$tmp_container_units" && sha256sum -c SHA256SUMS >/dev/null)
for generated in "${container_units[@]}" "${container_configs[@]}" "$tmp_container_units/OPERATIONS.sha256" "$tmp_container_units/SHA256SUMS"; do
  relative=${generated#"$tmp_container_units"/}
  cmp -s "$generated" "$ROOT/generated/container-systemd/rootless/$relative" || {
    printf 'checked-in container systemd output is stale: %s\n' "$relative" >&2
    exit 1
  }
done
(cd "$ROOT/generated/container-systemd/rootless" && sha256sum -c SHA256SUMS >/dev/null)
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/container_ops_digest.py" --rootless --check
node "$ROOT/tests/container-supervisor.test.mjs"
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/tests/test_container_runtime_reaping.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/tests/test_provision_alertmanager_config.py"
node "$ROOT/tests/alias-runner.test.mjs"
node "$ROOT/tests/container-cutover.test.mjs"
node "$ROOT/tests/container-ops-evidence.test.mjs"
node "$ROOT/tests/sector-table.test.mjs"
# Guards the source-digest domain split: proves the runtime domain still covers everything that
# reaches the runtime image and that console is the only thing it drops. Removing a family from
# a digest LOOSENS the gate, so the narrowing has to be pinned by a test.
node "$ROOT/tests/source-digest-domains.test.mjs"

python3 - "$PROJECT" <<'PY'
import pathlib, re, sys
project = pathlib.Path(sys.argv[1])
prod = (project / 'deploy/compose.yaml').read_text(encoding='utf-8')
dev = (project / 'deploy/compose.dev.yaml').read_text(encoding='utf-8')
overlay = (project / 'deploy/compose.postgres.yaml').read_text(encoding='utf-8')
alert_overlay = (project / 'deploy/compose.alertmanager.yaml').read_text(encoding='utf-8')
alert_config = (project / 'ops/observability/alertmanager.yaml').read_text(encoding='utf-8')
console = (project / 'console/nginx.conf').read_text(encoding='utf-8')
required = {
    'production compose must not build mutable images': 'build:' not in prod,
    'mTLS gateway health must use isolated loopback probe': 'http://127.0.0.1:8081/health/ready' in prod and 'https://gateway:8443/health/ready' not in prod,
    'console production health must be HTTPS': 'https://console:8444/' in prod,
    'database URL must be a Compose secret': 'DATABASE_URL_FILE: /run/secrets/database_url' in prod,
    'production bind must default private': '${CAUCE_PRIVATE_BIND_IP:-127.0.0.1}' in prod,
    'local PostgreSQL must have no published ports': '  postgres:' in overlay and '\n    ports:' not in overlay,
    'Alertmanager must mount an explicit identity-free config path': 'CAUCE_ALERTMANAGER_CONFIG_PATH' in alert_overlay and '../ops/observability/alertmanager.yaml:' not in alert_overlay,
    'tracked Alertmanager config must use a chat-id file and contain no inline id': 'chat_id_file: /run/secrets/alertmanager_telegram_chat_id' in alert_config and not re.search(r'^\s*chat_id:\s*', alert_config, re.MULTILINE),
    'dev compose must remain separate': 'NODE_ENV: development' in dev,
    'dev adapters must explicitly opt into non-production transport': dev.count('CAUCE_ENVIRONMENT: development') >= 2,
    'production includes Telegram bridge': 'services/telegram-bridge/dist/main.js' in prod,
    'production PostgreSQL policy must be verify-full': 'PGSSLMODE: verify-full' in prod and 'sslmode=require' not in prod,
    'gateway health port must be explicit': 'CAUCE_HEALTH_PORT: "8081"' in prod,
    'per-request identity registries must be reached through a directory bind, never a file secret': all((
        'CAUCE_MTLS_IDENTITY_FILE: /run/cauce-identities/' in prod,
        'CAUCE_TOKEN_HASH_FILE: /run/cauce-identities/' in prod,
        'target: /run/cauce-identities' in prod,
        'source: gateway_mtls_identities' not in prod,
        'source: gateway_token_hashes' not in prod,
    )),
    'production compose must wire the complete OIDC BFF': all(value in prod for value in ('CAUCE_OIDC_AUTHORIZATION_URL', 'CAUCE_OIDC_TOKEN_URL', 'CAUCE_OIDC_CLIENT_ID', 'CAUCE_OIDC_REDIRECT_URI', 'gateway_oidc_session_key')),
    'xterm CSP must allow only inline style attributes': "style-src-attr 'unsafe-inline'" in console and "style-src 'self' 'unsafe-inline'" not in console,
}
failed = [name for name, passed in required.items() if not passed]
if failed:
    raise SystemExit('policy validation failed: ' + '; '.join(failed))
print('deployment policy assertions ok')
PY

if docker compose version >/dev/null 2>&1; then
  zeros=$(printf '%064d' 0)
  export POSTGRES_DB=cauce POSTGRES_USER=cauce POSTGRES_PASSWORD=x DATABASE_URL=postgresql://validation.invalid/cauce
  export CAUCE_RUNTIME_IMAGE="registry.invalid/cauce-runtime@sha256:$zeros" CAUCE_CONSOLE_IMAGE="registry.invalid/cauce-console@sha256:$zeros"
  validation_writer_snapshot="$tmp_release_state/writer-snapshot.json"
  validation_media_dir="$tmp_release_state/media"
  mkdir -p -- "$validation_media_dir"
  chmod 0700 "$validation_media_dir"
  python3 - "$ROOT/container-aliases.json" "$validation_writer_snapshot" <<'PY'
import hashlib, json, pathlib, sys
manifest_bytes = pathlib.Path(sys.argv[1]).read_bytes()
aliases = json.loads(manifest_bytes)["aliases"]
rows = []
for alias, body in sorted(aliases.items()):
    units = []
    for family, scope, name in (
        ("host-native", "system", f"cauce-v3-alias-{alias}.service"),
        ("container-system", "system", f"cauce-v3-container-{alias}.service"),
        ("container-rootless", "user", f"cauce-v3-container-{alias}.service"),
    ):
        units.append({
            "activeState": "inactive", "family": family, "fragmentSha256": None,
            "loadState": "not-found", "mainPid": 0, "name": name, "scope": scope,
            "subState": "dead", "unitFileState": "not-found",
        })
    rows.append({
        "alias": alias,
        "host": body.get("dockerHost", "local"),
        "leaseActive": False,
        "systemdUser": body["systemdUser"],
        "tenant": body["tenant"],
        "units": units,
    })
snapshot = {
    "aliases": rows, "composeWriters": [], "kind": "cauce-v3-release-writer-snapshot",
    "manifestSha256": "sha256:" + hashlib.sha256(manifest_bytes).hexdigest(),
    "schemaVersion": 2, "writersExpectedCandidate": 0,
}
pathlib.Path(sys.argv[2]).write_text(
    json.dumps(snapshot, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"
)
PY
  chmod 0600 "$validation_writer_snapshot"
  validation_writer_sha="sha256:$(sha256sum "$validation_writer_snapshot" | cut -d' ' -f1)"
  export CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE="$validation_writer_snapshot"
  export CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256="$validation_writer_sha"
  export CAUCE_OTEL_IMAGE="registry.invalid/otel@sha256:$zeros" CAUCE_PROMETHEUS_IMAGE="registry.invalid/prometheus@sha256:$zeros" CAUCE_POSTGRES_IMAGE="registry.invalid/postgres@sha256:$zeros"
  export CAUCE_ALERTMANAGER_IMAGE="registry.invalid/alertmanager@sha256:$zeros" CAUCE_ALERTMANAGER_CONFIG_PATH=/dev/null CAUCE_ALERTMANAGER_TELEGRAM_TOKEN_PATH=/dev/null
  export CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH=/dev/null
  export CAUCE_ALERTMANAGER_DATA_DIR=/tmp/cauce-alertmanager-validation CAUCE_ALERTMANAGER_UID=1000 CAUCE_ALERTMANAGER_GID=1000
  export CAUCE_AUTH_PROVIDER=oidc CAUCE_CONSOLE_ORIGINS=https://console.invalid
  export CAUCE_MEDIA_RUNTIME_DIR="$validation_media_dir"
  export CAUCE_DATABASE_URL_SECRET_PATH=/dev/null CAUCE_POSTGRES_CA_PATH=/dev/null
  export CAUCE_GATEWAY_TLS_CERT_PATH=/dev/null CAUCE_GATEWAY_TLS_KEY_PATH=/dev/null CAUCE_GATEWAY_TLS_CA_PATH=/dev/null CAUCE_GATEWAY_CLIENT_CA_PATH=/dev/null
  export CAUCE_GATEWAY_IDENTITY_DIR=/tmp/cauce-validation-identities
  export CAUCE_GATEWAY_OIDC_SESSION_KEY_PATH=/dev/null CAUCE_GATEWAY_OIDC_CLIENT_SECRET_PATH=/dev/null
  export CAUCE_CONSOLE_TLS_CERT_PATH=/dev/null CAUCE_CONSOLE_TLS_KEY_PATH=/dev/null CAUCE_CONSOLE_TLS_CA_PATH=/dev/null
  export CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH=/dev/null CAUCE_CONSOLE_GATEWAY_CLIENT_KEY_PATH=/dev/null
  export CAUCE_RELAY_ALLOWED_ORIGINS=https://relay.invalid CAUCE_RELAY_ADAPTERS=telegram CAUCE_TELEGRAM_ALLOWED_ORIGINS=https://api.telegram.org
  export CAUCE_POSTGRES_PASSWORD_PATH=/dev/null CAUCE_POSTGRES_SERVER_CERT_PATH=/dev/null CAUCE_POSTGRES_SERVER_KEY_PATH=/dev/null
  docker compose -f "$PROJECT/deploy/compose.yaml" config --quiet
  docker compose -f "$PROJECT/deploy/compose.yaml" -f "$PROJECT/deploy/compose.postgres.yaml" config --quiet
  docker compose -f "$PROJECT/deploy/compose.yaml" -f "$PROJECT/deploy/compose.alertmanager.yaml" config --quiet
  docker compose -f "$PROJECT/deploy/compose.dev.yaml" config --quiet
  docker compose -f "$ROOT/compose.test.yaml" config --quiet
  printf 'compose config ok\n'
elif [[ ${CAUCE_RELEASE_VALIDATION:-0} == 1 ]]; then
  printf 'release validation failed: Docker Compose v2 unavailable\n' >&2
  exit 127
else
  printf 'compose config skipped outside release: Docker Compose v2 unavailable\n'
fi

if ! docker build --help >/dev/null 2>&1; then
  if [[ ${CAUCE_RELEASE_VALIDATION:-0} == 1 ]]; then
    printf 'release validation failed: docker build unavailable\n' >&2
    exit 127
  fi
  printf 'docker build check skipped outside release\n'
fi
if command -v shellcheck >/dev/null 2>&1; then shellcheck "$ROOT"/scripts/*.sh "$PROJECT"/deploy/*.sh "$PROJECT"/deploy/runtime/*.sh "$PROJECT"/deploy/postgres/*.sh; fi
node "$PROJECT/ops/scripts/validate-console-browser-storage.mjs" "$PROJECT/console/src"
printf 'static validation passed\n'
