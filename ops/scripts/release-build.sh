#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OPS="$ROOT/ops"
: "${CAUCE_RUNTIME_BUILD_TAG:?set a local runtime build tag}"
: "${CAUCE_CONSOLE_BUILD_TAG:?set a local console build tag}"
command -v docker >/dev/null 2>&1 || { printf 'release build failed: docker is unavailable\n' >&2; exit 127; }
docker build --help >/dev/null 2>&1 || { printf 'release build failed: docker build is unavailable\n' >&2; exit 127; }
pull_args=()
case ${CAUCE_RELEASE_PULL:-1} in
  1) pull_args=(--pull) ;;
  0) ;;
  *) printf 'release build failed: CAUCE_RELEASE_PULL must be 0 or 1\n' >&2; exit 2 ;;
esac
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker build "${pull_args[@]}" --target runtime -t "$CAUCE_RUNTIME_BUILD_TAG" -f "$ROOT/deploy/Dockerfile" "$ROOT"
docker build "${pull_args[@]}" --target console -t "$CAUCE_CONSOLE_BUILD_TAG" -f "$ROOT/deploy/Dockerfile" "$ROOT"
runtime_id=$(docker image inspect --format '{{.Id}}' "$CAUCE_RUNTIME_BUILD_TAG")
console_id=$(docker image inspect --format '{{.Id}}' "$CAUCE_CONSOLE_BUILD_TAG")
[[ $runtime_id =~ ^sha256:[a-f0-9]{64}$ && $console_id =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'release build returned invalid image IDs\n' >&2; exit 1; }
dockerfile_sha="sha256:$(sha256sum "$ROOT/deploy/Dockerfile" | cut -d' ' -f1)"
# One build produces two images from two different source families, so it records two digests.
# The runtime domain deliberately excludes apps/console: nothing under apps/console reaches the
# runtime stage of deploy/Dockerfile, so binding runtime evidence to it only created spurious
# invalidations. See ops/scripts/source-digest.py for the full causal argument.
source_digest=$(python3 "$OPS/scripts/source-digest.py" --domain runtime)
console_source_digest=$(python3 "$OPS/scripts/source-digest.py" --domain console)
operations_digest=$(python3 "$OPS/scripts/container_ops_digest.py")
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out="$OPS/artifacts/release"
mkdir -p "$out"
RUNTIME_ID=$runtime_id CONSOLE_ID=$console_id DOCKERFILE_SHA=$dockerfile_sha SOURCE_DIGEST=$source_digest \
  CONSOLE_SOURCE_DIGEST=$console_source_digest \
  OPERATIONS_DIGEST=$operations_digest \
  STARTED_AT=$started_at FINISHED_AT=$finished_at \
  RUNTIME_TAG=$CAUCE_RUNTIME_BUILD_TAG CONSOLE_TAG=$CAUCE_CONSOLE_BUILD_TAG \
  python3 - "$out/build.json" <<'PY'
import json, os, pathlib, sys
payload = {
    "schemaVersion": 3,
    "evidenceClass": "release-build",
    "mechanism": "docker-build-final-image",
    "imageDigest": os.environ["RUNTIME_ID"],
    "sourceDigest": os.environ["SOURCE_DIGEST"],
    "sourceDigestDomain": "runtime",
    "operationsDigest": os.environ["OPERATIONS_DIGEST"],
    "timestamps": {"startedAt": os.environ["STARTED_AT"], "finishedAt": os.environ["FINISHED_AT"]},
    "dockerfileSha256": os.environ["DOCKERFILE_SHA"],
    "runtime": {
        "tag": os.environ["RUNTIME_TAG"],
        "imageId": os.environ["RUNTIME_ID"],
        "imageDigest": os.environ["RUNTIME_ID"],
        "sourceDigest": os.environ["SOURCE_DIGEST"],
        "sourceDigestDomain": "runtime",
    },
    "console": {
        "tag": os.environ["CONSOLE_TAG"],
        "imageId": os.environ["CONSOLE_ID"],
        "imageDigest": os.environ["CONSOLE_ID"],
        "sourceDigest": os.environ["CONSOLE_SOURCE_DIGEST"],
        "sourceDigestDomain": "console",
    },
}
path = pathlib.Path(sys.argv[1])
tmp = path.with_suffix(".tmp")
tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
tmp.replace(path)
PY
"$OPS/scripts/manifest.sh" "$out" >/dev/null
printf 'release build evidence: %s/build.json\n' "$out"
