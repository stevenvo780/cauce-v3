#!/bin/bash
# Build the verified schema-037 bridge context, publish one runtime image, and emit private
# source-to-registry evidence. This deliberately uses the classic `docker build` interface: the
# authorized release builder does not need the buildx plugin.
set -euo pipefail

# Bash imports exported caller functions before this script starts.  Strip them
# before resolving any release tool so a function named `docker`, `git`,
# `python3`, or another dependency cannot override the canonical PATH below.
while IFS= read -r inherited_function; do
  builtin unset -f -- "$inherited_function"
done < <(builtin compgen -A function)

# Registry publication is a release control-plane operation.  Resolve binaries
# and Docker authority from the invoking account, never from caller-supplied
# daemon/context/config variables that could redirect an otherwise valid build
# and attestation to another engine or credential store.
system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly system_path
PATH=$system_path
export PATH
unset BASH_ENV ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONINSPECT NODE_OPTIONS
trusted_home=$(getent passwd "$(id -u)" | cut -d: -f6)
trusted_user=$(id -un)
[[ $trusted_home = /* && -d $trusted_home && ! -L $trusted_home ]] || {
  printf 'rollback bridge publish failed: invoking account has no trusted home\n' >&2
  exit 2
}
docker_config="$trusted_home/.docker"
if [[ -e $docker_config || -L $docker_config ]]; then
  [[ -d $docker_config && ! -L $docker_config ]] || {
    printf 'rollback bridge publish failed: trusted Docker config path is unsafe\n' >&2
    exit 2
  }
  read -r docker_config_owner docker_config_mode < <(stat -c '%u %a' -- "$docker_config")
  [[ ( $docker_config_owner == 0 || $docker_config_owner == "$(id -u)" ) \
     && $((8#$docker_config_mode & 0022)) == 0 ]] || {
    printf 'rollback bridge publish failed: trusted Docker config directory is not protected\n' >&2
    exit 2
  }
fi
HOME=$trusted_home
USER=$trusted_user
LOGNAME=$trusted_user
DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_CONFIG=$docker_config
export HOME USER LOGNAME DOCKER_HOST DOCKER_CONFIG
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION \
  DOCKER_AUTH_CONFIG DOCKER_DEFAULT_PLATFORM BUILDKIT_HOST BUILDX_CONFIG \
  COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE \
  COMPOSE_PROJECT_NAME COMPOSE_PROFILES

readonly BASE_COMMIT='79d6d8f1eae00e733bf2aeddaffeb592e5944687'
readonly PATCH_SHA256='b782f27857ebb688228bf958beaddb01a7f05af546267c8c10fccd604414283f'
readonly RESULT_TREE='c43adddfb54d26d6fc88b334613669d66fa0a656'
readonly SCHEMA_COMPATIBLE_THROUGH='037_console_publish_intent_indexes.sql'
readonly TARGET_PLATFORM='linux/amd64'
readonly NODE_BASE_REPOSITORY_DIGEST='docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819'
readonly PYTHON_BASE_REPOSITORY_DIGEST='docker.io/library/python@sha256:53739acebd52a300f19f52d93f2a6165f63300689bdf6f8af2bff0d63780e5e6'

if [[ $# -ne 1 ]]; then
  printf 'usage: %s /ABSOLUTE/PRIVATE/bridge-build.json\n' "$0" >&2
  exit 64
fi

: "${CAUCE_BRIDGE_RUNTIME_REPOSITORY:?set the registry repository without a tag or digest}"
: "${CAUCE_BRIDGE_NODE_BASE:?set an immutable Node base image RepoDigest}"
: "${CAUCE_BRIDGE_PYTHON_BASE:?set an immutable Python base image RepoDigest}"
: "${CAUCE_BRIDGE_PATCH_SOURCE_COMMIT:?set the full commit containing the bridge patch}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository=$(git -C "$script_dir/../.." rev-parse --show-toplevel)
patch="$script_dir/rollback-bridge-schema029.patch"
metadata="$script_dir/metadata.json"
output=$(realpath -m -- "$1")
output_parent=$(dirname -- "$output")

command -v cmp >/dev/null 2>&1 || { printf 'rollback bridge publish failed: cmp is unavailable\n' >&2; exit 127; }
command -v docker >/dev/null 2>&1 || { printf 'rollback bridge publish failed: docker is unavailable\n' >&2; exit 127; }
command -v git >/dev/null 2>&1 || { printf 'rollback bridge publish failed: git is unavailable\n' >&2; exit 127; }
command -v python3 >/dev/null 2>&1 || { printf 'rollback bridge publish failed: python3 is unavailable\n' >&2; exit 127; }
command -v tar >/dev/null 2>&1 || { printf 'rollback bridge publish failed: tar is unavailable\n' >&2; exit 127; }
DOCKER_BUILDKIT=0 docker build --help >/dev/null 2>&1 || {
  printf 'rollback bridge publish failed: portable docker build is unavailable\n' >&2
  exit 127
}

validate_repository() {
  REPOSITORY=$1 python3 - <<'PY'
import os
import re

component = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
pattern = re.compile(rf"^{component}(?::[0-9]+)?(?:/{component})+$")
raise SystemExit(0 if pattern.fullmatch(os.environ["REPOSITORY"]) else 1)
PY
}

validate_image_reference() {
  IMAGE_REFERENCE=$1 python3 - <<'PY'
import os
import re

component = r"[a-z0-9]+(?:[._-][a-z0-9]+)*"
pattern = re.compile(rf"^{component}(?::[0-9]+)?(?:/{component})+@sha256:[a-f0-9]{{64}}$")
raise SystemExit(0 if pattern.fullmatch(os.environ["IMAGE_REFERENCE"]) else 1)
PY
}

validate_repository "$CAUCE_BRIDGE_RUNTIME_REPOSITORY" || {
  printf 'rollback bridge publish failed: runtime repository is not canonical\n' >&2
  exit 2
}
validate_image_reference "$CAUCE_BRIDGE_NODE_BASE" || {
  printf 'rollback bridge publish failed: Node base must be an immutable canonical RepoDigest\n' >&2
  exit 2
}
validate_image_reference "$CAUCE_BRIDGE_PYTHON_BASE" || {
  printf 'rollback bridge publish failed: Python base must be an immutable canonical RepoDigest\n' >&2
  exit 2
}
[[ $CAUCE_BRIDGE_NODE_BASE == "$NODE_BASE_REPOSITORY_DIGEST" ]] || {
  printf 'rollback bridge publish failed: Node base differs from the tested pinned RepoDigest\n' >&2
  exit 2
}
[[ $CAUCE_BRIDGE_PYTHON_BASE == "$PYTHON_BASE_REPOSITORY_DIGEST" ]] || {
  printf 'rollback bridge publish failed: Python base differs from the tested pinned RepoDigest\n' >&2
  exit 2
}
[[ $CAUCE_BRIDGE_NODE_BASE != "$CAUCE_BRIDGE_PYTHON_BASE" ]] || {
  printf 'rollback bridge publish failed: Node and Python bases must be distinct\n' >&2
  exit 2
}
[[ $CAUCE_BRIDGE_PATCH_SOURCE_COMMIT =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || {
  printf 'rollback bridge publish failed: patch source commit must be a full Git object ID\n' >&2
  exit 2
}
[[ $output == /* && -d $output_parent && ! -L $output_parent && ! -e $output && ! -L $output ]] || {
  printf 'rollback bridge publish failed: output must be a new file in an existing absolute directory\n' >&2
  exit 2
}
OUTPUT_PARENT=$output_parent python3 - <<'PY'
import os
import pathlib
import stat

path = pathlib.Path(os.environ["OUTPUT_PARENT"])
metadata = path.stat()
if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
    raise SystemExit("rollback bridge publish failed: evidence directory must be owned mode-0700")
PY

git -C "$repository" cat-file -e "${CAUCE_BRIDGE_PATCH_SOURCE_COMMIT}^{commit}" 2>/dev/null || {
  printf 'rollback bridge publish failed: patch source commit is unavailable\n' >&2
  exit 2
}
actual_head=$(git -C "$repository" rev-parse --verify HEAD)
[[ $actual_head == "$CAUCE_BRIDGE_PATCH_SOURCE_COMMIT" ]] || {
  printf 'rollback bridge publish failed: patch source commit must equal HEAD\n' >&2
  exit 2
}
git -C "$repository" diff --quiet --no-ext-diff -- &&
  git -C "$repository" diff --cached --quiet --no-ext-diff -- || {
    printf 'rollback bridge publish failed: tracked worktree or index is dirty\n' >&2
    exit 2
  }
for relative in \
  ops/rollback-bridge/rollback-bridge-schema029.patch \
  ops/rollback-bridge/metadata.json \
  ops/rollback-bridge/build.sh \
  ops/rollback-bridge/publish.sh
do
  git -C "$repository" show "${CAUCE_BRIDGE_PATCH_SOURCE_COMMIT}:$relative" 2>/dev/null |
    cmp --silent - "$repository/$relative" || {
      printf 'rollback bridge publish failed: committed bridge source differs from executing files\n' >&2
      exit 2
    }
done
printf '%s  %s\n' "$PATCH_SHA256" "$patch" | sha256sum --check --status || {
  printf 'rollback bridge publish failed: bridge patch SHA-256 mismatch\n' >&2
  exit 2
}

BRIDGE_BASE_COMMIT=$BASE_COMMIT BRIDGE_PATCH_SHA256="sha256:$PATCH_SHA256" \
  BRIDGE_RESULT_TREE=$RESULT_TREE NODE_BASE=$CAUCE_BRIDGE_NODE_BASE \
  PYTHON_BASE=$CAUCE_BRIDGE_PYTHON_BASE BRIDGE_TARGET_PLATFORM=$TARGET_PLATFORM \
  BRIDGE_TARGET_SCHEMA=$SCHEMA_COMPATIBLE_THROUGH \
  METADATA=$metadata python3 - <<'PY'
import json
import os
import pathlib

document = json.loads(pathlib.Path(os.environ["METADATA"]).read_text(encoding="utf-8"))
if document.get("schemaVersion") != 7:
    raise SystemExit("rollback bridge publish failed: metadata schema version is invalid")
expected = {
    "originBaseCommit": os.environ["BRIDGE_BASE_COMMIT"],
    "patchSetSha256": os.environ["BRIDGE_PATCH_SHA256"],
    "resultingBridgeTree": os.environ["BRIDGE_RESULT_TREE"],
}
if any(document.get(key) != value for key, value in expected.items()):
    raise SystemExit("rollback bridge publish failed: metadata differs from pinned build inputs")
publication = document.get("imagePublication")
if not isinstance(publication, dict):
    raise SystemExit("rollback bridge publish failed: metadata lacks image publication policy")
if publication.get("pinnedNodeBaseRepositoryDigest") != os.environ["NODE_BASE"]:
    raise SystemExit("rollback bridge publish failed: metadata Node base differs from publisher")
if publication.get("pinnedPythonBaseRepositoryDigest") != os.environ["PYTHON_BASE"]:
    raise SystemExit("rollback bridge publish failed: metadata Python base differs from publisher")
if publication.get("targetPlatform") != os.environ["BRIDGE_TARGET_PLATFORM"]:
    raise SystemExit("rollback bridge publish failed: metadata target platform differs from publisher")
if publication.get("lifecycleEvidenceSchemaVersion") != 11:
    raise SystemExit("rollback bridge publish failed: metadata lifecycle evidence schema is not v11")
schema_contract = document.get("schemaContract")
if not isinstance(schema_contract, dict) or schema_contract.get("schemaLatest") != os.environ["BRIDGE_TARGET_SCHEMA"]:
    raise SystemExit("rollback bridge publish failed: metadata schema contract differs from publisher")
if publication.get("acceptedManifestMediaTypes") != [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
]:
    raise SystemExit("rollback bridge publish failed: metadata child-manifest policy differs from publisher")
PY

case ${CAUCE_BRIDGE_PULL:-1} in
  1) pull_enabled=1; pull_args=(--pull) ;;
  0) pull_enabled=0; pull_args=() ;;
  *) printf 'rollback bridge publish failed: CAUCE_BRIDGE_PULL must be 0 or 1\n' >&2; exit 2 ;;
esac

if [[ $pull_enabled == 1 ]]; then
  docker pull --platform "$TARGET_PLATFORM" "$CAUCE_BRIDGE_NODE_BASE" >/dev/null
  docker pull --platform "$TARGET_PLATFORM" "$CAUCE_BRIDGE_PYTHON_BASE" >/dev/null
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
  < <(inspect_base "$CAUCE_BRIDGE_NODE_BASE") || {
  printf 'rollback bridge publish failed: Node base is not a locally bound linux/amd64 child manifest\n' >&2
  exit 1
}
IFS=$'\t' read -r python_base_id python_base_manifest python_base_media python_base_os python_base_arch \
  < <(inspect_base "$CAUCE_BRIDGE_PYTHON_BASE") || {
  printf 'rollback bridge publish failed: Python base is not a locally bound linux/amd64 child manifest\n' >&2
  exit 1
}
[[ $node_base_manifest != "$python_base_manifest" && $node_base_id != "$python_base_id" ]] || {
  printf 'rollback bridge publish failed: base manifests and image IDs must be role-distinct\n' >&2
  exit 1
}

umask 077
scratch=$(mktemp -d "${TMPDIR:-/tmp}/cauce-rollback-bridge-publish.XXXXXX")
archive="$scratch/bridge-context.tar"
context="$scratch/context"
evidence_tmp=
cleanup() {
  if [[ -n $evidence_tmp && -e $evidence_tmp ]]; then
    unlink -- "$evidence_tmp"
  fi
  if [[ -d $scratch ]]; then
    rm -rf -- "$scratch"
  fi
}
trap cleanup EXIT

mkdir -m 0700 "$context"
bash "$script_dir/build.sh" "$archive" >/dev/null
tar -xf "$archive" -C "$context"

[[ -s $context/deploy/fleet-snapshot.mjs && -s $context/deploy/runtime-package-smoke.mjs ]] || {
  printf 'rollback bridge publish failed: verified context lacks fleet health inputs\n' >&2
  exit 1
}
grep -Fq 'deploy/fleet-snapshot.mjs' "$context/deploy/Dockerfile" || {
  printf 'rollback bridge publish failed: runtime Dockerfile does not package fleet snapshot\n' >&2
  exit 1
}
if grep -Eq '^[[:space:]]*COPY[[:space:]].*--chmod=' "$context/deploy/Dockerfile"; then
  printf 'rollback bridge publish failed: runtime Dockerfile still requires COPY --chmod\n' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*RUN[[:space:]].*apk[[:space:]]+add' "$context/deploy/Dockerfile"; then
  printf 'rollback bridge publish failed: runtime Dockerfile performs a mutable apk install\n' >&2
  exit 1
fi
DOCKERFILE="$context/deploy/Dockerfile" NODE_BASE="$CAUCE_BRIDGE_NODE_BASE" \
  PYTHON_BASE="$CAUCE_BRIDGE_PYTHON_BASE" python3 - <<'PY' || {
import os
import pathlib
import re

text = pathlib.Path(os.environ["DOCKERFILE"]).read_text(encoding="utf-8")
stages = []
for raw in text.splitlines():
    match = re.fullmatch(r"\s*FROM\s+(\S+)\s+AS\s+([A-Za-z0-9._-]+)\s*", raw, re.IGNORECASE)
    if match:
        stages.append((match.group(1), match.group(2)))
expected_prefix = [
    ("${CAUCE_NODE_BASE}", "build"),
    ("${CAUCE_NODE_BASE}", "production-dependencies"),
    ("${CAUCE_PYTHON_BASE}", "python-runtime"),
    ("${CAUCE_NODE_BASE}", "runtime"),
]
required = [
    f"ARG CAUCE_NODE_BASE={os.environ['NODE_BASE']}",
    f"ARG CAUCE_PYTHON_BASE={os.environ['PYTHON_BASE']}",
    "ARG CAUCE_TARGET_PLATFORM=linux/amd64",
    "COPY --from=python-runtime /usr/local /usr/local",
    "io.cauce.base.node.repository-digest=${CAUCE_NODE_BASE}",
    "io.cauce.base.python.repository-digest=${CAUCE_PYTHON_BASE}",
    "io.cauce.target-platform=${CAUCE_TARGET_PLATFORM}",
    "io.cauce.rollback-bridge.read-only=server-v2",
]
raise SystemExit(0 if stages[:4] == expected_prefix and all(value in text for value in required) else 1)
PY
  printf 'rollback bridge publish failed: runtime Dockerfile lineage is not bound to pinned bases/platform\n' >&2
  exit 1
}

source_digest=$(python3 "$context/ops/scripts/source-digest.py" --root "$context" --domain runtime)
[[ $source_digest =~ ^sha256:[a-f0-9]{64}$ ]] || {
  printf 'rollback bridge publish failed: bridge runtime source digest is invalid\n' >&2
  exit 1
}
dockerfile_sha="sha256:$(sha256sum "$context/deploy/Dockerfile" | cut -d' ' -f1)"
archive_sha="sha256:$(sha256sum "$archive" | cut -d' ' -f1)"
publisher_sha="sha256:$(sha256sum "$script_dir/publish.sh" | cut -d' ' -f1)"
build_tag="${CAUCE_BRIDGE_RUNTIME_REPOSITORY}:bridge-build-${RESULT_TREE}"

DOCKER_BUILDKIT=0 docker build "${pull_args[@]}" --platform "$TARGET_PLATFORM" \
  --build-arg "CAUCE_NODE_BASE=$CAUCE_BRIDGE_NODE_BASE" \
  --build-arg "CAUCE_PYTHON_BASE=$CAUCE_BRIDGE_PYTHON_BASE" \
  --build-arg "CAUCE_SCHEMA_COMPATIBLE_THROUGH=$SCHEMA_COMPATIBLE_THROUGH" \
  --build-arg "CAUCE_SOURCE_DIGEST=$source_digest" \
  --build-arg "CAUCE_BRIDGE_TREE=$RESULT_TREE" \
  --build-arg "CAUCE_BRIDGE_PATCH_SHA256=sha256:$PATCH_SHA256" \
  --build-arg "CAUCE_TARGET_PLATFORM=$TARGET_PLATFORM" \
  --label "io.cauce.rollback-bridge.patch-source-commit=$CAUCE_BRIDGE_PATCH_SOURCE_COMMIT" \
  --label "io.cauce.rollback-bridge.read-only=server-v2" \
  --label "io.cauce.source.runtime=$source_digest" \
  --target runtime -t "$build_tag" -f "$context/deploy/Dockerfile" "$context"

docker run --rm --network none --platform "$TARGET_PLATFORM" --entrypoint node \
  "$build_tag" deploy/runtime-package-smoke.mjs >/dev/null
docker run --rm --network none --platform "$TARGET_PLATFORM" --entrypoint node \
  "$build_tag" --check deploy/fleet-snapshot.mjs >/dev/null
docker run --rm --network none --platform "$TARGET_PLATFORM" --entrypoint python3 \
  "$build_tag" -c 'import asyncio, json; assert asyncio and json' >/dev/null

inspect_local_runtime() {
  local reference=$1 serialized
  serialized=$(docker image inspect --format '{{json .}}' "$reference") || return 1
  RUNTIME_INSPECT=$serialized EXPECTED_SOURCE=$source_digest EXPECTED_TREE=$RESULT_TREE \
    EXPECTED_PATCH="sha256:$PATCH_SHA256" EXPECTED_NODE=$CAUCE_BRIDGE_NODE_BASE \
    EXPECTED_PYTHON=$CAUCE_BRIDGE_PYTHON_BASE EXPECTED_SCHEMA=$SCHEMA_COMPATIBLE_THROUGH \
    EXPECTED_PATCH_SOURCE=$CAUCE_BRIDGE_PATCH_SOURCE_COMMIT \
    python3 - <<'PY'
import json
import os
import re

try:
    image = json.loads(os.environ["RUNTIME_INSPECT"])
    labels = image["Config"]["Labels"]
    identifier = image["Id"]
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", identifier)
    assert image["Os"] == "linux" and image["Architecture"] == "amd64"
    assert isinstance(labels, dict)
    assert labels.get("io.cauce.schema.compatible-through") == os.environ["EXPECTED_SCHEMA"]
    assert labels.get("io.cauce.source.digest") == os.environ["EXPECTED_SOURCE"]
    assert labels.get("io.cauce.source.runtime") == os.environ["EXPECTED_SOURCE"]
    assert labels.get("io.cauce.rollback-bridge.tree") == os.environ["EXPECTED_TREE"]
    assert labels.get("io.cauce.rollback-bridge.patch-sha256") == os.environ["EXPECTED_PATCH"]
    assert labels.get("io.cauce.rollback-bridge.patch-source-commit") == os.environ["EXPECTED_PATCH_SOURCE"]
    assert labels.get("io.cauce.rollback-bridge.read-only") == "server-v2"
    assert labels.get("io.cauce.base.node.repository-digest") == os.environ["EXPECTED_NODE"]
    assert labels.get("io.cauce.base.python.repository-digest") == os.environ["EXPECTED_PYTHON"]
    assert labels.get("io.cauce.target-platform") == "linux/amd64"
    assert labels.get("org.opencontainers.image.base.name") == os.environ["EXPECTED_NODE"]
except (AssertionError, KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
print(identifier)
PY
}

runtime_id=$(inspect_local_runtime "$build_tag") || {
  printf 'rollback bridge publish failed: built image identity, labels or platform mismatch\n' >&2
  exit 1
}

runtime_hex=${runtime_id#sha256:}
published_tag="${CAUCE_BRIDGE_RUNTIME_REPOSITORY}:schema037-${RESULT_TREE}-${runtime_hex}"
docker tag "$build_tag" "$published_tag"
docker push "$published_tag" >/dev/null

repository_digest() {
  local tag=$1 repository_name=$2 serialized
  serialized=$(docker image inspect --format '{{json .RepoDigests}}' "$tag") || return 1
  REPOSITORY=$repository_name REPO_DIGESTS=$serialized python3 - <<'PY'
import json
import os
import re

repository = os.environ["REPOSITORY"]
def normalized_repository(value):
    first = value.split("/", 1)[0]
    if "." not in first and ":" not in first and first != "localhost":
        value = f"docker.io/{value}" if "/" in value else f"docker.io/library/{value}"
    if value.startswith("index.docker.io/"):
        value = "docker.io/" + value.removeprefix("index.docker.io/")
    return value
try:
    values = json.loads(os.environ["REPO_DIGESTS"])
except json.JSONDecodeError:
    raise SystemExit(1)
matches = sorted({
    value.rsplit("@", 1)[1] for value in values
    if isinstance(value, str)
    and "@" in value
    and re.fullmatch(r"sha256:[a-f0-9]{64}", value.rsplit("@", 1)[1])
    and normalized_repository(value.rsplit("@", 1)[0]) == normalized_repository(repository)
})
if len(matches) != 1:
    raise SystemExit(1)
print(repository + "@" + matches[0])
PY
}

runtime_repository_digest=$(repository_digest "$published_tag" "$CAUCE_BRIDGE_RUNTIME_REPOSITORY") || {
  printf 'rollback bridge publish failed: push did not yield one exact runtime RepoDigest\n' >&2
  exit 1
}
if [[ $pull_enabled == 1 ]]; then
  docker pull --platform "$TARGET_PLATFORM" "$runtime_repository_digest" >/dev/null
fi

inspect_published_runtime() {
  local reference=$1 expected_id=$2 serialized
  serialized=$(docker image inspect --format '{{json .}}' "$reference") || return 1
  RUNTIME_REFERENCE=$reference RUNTIME_INSPECT=$serialized EXPECTED_ID=$expected_id \
    EXPECTED_SOURCE=$source_digest EXPECTED_TREE=$RESULT_TREE EXPECTED_PATCH="sha256:$PATCH_SHA256" \
    EXPECTED_NODE=$CAUCE_BRIDGE_NODE_BASE EXPECTED_PYTHON=$CAUCE_BRIDGE_PYTHON_BASE \
    EXPECTED_SCHEMA=$SCHEMA_COMPATIBLE_THROUGH \
    EXPECTED_PATCH_SOURCE=$CAUCE_BRIDGE_PATCH_SOURCE_COMMIT python3 - <<'PY'
import json
import os
import re

manifest_types = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
def normalized_repository(value):
    first = value.split("/", 1)[0]
    if "." not in first and ":" not in first and first != "localhost":
        value = f"docker.io/{value}" if "/" in value else f"docker.io/library/{value}"
    if value.startswith("index.docker.io/"):
        value = "docker.io/" + value.removeprefix("index.docker.io/")
    return value
try:
    image = json.loads(os.environ["RUNTIME_INSPECT"])
    reference = os.environ["RUNTIME_REFERENCE"]
    manifest_digest = reference.rsplit("@", 1)[1]
    descriptor = image["Descriptor"]
    labels = image["Config"]["Labels"]
    identifier = image["Id"]
    media_type = descriptor["mediaType"]
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", identifier)
    assert identifier == os.environ["EXPECTED_ID"]
    assert descriptor["digest"] == manifest_digest
    assert media_type in manifest_types
    assert image["Os"] == "linux" and image["Architecture"] == "amd64"
    reference_repository, reference_digest = reference.rsplit("@", 1)
    assert isinstance(image["RepoDigests"], list) and any(
        isinstance(value, str)
        and "@" in value
        and normalized_repository(value.rsplit("@", 1)[0]) == normalized_repository(reference_repository)
        and value.rsplit("@", 1)[1] == reference_digest
        for value in image["RepoDigests"]
    )
    assert isinstance(labels, dict)
    assert labels.get("io.cauce.schema.compatible-through") == os.environ["EXPECTED_SCHEMA"]
    assert labels.get("io.cauce.source.digest") == os.environ["EXPECTED_SOURCE"]
    assert labels.get("io.cauce.source.runtime") == os.environ["EXPECTED_SOURCE"]
    assert labels.get("io.cauce.rollback-bridge.tree") == os.environ["EXPECTED_TREE"]
    assert labels.get("io.cauce.rollback-bridge.patch-sha256") == os.environ["EXPECTED_PATCH"]
    assert labels.get("io.cauce.rollback-bridge.patch-source-commit") == os.environ["EXPECTED_PATCH_SOURCE"]
    assert labels.get("io.cauce.rollback-bridge.read-only") == "server-v2"
    assert labels.get("io.cauce.base.node.repository-digest") == os.environ["EXPECTED_NODE"]
    assert labels.get("io.cauce.base.python.repository-digest") == os.environ["EXPECTED_PYTHON"]
    assert labels.get("io.cauce.target-platform") == "linux/amd64"
    assert labels.get("org.opencontainers.image.base.name") == os.environ["EXPECTED_NODE"]
except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
print("\t".join((identifier, manifest_digest, media_type, image["Os"], image["Architecture"])))
PY
}

IFS=$'\t' read -r recovered_runtime_id runtime_manifest runtime_media runtime_os runtime_arch \
  < <(inspect_published_runtime "$runtime_repository_digest" "$runtime_id") || {
  printf 'rollback bridge publish failed: published image identity, manifest, labels or platform mismatch\n' >&2
  exit 1
}
[[ $recovered_runtime_id == "$runtime_id" ]] || {
  printf 'rollback bridge publish failed: RepoDigest did not resolve to the tested image ID\n' >&2
  exit 1
}

generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
evidence_tmp=$(mktemp "$output_parent/.rollback-bridge-build.XXXXXX")
BRIDGE_BASE_COMMIT=$BASE_COMMIT PATCH_SOURCE_COMMIT=$CAUCE_BRIDGE_PATCH_SOURCE_COMMIT \
  BRIDGE_PATCH_SHA256="sha256:$PATCH_SHA256" BRIDGE_RESULT_TREE=$RESULT_TREE \
  SOURCE_DIGEST=$source_digest \
  DOCKERFILE_SHA=$dockerfile_sha ARCHIVE_SHA=$archive_sha PUBLISHER_SHA=$publisher_sha \
  NODE_BASE=$CAUCE_BRIDGE_NODE_BASE NODE_BASE_ID=$node_base_id \
  NODE_BASE_MANIFEST=$node_base_manifest NODE_BASE_MEDIA=$node_base_media \
  NODE_BASE_OS=$node_base_os NODE_BASE_ARCH=$node_base_arch \
  PYTHON_BASE=$CAUCE_BRIDGE_PYTHON_BASE PYTHON_BASE_ID=$python_base_id \
  PYTHON_BASE_MANIFEST=$python_base_manifest PYTHON_BASE_MEDIA=$python_base_media \
  PYTHON_BASE_OS=$python_base_os PYTHON_BASE_ARCH=$python_base_arch \
  BRIDGE_TARGET_PLATFORM=$TARGET_PLATFORM PULL_ENABLED=$pull_enabled \
  RUNTIME_MANIFEST=$runtime_manifest RUNTIME_MEDIA=$runtime_media \
  RUNTIME_OS=$runtime_os RUNTIME_ARCH=$runtime_arch \
  GENERATED_AT=$generated_at RUNTIME_TAG=$published_tag \
  RUNTIME_ID=$runtime_id RUNTIME_REPOSITORY_DIGEST=$runtime_repository_digest \
  BRIDGE_SCHEMA_COMPATIBLE_THROUGH=$SCHEMA_COMPATIBLE_THROUGH \
  EVIDENCE_TMP=$evidence_tmp python3 - <<'PY'
import json
import os
import pathlib

pull_performed = os.environ["PULL_ENABLED"] == "1"
payload = {
    "schemaVersion": 2,
    "artifact": "cauce-v3-schema037-rollback-bridge-build",
    "evidenceClass": "rollback-bridge-build",
    "mechanism": (
        "verified-git-tree-docker-build-push-pull"
        if pull_performed else "verified-git-tree-docker-build-push-local-digest-inspect"
    ),
    "generatedAt": os.environ["GENERATED_AT"],
    "sourceRevision": {
        "originBaseCommit": os.environ["BRIDGE_BASE_COMMIT"],
        "patchSourceCommit": os.environ["PATCH_SOURCE_COMMIT"],
        "patchSetSha256": os.environ["BRIDGE_PATCH_SHA256"],
        "resultingBridgeTree": os.environ["BRIDGE_RESULT_TREE"],
        "buildContext": "deterministic-git-archive-from-verified-tree",
        "contextArchiveSha256": os.environ["ARCHIVE_SHA"],
    },
    "baseImages": {
        "node": {
            "role": "node",
            "repositoryDigest": os.environ["NODE_BASE"],
            "manifestDigest": os.environ["NODE_BASE_MANIFEST"],
            "mediaType": os.environ["NODE_BASE_MEDIA"],
            "platform": {"os": os.environ["NODE_BASE_OS"], "architecture": os.environ["NODE_BASE_ARCH"]},
            "imageId": os.environ["NODE_BASE_ID"],
        },
        "python": {
            "role": "python",
            "repositoryDigest": os.environ["PYTHON_BASE"],
            "manifestDigest": os.environ["PYTHON_BASE_MANIFEST"],
            "mediaType": os.environ["PYTHON_BASE_MEDIA"],
            "platform": {"os": os.environ["PYTHON_BASE_OS"], "architecture": os.environ["PYTHON_BASE_ARCH"]},
            "imageId": os.environ["PYTHON_BASE_ID"],
        },
    },
    "runtime": {
        "tag": os.environ["RUNTIME_TAG"],
        "repositoryDigest": os.environ["RUNTIME_REPOSITORY_DIGEST"],
        "imageId": os.environ["RUNTIME_ID"],
        "manifestDigest": os.environ["RUNTIME_MANIFEST"],
        "mediaType": os.environ["RUNTIME_MEDIA"],
        "platform": {"os": os.environ["RUNTIME_OS"], "architecture": os.environ["RUNTIME_ARCH"]},
        "sourceDigest": os.environ["SOURCE_DIGEST"],
        "sourceDigestDomain": "runtime",
        "dockerfileSha256": os.environ["DOCKERFILE_SHA"],
        "baseImageRepositoryDigest": os.environ["NODE_BASE"],
        "pythonBaseImageRepositoryDigest": os.environ["PYTHON_BASE"],
        "schemaCompatibleThrough": os.environ["BRIDGE_SCHEMA_COMPATIBLE_THROUGH"],
        "labels": {
            "io.cauce.schema.compatible-through": os.environ["BRIDGE_SCHEMA_COMPATIBLE_THROUGH"],
            "io.cauce.source.digest": os.environ["SOURCE_DIGEST"],
            "io.cauce.source.runtime": os.environ["SOURCE_DIGEST"],
            "io.cauce.rollback-bridge.tree": os.environ["BRIDGE_RESULT_TREE"],
            "io.cauce.rollback-bridge.patch-sha256": os.environ["BRIDGE_PATCH_SHA256"],
            "io.cauce.rollback-bridge.patch-source-commit": os.environ["PATCH_SOURCE_COMMIT"],
            "io.cauce.rollback-bridge.read-only": "server-v2",
            "io.cauce.base.node.repository-digest": os.environ["NODE_BASE"],
            "io.cauce.base.python.repository-digest": os.environ["PYTHON_BASE"],
            "io.cauce.target-platform": os.environ["BRIDGE_TARGET_PLATFORM"],
            "org.opencontainers.image.base.name": os.environ["NODE_BASE"],
        },
    },
    "verification": {
        "portableDockerBuild": "passed",
        "buildxRequired": False,
        "targetPlatform": os.environ["BRIDGE_TARGET_PLATFORM"],
        "pullPolicy": "pull-exact-child-manifests" if pull_performed else "no-pull-local-bases-required",
        "registryPullPerformed": pull_performed,
        "baseChildManifests": "passed",
        "runtimeChildManifest": "passed",
        "runtimePackageSmoke": "passed",
        "pythonRuntimeSmoke": "passed",
        "fleetSnapshotSyntax": "passed",
        "provenanceLabels": (
            "passed-before-and-after-registry-recovery"
            if pull_performed else "passed-before-push-and-after-local-repository-digest-resolution"
        ),
        "repositoryDigestResolvedToTestedImageId": True,
        "repositoryDigestRecoveredImageId": pull_performed,
        "publisherSha256": os.environ["PUBLISHER_SHA"],
    },
}
path = pathlib.Path(os.environ["EVIDENCE_TMP"])
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
path.chmod(0o600)
PY

EVIDENCE_TMP=$evidence_tmp OUTPUT=$output python3 - <<'PY'
import os

os.link(os.environ["EVIDENCE_TMP"], os.environ["OUTPUT"], follow_symlinks=False)
os.unlink(os.environ["EVIDENCE_TMP"])
PY
evidence_tmp=
printf 'rollback bridge image: %s\n' "$runtime_repository_digest"
printf 'rollback bridge build evidence: %s\n' "$output"
