#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fleet_mode=final
if (($#)); then
  [[ $# == 1 && $1 == --maintenance-offline-zeus ]] || {
    printf 'usage: release-gate.sh [--maintenance-offline-zeus]\n' >&2
    exit 2
  }
  fleet_mode=maintenance-zeus
fi
env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}
[[ -f $env_file ]] || { printf 'release gate failed: missing private production env file\n' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { printf 'release gate failed: docker is unavailable\n' >&2; exit 127; }
docker compose version >/dev/null 2>&1 || { printf 'release gate failed: Docker Compose v2 is unavailable\n' >&2; exit 127; }
docker build --help >/dev/null 2>&1 || { printf 'release gate failed: docker build is unavailable\n' >&2; exit 127; }

env_value() {
  local key=$1 fallback=$2 line value
  local -a lines=()
  if [[ -v $key ]]; then printf '%s\n' "${!key}"; return; fi
  mapfile -t lines < <(sed -n "/^${key}=/p" "$env_file")
  ((${#lines[@]} <= 1)) || { printf 'release gate failed: duplicate %s in env file\n' "$key" >&2; return 2; }
  if ((${#lines[@]} == 0)); then printf '%s\n' "$fallback"; return; fi
  line=${lines[0]}; value=${line#*=}; value=${value%$'\r'}
  printf '%s\n' "$value"
}

file_env_value() {
  local key=$1 fallback=$2 line value
  local -a lines=()
  mapfile -t lines < <(sed -n "/^${key}=/p" "$env_file")
  ((${#lines[@]} <= 1)) || { printf 'release gate failed: duplicate %s in env file\n' "$key" >&2; return 2; }
  if ((${#lines[@]} == 0)); then printf '%s\n' "$fallback"; return; fi
  line=${lines[0]}; value=${line#*=}; value=${value%$'\r'}
  printf '%s\n' "$value"
}
# Resolve through the same entry point used by deploy and rollback.  The env
# file is parsed by Docker Compose as data (never sourced as shell code), and
# compose-files.sh authenticates the complete ordered override set first.
compose_json=$(CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/compose.sh" prod config --format json) || {
  printf 'release gate failed: canonical production Compose config did not resolve\n' >&2
  exit 2
}
compose_json_file=$(mktemp)
trap 'rm -f "$compose_json_file"' EXIT
printf '%s\n' "$compose_json" >"$compose_json_file"
resolved=$(python3 -c '
import json, sys
doc = json.load(sys.stdin)
services = doc.get("services") or {}
for required in ("gateway", "console"):
    if required not in services or not services[required].get("image"):
        raise SystemExit(f"missing required service image: {required}")
print(services["gateway"]["image"])
print(services["console"]["image"])
for image in sorted({body.get("image") for body in services.values() if body.get("image")}):
    print(image)
' <<<"$compose_json") || { printf 'release gate failed: resolved Compose JSON is invalid\n' >&2; exit 2; }
mapfile -t resolved_lines <<<"$resolved"
((${#resolved_lines[@]} >= 2)) || { printf 'release gate failed: resolved Compose image set is incomplete\n' >&2; exit 2; }
runtime_ref=${resolved_lines[0]}
console_ref=${resolved_lines[1]}
compose_images=("${resolved_lines[@]:2}")
[[ $runtime_ref == *@sha256:* ]] || { printf 'release gate failed: runtime image is not digest-pinned\n' >&2; exit 2; }
[[ $console_ref == *@sha256:* ]] || { printf 'release gate failed: console image is not digest-pinned\n' >&2; exit 2; }
for image in "${compose_images[@]}"; do
  [[ $image == *@sha256:* ]] || { printf 'release gate failed: compose image is not digest-pinned: %s\n' "$image" >&2; exit 2; }
done
python3 "$ROOT/scripts/validate-manifests.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/physical-fleet-gate.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/source-hygiene.py"
python3 "$ROOT/scripts/validate-terminal-release.py" --compose-json "$compose_json_file"
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/migration-integrity-gate.sh" pre
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/reconcile-stale-console-outbox.sh" pre
# This selector is evidence input, not an operator convenience override.  Read
# it only from the authenticated production env file so an ambient process env
# cannot redirect the release gate at a fabricated status/evidence pair.
backup_status=$(file_env_value CAUCE_BACKUP_STATUS_FILE /var/log/cauce-v3-backup/status.json)
STATUS_FILE="$backup_status" MAX_AGE_HOURS=30 REQUIRE_RETENTION_PRESERVED=1 \
  "$ROOT/scripts/host-backup-monitor.sh"
tmp_units=$(mktemp -d)
tmp_container_units=$(mktemp -d)
trap 'rm -rf "$tmp_units" "$tmp_container_units"; rm -f "$compose_json_file"' EXIT
python3 "$ROOT/scripts/generate-units.py" --output "$tmp_units" >/dev/null
for unit in "$tmp_units"/cauce-v3-alias-*.service "$tmp_units/SHA256SUMS"; do
  cmp -s "$unit" "$ROOT/generated/systemd/$(basename "$unit")" || {
    printf 'release gate failed: checked-in systemd output is stale: %s\n' "$(basename "$unit")" >&2
    exit 1
  }
done
(cd "$ROOT/generated/systemd" && sha256sum -c SHA256SUMS >/dev/null)
python3 "$ROOT/scripts/generate-container-units.py" --output "$tmp_container_units" >/dev/null
for generated in "$tmp_container_units"/cauce-v3-container-*.service "$tmp_container_units"/configs/*.env.example "$tmp_container_units"/OPERATIONS.sha256 "$tmp_container_units"/SHA256SUMS; do
  relative=${generated#"$tmp_container_units"/}
  cmp -s "$generated" "$ROOT/generated/container-systemd/$relative" || {
    printf 'release gate failed: checked-in container systemd output is stale: %s\n' "$relative" >&2
    exit 1
  }
done
(cd "$ROOT/generated/container-systemd" && sha256sum -c SHA256SUMS >/dev/null)
PYTHONDONTWRITEBYTECODE=1 python3 "$ROOT/scripts/container_ops_digest.py" --check
node "$ROOT/tests/container-supervisor.test.mjs"
node "$ROOT/tests/alias-runner.test.mjs"
node "$ROOT/tests/container-cutover.test.mjs"
node "$ROOT/tests/container-ops-evidence.test.mjs"
node "$ROOT/tests/source-digest-domains.test.mjs"
for dir in compose-authentic release; do "$ROOT/scripts/verify-manifest.sh" "$ROOT/artifacts/$dir"; done
python3 "$ROOT/scripts/validate-release-evidence.py"
# `pre` proves that the inherited schema is admissible.  A general release is
# not admissible until `post` proves every migration shipped by the candidate is
# applied and atomically ledgered; release-candidate consumes both artifacts.
CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/migration-integrity-gate.sh" post
# Canonical readiness is an executable product gate, not an inference from
# Compose "running" or from the fleet lease matrix.  stack-health exercises the
# real in-container readiness paths (including PostgreSQL TLS), Docker health for
# terminal relay, and the appropriately strict fleet mode.
health_args=(prod)
[[ $fleet_mode == final ]] || health_args+=(--maintenance-offline-zeus)
CAUCE_FLEET_SNAPSHOT_FILE= CAUCE_FLEET_TEST_MODE=0 \
  CAUCE_ENV_FILE="$env_file" "$ROOT/scripts/stack-health.sh" "${health_args[@]}"
python3 "$ROOT/scripts/release-candidate.py"
runtime_id=$(docker image inspect --format '{{.Id}}' "$runtime_ref") || { printf 'release gate failed: runtime digest is not present locally\n' >&2; exit 1; }
console_id=$(docker image inspect --format '{{.Id}}' "$console_ref") || { printf 'release gate failed: console digest is not present locally\n' >&2; exit 1; }
validate_selected_image() {
  local kind=$1 reference=$2 serialized
  serialized=$(docker image inspect --format '{{json .}}' "$reference") || return 1
  IMAGE_KIND=$kind IMAGE_REFERENCE=$reference IMAGE_INSPECT=$serialized \
    python3 - "$ROOT/artifacts/release/build.json" <<'PY'
import json
import os
import pathlib
import sys

manifest_types = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
try:
    build = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    image = json.loads(os.environ["IMAGE_INSPECT"])
    kind = os.environ["IMAGE_KIND"]
    reference = os.environ["IMAGE_REFERENCE"]
    evidence = build[kind]
    descriptor = image["Descriptor"]
    labels = image["Config"]["Labels"]
    bases = build["baseImages"]
    assert image["Id"] == evidence["imageId"]
    assert image["Os"] == "linux" and image["Architecture"] == "amd64"
    assert evidence["platform"] == {"os": "linux", "architecture": "amd64"}
    assert descriptor["digest"] == evidence["manifestDigest"] == reference.rsplit("@", 1)[1]
    assert descriptor["mediaType"] == evidence["mediaType"] in manifest_types
    assert reference in image["RepoDigests"]
    assert labels["io.cauce.source.digest"] == evidence["sourceDigest"]
    assert labels["org.opencontainers.image.revision"] == build["sourceRevision"]["commit"]
    assert labels["io.cauce.target-platform"] == "linux/amd64"
    if kind == "runtime":
        assert labels["org.opencontainers.image.base.name"] == bases["node"]["repositoryDigest"]
        assert labels["io.cauce.base.node.repository-digest"] == bases["node"]["repositoryDigest"]
        assert labels["io.cauce.base.python.repository-digest"] == bases["python"]["repositoryDigest"]
        assert labels["io.cauce.schema.compatible-through"] == build["schemaCompatibility"]["compatibleThrough"]
        assert labels.get("io.cauce.base.nginx.repository-digest") is None
    else:
        assert labels["org.opencontainers.image.base.name"] == bases["nginx"]["repositoryDigest"]
        assert labels["io.cauce.base.nginx.repository-digest"] == bases["nginx"]["repositoryDigest"]
        assert labels.get("io.cauce.base.node.repository-digest") is None
        assert labels.get("io.cauce.base.python.repository-digest") is None
        assert labels["io.cauce.console.publish-journal"] == evidence["publishJournalCapability"]
except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
    raise SystemExit(1)
PY
}
validate_selected_image runtime "$runtime_ref" || {
  printf 'release gate failed: runtime descriptor, labels or platform differ from build evidence\n' >&2
  exit 1
}
validate_selected_image console "$console_ref" || {
  printf 'release gate failed: console descriptor, labels or platform differ from build evidence\n' >&2
  exit 1
}
read -r expected_runtime_id expected_console_id expected_compose_id < <(python3 - "$ROOT/artifacts/release/build.json" "$ROOT/artifacts/compose-authentic/report.json" <<'PY'
import json, pathlib, sys
build = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
report = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
print(build["runtime"]["imageDigest"], build["console"]["imageDigest"], report["imageDigest"])
PY
)
[[ $runtime_id == "$expected_runtime_id" ]] || { printf 'release gate failed: runtime digest differs from build evidence\n' >&2; exit 1; }
[[ $console_id == "$expected_console_id" ]] || { printf 'release gate failed: console digest differs from build evidence\n' >&2; exit 1; }
[[ $runtime_id == "$expected_compose_id" ]] || { printf 'release gate failed: deployed runtime differs from compose-authentic evidence\n' >&2; exit 1; }
if [[ $fleet_mode == final ]]; then
  printf 'release gate passed with strict fleet parity\n'
else
  printf 'release gate passed for bounded Zeus maintenance; final strict fleet gate remains mandatory\n'
fi
