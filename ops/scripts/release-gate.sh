#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${CAUCE_ENV_FILE:-"$ROOT/config/prod.env"}
[[ -f $env_file ]] || { printf 'release gate failed: missing private production env file\n' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { printf 'release gate failed: docker is unavailable\n' >&2; exit 127; }
docker compose version >/dev/null 2>&1 || { printf 'release gate failed: Docker Compose v2 is unavailable\n' >&2; exit 127; }
docker build --help >/dev/null 2>&1 || { printf 'release gate failed: docker build is unavailable\n' >&2; exit 127; }
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
[[ ${CAUCE_RUNTIME_IMAGE:-} == *@sha256:* ]] || { printf 'release gate failed: runtime image is not digest-pinned\n' >&2; exit 2; }
[[ ${CAUCE_CONSOLE_IMAGE:-} == *@sha256:* ]] || { printf 'release gate failed: console image is not digest-pinned\n' >&2; exit 2; }
compose=(docker compose -f "$ROOT/../deploy/compose.yaml")
if [[ ${CAUCE_LOCAL_POSTGRES:-0} == 1 ]]; then compose+=(-f "$ROOT/../deploy/compose.postgres.yaml"); fi
"${compose[@]}" config --quiet
mapfile -t compose_images < <("${compose[@]}" config --images)
for image in "${compose_images[@]}"; do
  [[ $image == *@sha256:* ]] || { printf 'release gate failed: compose image is not digest-pinned: %s\n' "$image" >&2; exit 2; }
done
python3 "$ROOT/scripts/validate-manifests.py"
tmp_units=$(mktemp -d)
tmp_container_units=$(mktemp -d)
trap 'rm -rf "$tmp_units" "$tmp_container_units"' EXIT
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
for dir in compose-authentic release; do "$ROOT/scripts/verify-manifest.sh" "$ROOT/artifacts/$dir"; done
python3 "$ROOT/scripts/validate-release-evidence.py"
runtime_id=$(docker image inspect --format '{{.Id}}' "$CAUCE_RUNTIME_IMAGE") || { printf 'release gate failed: runtime digest is not present locally\n' >&2; exit 1; }
console_id=$(docker image inspect --format '{{.Id}}' "$CAUCE_CONSOLE_IMAGE") || { printf 'release gate failed: console digest is not present locally\n' >&2; exit 1; }
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
printf 'release gate passed\n'
