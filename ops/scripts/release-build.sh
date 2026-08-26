#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OPS="$ROOT/ops"
: "${CAUCE_RELEASE_COMMIT:?set the exact full commit ID of the clean release candidate}"
: "${CAUCE_RUNTIME_REPOSITORY:?set the immutable runtime registry repository (without tag or digest)}"
: "${CAUCE_CONSOLE_REPOSITORY:?set the immutable console registry repository (without tag or digest)}"
: "${CAUCE_NODE_BASE_IMAGE:?set the exact Node base repository@sha256 reference}"
: "${CAUCE_PYTHON_BASE_IMAGE:?set the exact Python base repository@sha256 reference}"
: "${CAUCE_NGINX_BASE_IMAGE:?set the exact nginx base repository@sha256 reference}"
target_platform=linux/amd64

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
validate_image_reference() {
  IMAGE_REFERENCE=$1 python3 - <<'PY'
import os, re
value = os.environ["IMAGE_REFERENCE"]
component = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
pattern = re.compile(rf"^{component}(?::[0-9]+)?(?:/{component})+@sha256:[a-f0-9]{{64}}$")
raise SystemExit(0 if pattern.fullmatch(value) else 1)
PY
}
validate_image_reference "$CAUCE_NODE_BASE_IMAGE" || {
  printf 'release build failed: Node base must be an immutable canonical RepoDigest\n' >&2
  exit 2
}
validate_image_reference "$CAUCE_PYTHON_BASE_IMAGE" || {
  printf 'release build failed: Python base must be an immutable canonical RepoDigest\n' >&2
  exit 2
}
validate_image_reference "$CAUCE_NGINX_BASE_IMAGE" || {
  printf 'release build failed: nginx base must be an immutable canonical RepoDigest\n' >&2
  exit 2
}
[[ ${CAUCE_NODE_BASE_IMAGE%@*} == docker.io/library/node ]] || {
  printf 'release build failed: Node base has the wrong repository role\n' >&2
  exit 2
}
[[ ${CAUCE_PYTHON_BASE_IMAGE%@*} == docker.io/library/python ]] || {
  printf 'release build failed: Python base has the wrong repository role\n' >&2
  exit 2
}
[[ ${CAUCE_NGINX_BASE_IMAGE%@*} == docker.io/nginxinc/nginx-unprivileged ]] || {
  printf 'release build failed: nginx base has the wrong repository role\n' >&2
  exit 2
}
[[ $CAUCE_NODE_BASE_IMAGE != "$CAUCE_PYTHON_BASE_IMAGE" \
   && $CAUCE_NODE_BASE_IMAGE != "$CAUCE_NGINX_BASE_IMAGE" \
   && $CAUCE_PYTHON_BASE_IMAGE != "$CAUCE_NGINX_BASE_IMAGE" ]] || {
  printf 'release build failed: Node, Python and nginx bases must be distinct images\n' >&2
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
  1) release_pull=1; pull_args=(--pull) ;;
  0) release_pull=0 ;;
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

# Provenance labels are only meaningful if the committed Dockerfile actually roots every stage in
# the three pinned inputs. Keep the stage graph explicit: a new external FROM or a retargeted final
# stage must update this gate and its regression tests before it can publish a release.
DOCKERFILE="$context/deploy/Dockerfile" python3 - <<'PY' || {
import os
import pathlib
import re

dockerfile = pathlib.Path(os.environ["DOCKERFILE"])
observed = []
for raw in dockerfile.read_text(encoding="utf-8").splitlines():
    match = re.fullmatch(r"\s*FROM\s+(\S+)\s+AS\s+([A-Za-z0-9._-]+)\s*", raw, re.IGNORECASE)
    if match:
        observed.append((match.group(1), match.group(2)))
expected = [
    ("${CAUCE_NODE_BASE}", "build"),
    ("${CAUCE_NODE_BASE}", "production-dependencies"),
    ("${CAUCE_PYTHON_BASE}", "python-runtime"),
    ("${CAUCE_NODE_BASE}", "runtime"),
    ("runtime", "qa-runtime"),
    ("runtime", "authentic-harness"),
    ("${CAUCE_NGINX_BASE}", "console-base"),
    ("console-base", "console-dev"),
    ("console-base", "console"),
]
raise SystemExit(0 if observed == expected else 1)
PY
  printf 'release build failed: committed Dockerfile stage lineage is not bound to the pinned bases\n' >&2
  exit 2
}

source_digest=$(python3 "$context/ops/scripts/source-digest.py" --root "$context" --domain runtime)
console_source_digest=$(python3 "$context/ops/scripts/source-digest.py" --root "$context" --domain console)
[[ $source_digest =~ ^sha256:[a-f0-9]{64}$ && $console_source_digest =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf 'release build failed: source digest is invalid\n' >&2
  exit 1
}

# Online releases pull the three exact child manifests for linux/amd64. Offline diagnostic builds
# never issue a base pull: all three descriptors must already be present and locally inspectable.
if [[ $release_pull == 1 ]]; then
  docker pull --platform "$target_platform" "$CAUCE_NODE_BASE_IMAGE" >/dev/null
  docker pull --platform "$target_platform" "$CAUCE_PYTHON_BASE_IMAGE" >/dev/null
  docker pull --platform "$target_platform" "$CAUCE_NGINX_BASE_IMAGE" >/dev/null
fi

inspect_base() {
  local reference=$1 serialized
  serialized=$(docker image inspect --format '{{json .}}' "$reference") || return 1
  BASE_REFERENCE=$reference BASE_INSPECT=$serialized python3 - <<'PY'
import json
import os
import re

digest_pattern = re.compile(r"sha256:[a-f0-9]{64}")
manifest_types = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}


def normalized_repository(value: str) -> str:
    first = value.split("/", 1)[0]
    if "." not in first and ":" not in first and first != "localhost":
        value = f"docker.io/{value}" if "/" in value else f"docker.io/library/{value}"
    if value.startswith("index.docker.io/"):
        value = "docker.io/" + value.removeprefix("index.docker.io/")
    return value


try:
    image = json.loads(os.environ["BASE_INSPECT"])
    reference = os.environ["BASE_REFERENCE"]
    repository, manifest_digest = reference.rsplit("@", 1)
    descriptor = image["Descriptor"]
    identifier = image["Id"]
    media_type = descriptor["mediaType"]
    repo_digests = image["RepoDigests"]
    os_name = image["Os"]
    architecture = image["Architecture"]
    assert isinstance(image, dict)
    assert digest_pattern.fullmatch(identifier)
    assert digest_pattern.fullmatch(manifest_digest)
    assert descriptor["digest"] == manifest_digest
    assert media_type in manifest_types
    assert os_name == "linux" and architecture == "amd64"
    assert isinstance(repo_digests, list) and any(
        isinstance(value, str)
        and "@" in value
        and normalized_repository(value.rsplit("@", 1)[0]) == normalized_repository(repository)
        and value.rsplit("@", 1)[1] == manifest_digest
        for value in repo_digests
    )
except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
print("\t".join((identifier, manifest_digest, media_type, os_name, architecture)))
PY
}

IFS=$'\t' read -r node_base_id node_base_manifest node_base_media node_base_os node_base_arch \
  < <(inspect_base "$CAUCE_NODE_BASE_IMAGE") || {
  printf 'release build failed: Node base is not a locally bound linux/amd64 child manifest\n' >&2
  exit 1
}
IFS=$'\t' read -r python_base_id python_base_manifest python_base_media python_base_os python_base_arch \
  < <(inspect_base "$CAUCE_PYTHON_BASE_IMAGE") || {
  printf 'release build failed: Python base is not a locally bound linux/amd64 child manifest\n' >&2
  exit 1
}
IFS=$'\t' read -r nginx_base_id nginx_base_manifest nginx_base_media nginx_base_os nginx_base_arch \
  < <(inspect_base "$CAUCE_NGINX_BASE_IMAGE") || {
  printf 'release build failed: nginx base is not a locally bound linux/amd64 child manifest\n' >&2
  exit 1
}
[[ $node_base_manifest != "$python_base_manifest" \
   && $node_base_manifest != "$nginx_base_manifest" \
   && $python_base_manifest != "$nginx_base_manifest" \
   && $node_base_id != "$python_base_id" \
   && $node_base_id != "$nginx_base_id" \
   && $python_base_id != "$nginx_base_id" ]] || {
  printf 'release build failed: base manifests and image IDs must be role-distinct\n' >&2
  exit 1
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
# Docker 29/BuildKit emits a provenance attestation by default. That turns the
# pushed tag into an OCI index, so a digest pull no longer identifies the exact
# single-platform image ID that passed the package smoke below. Release evidence
# deliberately accepts only a child manifest; disable the default attestation
# at build time instead of weakening the recovery gate.
docker build "${pull_args[@]}" --provenance=false --platform "$target_platform" \
  --build-arg "CAUCE_NODE_BASE=$CAUCE_NODE_BASE_IMAGE" \
  --build-arg "CAUCE_PYTHON_BASE=$CAUCE_PYTHON_BASE_IMAGE" \
  --build-arg "CAUCE_NGINX_BASE=$CAUCE_NGINX_BASE_IMAGE" \
  --build-arg "CAUCE_TARGET_PLATFORM=$target_platform" \
  --build-arg "CAUCE_SOURCE_DIGEST=$source_digest" \
  --build-arg "CAUCE_RELEASE_COMMIT=$actual_commit" \
  --build-arg "CAUCE_SCHEMA_COMPATIBLE_THROUGH=$schema_compatible_through" \
  --target runtime -t "$runtime_tag" -f "$context/deploy/Dockerfile" "$context"
docker build "${pull_args[@]}" --provenance=false --platform "$target_platform" \
  --build-arg "CAUCE_NODE_BASE=$CAUCE_NODE_BASE_IMAGE" \
  --build-arg "CAUCE_PYTHON_BASE=$CAUCE_PYTHON_BASE_IMAGE" \
  --build-arg "CAUCE_NGINX_BASE=$CAUCE_NGINX_BASE_IMAGE" \
  --build-arg "CAUCE_TARGET_PLATFORM=$target_platform" \
  --build-arg "CAUCE_SOURCE_DIGEST=$console_source_digest" \
  --build-arg "CAUCE_RELEASE_COMMIT=$actual_commit" \
  --target console -t "$console_tag" -f "$context/deploy/Dockerfile" "$context"

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
recorded_runtime_source=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.source.digest" }}' "$runtime_tag")
recorded_runtime_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$runtime_tag")
recorded_runtime_base=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.base.name" }}' "$runtime_tag")
recorded_runtime_node=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.base.node.repository-digest" }}' "$runtime_tag")
recorded_runtime_python=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.base.python.repository-digest" }}' "$runtime_tag")
recorded_runtime_platform=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.target-platform" }}' "$runtime_tag")
recorded_console_source=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.source.digest" }}' "$console_tag")
recorded_console_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$console_tag")
recorded_console_base=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.base.name" }}' "$console_tag")
recorded_console_nginx=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.base.nginx.repository-digest" }}' "$console_tag")
recorded_console_journal=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.console.publish-journal" }}' "$console_tag")
recorded_console_platform=$(docker image inspect --format '{{ index .Config.Labels "io.cauce.target-platform" }}' "$console_tag")
[[ $recorded_runtime_source == "$source_digest" \
   && $recorded_runtime_revision == "$actual_commit" \
   && $recorded_runtime_base == "$CAUCE_NODE_BASE_IMAGE" \
   && $recorded_runtime_node == "$CAUCE_NODE_BASE_IMAGE" \
   && $recorded_runtime_python == "$CAUCE_PYTHON_BASE_IMAGE" \
   && $recorded_runtime_platform == "$target_platform" \
   && $recorded_console_source == "$console_source_digest" \
   && $recorded_console_revision == "$actual_commit" \
   && $recorded_console_base == "$CAUCE_NGINX_BASE_IMAGE" \
   && $recorded_console_nginx == "$CAUCE_NGINX_BASE_IMAGE" \
   && $recorded_console_journal == multi-intent-v1 \
   && $recorded_console_platform == "$target_platform" ]] || {
  printf 'release build failed: final image provenance labels mismatch\n' >&2
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
docker pull --platform "$target_platform" "$runtime_repository_digest" >/dev/null
docker pull --platform "$target_platform" "$console_repository_digest" >/dev/null

inspect_final() {
  local kind=$1 reference=$2 expected_id=$3 expected_source=$4 serialized
  serialized=$(docker image inspect --format '{{json .}}' "$reference") || return 1
  FINAL_KIND=$kind FINAL_REFERENCE=$reference FINAL_EXPECTED_ID=$expected_id \
    FINAL_EXPECTED_SOURCE=$expected_source FINAL_EXPECTED_REVISION=$actual_commit \
    FINAL_EXPECTED_NODE=$CAUCE_NODE_BASE_IMAGE FINAL_EXPECTED_PYTHON=$CAUCE_PYTHON_BASE_IMAGE \
    FINAL_EXPECTED_NGINX=$CAUCE_NGINX_BASE_IMAGE FINAL_EXPECTED_SCHEMA=$schema_compatible_through \
    FINAL_INSPECT=$serialized python3 - <<'PY'
import json
import os
import re

digest_pattern = re.compile(r"sha256:[a-f0-9]{64}")
manifest_types = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}

try:
    image = json.loads(os.environ["FINAL_INSPECT"])
    reference = os.environ["FINAL_REFERENCE"]
    manifest_digest = reference.rsplit("@", 1)[1]
    descriptor = image["Descriptor"]
    labels = image["Config"]["Labels"]
    identifier = image["Id"]
    media_type = descriptor["mediaType"]
    os_name = image["Os"]
    architecture = image["Architecture"]
    assert digest_pattern.fullmatch(identifier)
    assert identifier == os.environ["FINAL_EXPECTED_ID"]
    assert descriptor["digest"] == manifest_digest
    assert media_type in manifest_types
    assert os_name == "linux" and architecture == "amd64"
    assert isinstance(image["RepoDigests"], list) and reference in image["RepoDigests"]
    assert isinstance(labels, dict)
    assert labels.get("io.cauce.source.digest") == os.environ["FINAL_EXPECTED_SOURCE"]
    assert labels.get("org.opencontainers.image.revision") == os.environ["FINAL_EXPECTED_REVISION"]
    assert labels.get("io.cauce.target-platform") == "linux/amd64"
    if os.environ["FINAL_KIND"] == "runtime":
        assert labels.get("org.opencontainers.image.base.name") == os.environ["FINAL_EXPECTED_NODE"]
        assert labels.get("io.cauce.base.node.repository-digest") == os.environ["FINAL_EXPECTED_NODE"]
        assert labels.get("io.cauce.base.python.repository-digest") == os.environ["FINAL_EXPECTED_PYTHON"]
        assert labels.get("io.cauce.schema.compatible-through") == os.environ["FINAL_EXPECTED_SCHEMA"]
        assert labels.get("io.cauce.base.nginx.repository-digest") is None
    else:
        assert labels.get("org.opencontainers.image.base.name") == os.environ["FINAL_EXPECTED_NGINX"]
        assert labels.get("io.cauce.base.nginx.repository-digest") == os.environ["FINAL_EXPECTED_NGINX"]
        assert labels.get("io.cauce.console.publish-journal") == "multi-intent-v1"
        assert labels.get("io.cauce.base.node.repository-digest") is None
        assert labels.get("io.cauce.base.python.repository-digest") is None
except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
print("\t".join((identifier, manifest_digest, media_type, os_name, architecture)))
PY
}

IFS=$'\t' read -r recovered_runtime_id runtime_manifest runtime_media runtime_os runtime_arch \
  < <(inspect_final runtime "$runtime_repository_digest" "$runtime_id" "$source_digest") || {
  printf 'release build failed: recovered runtime identity, labels or platform mismatch\n' >&2
  exit 1
}
IFS=$'\t' read -r recovered_console_id console_manifest console_media console_os console_arch \
  < <(inspect_final console "$console_repository_digest" "$console_id" "$console_source_digest") || {
  printf 'release build failed: recovered console identity, labels or platform mismatch\n' >&2
  exit 1
}
[[ $recovered_runtime_id == "$runtime_id" && $recovered_console_id == "$console_id" ]] || {
  printf 'release build failed: a registry digest did not recover the tested image ID\n' >&2
  exit 1
}

dockerfile_sha="sha256:$(sha256sum "$context/deploy/Dockerfile" | cut -d' ' -f1)"
dockerignore_sha="sha256:$(sha256sum "$context/.dockerignore" | cut -d' ' -f1)"
operations_digest=$(python3 "$context/ops/scripts/container_ops_digest.py")
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out="$OPS/artifacts/release"
mkdir -p "$out"

RUNTIME_ID=$runtime_id CONSOLE_ID=$console_id \
  RUNTIME_REPOSITORY_DIGEST=$runtime_repository_digest \
  CONSOLE_REPOSITORY_DIGEST=$console_repository_digest \
  NODE_BASE_REPOSITORY_DIGEST=$CAUCE_NODE_BASE_IMAGE NODE_BASE_ID=$node_base_id \
  NODE_BASE_MANIFEST=$node_base_manifest NODE_BASE_MEDIA=$node_base_media \
  NODE_BASE_OS=$node_base_os NODE_BASE_ARCH=$node_base_arch \
  PYTHON_BASE_REPOSITORY_DIGEST=$CAUCE_PYTHON_BASE_IMAGE PYTHON_BASE_ID=$python_base_id \
  PYTHON_BASE_MANIFEST=$python_base_manifest PYTHON_BASE_MEDIA=$python_base_media \
  PYTHON_BASE_OS=$python_base_os PYTHON_BASE_ARCH=$python_base_arch \
  NGINX_BASE_REPOSITORY_DIGEST=$CAUCE_NGINX_BASE_IMAGE NGINX_BASE_ID=$nginx_base_id \
  NGINX_BASE_MANIFEST=$nginx_base_manifest NGINX_BASE_MEDIA=$nginx_base_media \
  NGINX_BASE_OS=$nginx_base_os NGINX_BASE_ARCH=$nginx_base_arch \
  RUNTIME_MANIFEST=$runtime_manifest RUNTIME_MEDIA=$runtime_media \
  RUNTIME_OS=$runtime_os RUNTIME_ARCH=$runtime_arch \
  CONSOLE_MANIFEST=$console_manifest CONSOLE_MEDIA=$console_media \
  CONSOLE_OS=$console_os CONSOLE_ARCH=$console_arch \
  DOCKERFILE_SHA=$dockerfile_sha DOCKERIGNORE_SHA=$dockerignore_sha SOURCE_DIGEST=$source_digest \
  CONSOLE_SOURCE_DIGEST=$console_source_digest OPERATIONS_DIGEST=$operations_digest \
  SCHEMA_COMPATIBLE_THROUGH=$schema_compatible_through RELEASE_COMMIT=$actual_commit RELEASE_TREE=$actual_tree \
  EXCLUDED_GRAFO_PRESENT=$excluded_grafo_present \
  STARTED_AT=$started_at FINISHED_AT=$finished_at RUNTIME_TAG=$runtime_tag CONSOLE_TAG=$console_tag \
  python3 - "$out/build.json" <<'PY'
import json, os, pathlib, sys
payload = {
    "schemaVersion": 7,
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
    "baseImages": {
        "node": {
            "role": "node",
            "repositoryDigest": os.environ["NODE_BASE_REPOSITORY_DIGEST"],
            "manifestDigest": os.environ["NODE_BASE_MANIFEST"],
            "mediaType": os.environ["NODE_BASE_MEDIA"],
            "platform": {"os": os.environ["NODE_BASE_OS"], "architecture": os.environ["NODE_BASE_ARCH"]},
            "imageId": os.environ["NODE_BASE_ID"],
        },
        "python": {
            "role": "python",
            "repositoryDigest": os.environ["PYTHON_BASE_REPOSITORY_DIGEST"],
            "manifestDigest": os.environ["PYTHON_BASE_MANIFEST"],
            "mediaType": os.environ["PYTHON_BASE_MEDIA"],
            "platform": {"os": os.environ["PYTHON_BASE_OS"], "architecture": os.environ["PYTHON_BASE_ARCH"]},
            "imageId": os.environ["PYTHON_BASE_ID"],
        },
        "nginx": {
            "role": "nginx",
            "repositoryDigest": os.environ["NGINX_BASE_REPOSITORY_DIGEST"],
            "manifestDigest": os.environ["NGINX_BASE_MANIFEST"],
            "mediaType": os.environ["NGINX_BASE_MEDIA"],
            "platform": {"os": os.environ["NGINX_BASE_OS"], "architecture": os.environ["NGINX_BASE_ARCH"]},
            "imageId": os.environ["NGINX_BASE_ID"],
        },
    },
    "runtime": {
        "tag": os.environ["RUNTIME_TAG"],
        "imageId": os.environ["RUNTIME_ID"],
        "imageDigest": os.environ["RUNTIME_ID"],
        "repositoryDigest": os.environ["RUNTIME_REPOSITORY_DIGEST"],
        "manifestDigest": os.environ["RUNTIME_MANIFEST"],
        "mediaType": os.environ["RUNTIME_MEDIA"],
        "platform": {"os": os.environ["RUNTIME_OS"], "architecture": os.environ["RUNTIME_ARCH"]},
        "sourceDigest": os.environ["SOURCE_DIGEST"],
        "sourceDigestDomain": "runtime",
    },
    "console": {
        "tag": os.environ["CONSOLE_TAG"],
        "imageId": os.environ["CONSOLE_ID"],
        "imageDigest": os.environ["CONSOLE_ID"],
        "repositoryDigest": os.environ["CONSOLE_REPOSITORY_DIGEST"],
        "manifestDigest": os.environ["CONSOLE_MANIFEST"],
        "mediaType": os.environ["CONSOLE_MEDIA"],
        "platform": {"os": os.environ["CONSOLE_OS"], "architecture": os.environ["CONSOLE_ARCH"]},
        "sourceDigest": os.environ["CONSOLE_SOURCE_DIGEST"],
        "sourceDigestDomain": "console",
        "publishJournalCapability": "multi-intent-v1",
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
