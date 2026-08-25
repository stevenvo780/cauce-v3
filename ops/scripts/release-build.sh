#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OPS="$ROOT/ops"
: "${CAUCE_RELEASE_COMMIT:?set the exact full commit ID of the clean release candidate}"
: "${CAUCE_RUNTIME_REPOSITORY:?set the immutable runtime registry repository (without tag or digest)}"
: "${CAUCE_CONSOLE_REPOSITORY:?set the immutable console registry repository (without tag or digest)}"

# The runtime Dockerfile deliberately uses BuildKit-only COPY semantics
# (`--chmod`) so executable modes are part of the image definition.  Do not
# inherit the daemon/client legacy-builder default: a release invocation must
# select the builder it requires by itself.
export DOCKER_BUILDKIT=1

command -v docker >/dev/null 2>&1 || { printf 'release build failed: docker is unavailable\n' >&2; exit 127; }
command -v git >/dev/null 2>&1 || { printf 'release build failed: git is unavailable\n' >&2; exit 127; }
command -v tar >/dev/null 2>&1 || { printf 'release build failed: tar is unavailable\n' >&2; exit 127; }
docker build --help >/dev/null 2>&1 || { printf 'release build failed: docker build is unavailable\n' >&2; exit 127; }

validate_repository() {
  REPOSITORY=$1 python3 - <<'PY'
import os, re, sys
value = os.environ["REPOSITORY"]
component = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
pattern = re.compile(rf"^{component}(?::[0-9]+)?(?:/{component})+$")
raise SystemExit(0 if pattern.fullmatch(value) else 1)
PY
}
validate_repository "$CAUCE_RUNTIME_REPOSITORY" || {
  printf 'release build failed: runtime repository is not a canonical registry repository\n' >&2
  exit 2
}
validate_repository "$CAUCE_CONSOLE_REPOSITORY" || {
  printf 'release build failed: console repository is not a canonical registry repository\n' >&2
  exit 2
}

actual_commit=$(git -C "$ROOT" rev-parse --verify 'HEAD^{commit}') || {
  printf 'release build failed: repository HEAD is not a commit\n' >&2
  exit 2
}
[[ $CAUCE_RELEASE_COMMIT =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && $actual_commit == "$CAUCE_RELEASE_COMMIT" ]] || {
  printf 'release build failed: CAUCE_RELEASE_COMMIT does not equal the checked-out full HEAD\n' >&2
  exit 2
}
actual_tree=$(git -C "$ROOT" rev-parse --verify 'HEAD^{tree}')
[[ $actual_tree =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || {
  printf 'release build failed: release tree ID is invalid\n' >&2
  exit 2
}
if ! git -C "$ROOT" diff --quiet --no-ext-diff -- || \
   ! git -C "$ROOT" diff --cached --quiet --no-ext-diff --; then
  printf 'release build failed: release candidate index or tracked worktree is not clean\n' >&2
  exit 2
fi

# One operator-owned SQL scratch tree is deliberately retained on this host.
# It is not a release input: the build comes from git archive, source-digest
# excludes this exact prefix, and .dockerignore excludes it from ad-hoc Docker
# contexts. Every other visible untracked path fails the release.
excluded_grafo_present=0
while IFS= read -r -d '' status_entry; do
  if [[ $status_entry == '?? apps/console/src/features/_grafo/'* ]]; then
    excluded_grafo_present=1
    continue
  fi
  printf 'release build failed: release candidate contains an unapproved untracked path\n' >&2
  exit 2
done < <(git -C "$ROOT" status --porcelain=v1 -z --untracked-files=all)

pull_args=()
case ${CAUCE_RELEASE_PULL:-1} in
  1) pull_args=(--pull) ;;
  0) ;;
  *) printf 'release build failed: CAUCE_RELEASE_PULL must be 0 or 1\n' >&2; exit 2 ;;
esac

# Docker receives an archive of the committed RC, not the operator worktree.
# This is a second boundary after the clean-tree check: ignored caches and local
# scratch files can never enter a release context.
context_parent=$(mktemp -d)
context="$context_parent/source"
mkdir -m 0700 "$context"
cleanup() { rm -rf -- "$context_parent"; }
trap cleanup EXIT
git -C "$ROOT" archive --format=tar "$actual_commit" | tar -xf - -C "$context"

if [[ -e $context/apps/console/src/features/_grafo ]]; then
  printf 'release build failed: operator-local _grafo content entered the committed RC\n' >&2
  exit 2
fi
grep -Fqx 'apps/console/src/features/_grafo/' "$context/.dockerignore" || {
  printf 'release build failed: committed build-context policy does not exclude operator scratch\n' >&2
  exit 2
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
schema_compatible_through=$(find "$context/packages/store/migrations" -maxdepth 1 -type f -name '*.sql' \
  -printf '%f\n' | LC_ALL=C sort | tail -n1)
[[ $schema_compatible_through =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || {
  printf 'release build failed: latest migration name is invalid\n' >&2
  exit 1
}

runtime_tag="${CAUCE_RUNTIME_REPOSITORY}:rc-${actual_commit}"
console_tag="${CAUCE_CONSOLE_REPOSITORY}:rc-${actual_commit}"
docker build "${pull_args[@]}" --build-arg "CAUCE_SCHEMA_COMPATIBLE_THROUGH=$schema_compatible_through" \
  --target runtime -t "$runtime_tag" -f "$context/deploy/Dockerfile" "$context"
docker build "${pull_args[@]}" --target console -t "$console_tag" -f "$context/deploy/Dockerfile" "$context"

# Exercise the packaged final runtime, including the non-importable terminal
# relay entrypoint and outbox metrics module, before publication.
docker run --rm --entrypoint node "$runtime_tag" deploy/runtime-package-smoke.mjs >/dev/null
runtime_id=$(docker image inspect --format '{{.Id}}' "$runtime_tag")
console_id=$(docker image inspect --format '{{.Id}}' "$console_tag")
[[ $runtime_id =~ ^sha256:[a-f0-9]{64}$ && $console_id =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf 'release build returned invalid image IDs\n' >&2
  exit 1
}
recorded_schema=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.schema.compatible-through" }}' "$runtime_tag")
[[ $recorded_schema == "$schema_compatible_through" ]] || {
  printf 'release build failed: runtime schema compatibility label mismatch\n' >&2
  exit 1
}

# A local config ID is not a deployable digest. Publish both images, select the
# exact repository digest reported by Docker, then pull that digest and prove it
# resolves back to the image that passed packaging smoke.
docker push "$runtime_tag" >/dev/null
docker push "$console_tag" >/dev/null
repository_digest() {
  local tag=$1 repository=$2 serialized
  serialized=$(docker image inspect --format '{{json .RepoDigests}}' "$tag") || return 1
  REPOSITORY=$repository REPO_DIGESTS=$serialized python3 - <<'PY'
import json, os, re, sys
repository = os.environ["REPOSITORY"]
try:
    values = json.loads(os.environ["REPO_DIGESTS"])
except json.JSONDecodeError:
    raise SystemExit(1)
matches = sorted({value for value in values if re.fullmatch(re.escape(repository) + r"@sha256:[a-f0-9]{64}", value)})
if len(matches) != 1:
    raise SystemExit(1)
print(matches[0])
PY
}
runtime_repository_digest=$(repository_digest "$runtime_tag" "$CAUCE_RUNTIME_REPOSITORY") || {
  printf 'release build failed: runtime push did not yield one exact repository digest\n' >&2
  exit 1
}
console_repository_digest=$(repository_digest "$console_tag" "$CAUCE_CONSOLE_REPOSITORY") || {
  printf 'release build failed: console push did not yield one exact repository digest\n' >&2
  exit 1
}
docker pull "$runtime_repository_digest" >/dev/null
docker pull "$console_repository_digest" >/dev/null
recovered_runtime_id=$(docker image inspect --format '{{.Id}}' "$runtime_repository_digest")
recovered_console_id=$(docker image inspect --format '{{.Id}}' "$console_repository_digest")
[[ $recovered_runtime_id == "$runtime_id" && $recovered_console_id == "$console_id" ]] || {
  printf 'release build failed: a registry digest did not recover the tested image ID\n' >&2
  exit 1
}

dockerfile_sha="sha256:$(sha256sum "$context/deploy/Dockerfile" | cut -d' ' -f1)"
dockerignore_sha="sha256:$(sha256sum "$context/.dockerignore" | cut -d' ' -f1)"
source_digest=$(python3 "$context/ops/scripts/source-digest.py" --root "$context" --domain runtime)
console_source_digest=$(python3 "$context/ops/scripts/source-digest.py" --root "$context" --domain console)
operations_digest=$(python3 "$context/ops/scripts/container_ops_digest.py")
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out="$OPS/artifacts/release"
mkdir -p "$out"

RUNTIME_ID=$runtime_id CONSOLE_ID=$console_id \
  RUNTIME_REPOSITORY_DIGEST=$runtime_repository_digest \
  CONSOLE_REPOSITORY_DIGEST=$console_repository_digest \
  DOCKERFILE_SHA=$dockerfile_sha DOCKERIGNORE_SHA=$dockerignore_sha SOURCE_DIGEST=$source_digest \
  CONSOLE_SOURCE_DIGEST=$console_source_digest OPERATIONS_DIGEST=$operations_digest \
  SCHEMA_COMPATIBLE_THROUGH=$schema_compatible_through RELEASE_COMMIT=$actual_commit RELEASE_TREE=$actual_tree \
  EXCLUDED_GRAFO_PRESENT=$excluded_grafo_present \
  STARTED_AT=$started_at FINISHED_AT=$finished_at RUNTIME_TAG=$runtime_tag CONSOLE_TAG=$console_tag \
  python3 - "$out/build.json" <<'PY'
import json, os, pathlib, sys
payload = {
    "schemaVersion": 5,
    "evidenceClass": "release-build",
    "mechanism": "docker-build-push-pull-final-image",
    "imageDigest": os.environ["RUNTIME_ID"],
    "sourceDigest": os.environ["SOURCE_DIGEST"],
    "sourceDigestDomain": "runtime",
    "operationsDigest": os.environ["OPERATIONS_DIGEST"],
    "timestamps": {"startedAt": os.environ["STARTED_AT"], "finishedAt": os.environ["FINISHED_AT"]},
    "dockerfileSha256": os.environ["DOCKERFILE_SHA"],
    "dockerignoreSha256": os.environ["DOCKERIGNORE_SHA"],
    "sourceRevision": {
        "commit": os.environ["RELEASE_COMMIT"],
        "tree": os.environ["RELEASE_TREE"],
        "worktreeStatus": "tracked-and-index-clean",
        "untrackedPolicy": "only-apps-console-src-features-grafo",
        "excludedUntrackedPresent": os.environ["EXCLUDED_GRAFO_PRESENT"] == "1",
        "buildContext": "git-archive",
    },
    "runtime": {
        "tag": os.environ["RUNTIME_TAG"],
        "imageId": os.environ["RUNTIME_ID"],
        "imageDigest": os.environ["RUNTIME_ID"],
        "repositoryDigest": os.environ["RUNTIME_REPOSITORY_DIGEST"],
        "sourceDigest": os.environ["SOURCE_DIGEST"],
        "sourceDigestDomain": "runtime",
    },
    "console": {
        "tag": os.environ["CONSOLE_TAG"],
        "imageId": os.environ["CONSOLE_ID"],
        "imageDigest": os.environ["CONSOLE_ID"],
        "repositoryDigest": os.environ["CONSOLE_REPOSITORY_DIGEST"],
        "sourceDigest": os.environ["CONSOLE_SOURCE_DIGEST"],
        "sourceDigestDomain": "console",
    },
    "runtimePackage": {
        "mechanism": "docker-run-final-image-package-smoke",
        "status": "passed",
        "components": [
            "gateway", "dispatcher", "relay-worker", "telegram-bridge", "shadow-router",
            "terminal-relay", "outbox-metrics",
        ],
    },
    "schemaCompatibility": {
        "label": "io.cauce.schema.compatible-through",
        "compatibleThrough": os.environ["SCHEMA_COMPATIBLE_THROUGH"],
    },
}
path = pathlib.Path(sys.argv[1])
temporary = path.with_suffix(".tmp")
temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
temporary.replace(path)
PY
"$OPS/scripts/manifest.sh" "$out" >/dev/null
printf 'release build evidence: %s/build.json\n' "$out"
