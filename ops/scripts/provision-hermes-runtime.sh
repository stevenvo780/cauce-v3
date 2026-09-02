#!/usr/bin/env bash
# Provisions or verifies the pinned Hermes runtime for an alias, without copying credentials.
#
# The executable source and venv live under /opt, root-owned and without write bits. The three
# ws-humanizar aliases share UID: hosting importable code under their `.local` would let any of
# them persist an untracked module or replace the venv between preflight and turn. The alias
# profile is the only thing in the persistent `.local`, user-owned; authenticating it is a
# separate gate, never resolved by copying `.env`, tokens or sessions from another runtime.

set -euo pipefail

mode=provision
alias_name=''
while (($#)); do
  case "$1" in
    --check) mode=check; shift ;;
    --) shift; break ;;
    -*) printf 'provision-hermes-runtime: argumento desconocido: %s\n' "$1" >&2; exit 2 ;;
    *) [[ -z $alias_name ]] || { printf 'provision-hermes-runtime: sólo admite un alias\n' >&2; exit 2; }; alias_name=$1; shift ;;
  esac
done
[[ -n $alias_name && $# == 0 ]] || { printf 'uso: provision-hermes-runtime.sh [--check] <alias>\n' >&2; exit 2; }
[[ $alias_name =~ ^[a-z][a-z0-9-]*$ ]] || { printf 'provision-hermes-runtime: alias inválido\n' >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ops_root=${CAUCE_CONTAINER_OPS_ROOT:-$(cd -- "$script_dir/.." && pwd -P)}

read_metadata() {
  python3 - "$ops_root" "$alias_name" "$script_dir" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]).resolve()
alias = sys.argv[2]
sys.path.insert(0, sys.argv[3])  # installed reader: an overridden ops root supplies data only
from container_alias_lib import load_container_aliases  # noqa: E402  sys.path set above

runtime = json.loads((root / "hermes-runtime.json").read_text(encoding="utf-8"))
entry = load_container_aliases(root).get(alias)
if entry is None:
    sys.exit("alias no declarado")
if entry["harness"] != "hermes":
    sys.exit("el alias no usa Hermes")
if entry["dockerHost"] != "local":
    sys.exit("el provisionador Hermes sólo opera sobre el Docker local")
commit = runtime.get("commit")
repository = runtime.get("repository")
version = runtime.get("packageVersion")
runtime_root = runtime.get("runtimeRoot")
runtime_id = runtime.get("runtimeId")
uv_version = runtime.get("uvVersion")
uv_target = runtime.get("uvTarget")
uv_sha256 = runtime.get("uvSha256")
uv_lock_sha256 = runtime.get("uvLockSha256")
uv_archive_url = runtime.get("uvArchiveUrl")
uv_archive_sha256 = runtime.get("uvArchiveSha256")
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    sys.exit("commit Hermes inválido")
if not isinstance(repository, str) or not repository.startswith("https://github.com/NousResearch/hermes-agent"):
    sys.exit("repositorio Hermes no autorizado")
if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    sys.exit("versión Hermes inválida")
if runtime_root != "/opt/cauce-v3-hermes-runtime":
    sys.exit("raíz Hermes no autorizada")
if not isinstance(runtime_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", runtime_id):
    sys.exit("identificador Hermes inválido")
if not isinstance(uv_version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", uv_version):
    sys.exit("versión uv inválida")
if not isinstance(uv_target, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", uv_target):
    sys.exit("target uv inválido")
if not isinstance(uv_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", uv_sha256):
    sys.exit("digest uv inválido")
if not isinstance(uv_lock_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", uv_lock_sha256):
    sys.exit("digest uv.lock inválido")
expected_archive_url = (
    f"https://github.com/astral-sh/uv/releases/download/{uv_version}/uv-{uv_target}.tar.gz"
)
if uv_archive_url != expected_archive_url:
    sys.exit("URL de archive uv inválida")
if not isinstance(uv_archive_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", uv_archive_sha256):
    sys.exit("digest archive uv inválido")
fields = (
    entry["container"], entry["user"], entry["home"], repository, commit, version,
    runtime_root, runtime_id, uv_version, uv_target, uv_sha256, uv_lock_sha256,
    uv_archive_url, uv_archive_sha256,
)
if not all(isinstance(value, str) and "\t" not in value and "\n" not in value for value in fields):
    sys.exit("metadata Hermes incompleta")
sys.stdout.write("\t".join(fields))
PY
}

metadata_line=$(read_metadata) || exit 2
IFS=$'\t' read -r container_name container_user container_home repository source_commit package_version \
  runtime_root runtime_id uv_version uv_target uv_sha256 uv_lock_sha256 \
  uv_archive_url uv_archive_sha256 \
  <<<"$metadata_line"
[[ -n $container_name && -n $container_user && -n $container_home && -n $repository \
  && -n $source_commit && -n $package_version && -n $runtime_root && -n $runtime_id \
  && -n $uv_version && -n $uv_target && -n $uv_sha256 && -n $uv_lock_sha256 \
  && -n $uv_archive_url && -n $uv_archive_sha256 ]] \
  || { printf 'provision-hermes-runtime: metadata incompleta\n' >&2; exit 2; }

command -v docker >/dev/null 2>&1 || { printf 'provision-hermes-runtime: Docker no está disponible\n' >&2; exit 127; }
mapfile -t container_ids < <(docker ps --no-trunc --filter "name=^/${container_name}$" --format '{{.ID}}')
[[ ${#container_ids[@]} == 1 && -n ${container_ids[0]} ]] \
  || { printf 'provision-hermes-runtime: el contenedor exacto no está activo\n' >&2; exit 1; }
container_id=${container_ids[0]}

if [[ $mode == provision ]]; then
  lock_root=${CAUCE_CONTAINER_LOCK_ROOT:-/run/lock}
  lock_helper="$ops_root/scripts/alias-lock-exec.py"
  [[ -f $lock_helper && ! -L $lock_helper ]] \
    || { printf 'provision-hermes-runtime: helper de lock no disponible\n' >&2; exit 73; }
  # Exactly the same descriptor-owned lock as container-adapter-supervisor.sh. Provision cannot
  # modify a runtime while its adapter owns the alias; --check stays read-only and needs no lock.
  if [[ -z ${CAUCE_ALIAS_LOCK_FD:-} ]]; then
    exec env CAUCE_CONTAINER_OPS_ROOT="$ops_root" CAUCE_CONTAINER_LOCK_ROOT="$lock_root" \
      python3 "$lock_helper" run --lock-root "$lock_root" --alias "$alias_name" -- \
      "$0" "$alias_name"
  fi
  python3 "$lock_helper" verify --lock-root "$lock_root" --alias "$alias_name" \
    || { printf 'provision-hermes-runtime: otro proceso posee el lock del alias\n' >&2; exit 73; }
fi

# The profile is the only mutable tree. It is created and validated under the alias's own UID so
# that no path controlled by that UID is traversed with root privileges.
docker exec -i --user "$container_user" "$container_id" /usr/bin/python3 -c '
import os, pathlib, stat, sys
mode, home, alias = sys.argv[1:]
profile = pathlib.Path(home) / ".local/share/cauce-v3/hermes" / alias
if mode == "provision":
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(profile, 0o700)
details = os.lstat(profile)
if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
    raise SystemExit(1)
if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o700:
    raise SystemExit(1)
' "$mode" "$container_home" "$alias_name" >/dev/null \
  || { printf 'provision-hermes-runtime: perfil Hermes inseguro o ausente\n' >&2; exit 78; }

# Source and venv are built as root on a /opt anchor that the shared UID cannot rename. uv is
# copied first and its bytes are compared against the versioned digest before being executed.
docker exec -i --user 0 "$container_id" sh -s -- \
  "$mode" "$container_home" "$alias_name" "$repository" "$source_commit" "$package_version" \
  "$runtime_root" "$runtime_id" "$uv_version" "$uv_target" "$uv_sha256" "$uv_lock_sha256" \
  "$uv_archive_url" "$uv_archive_sha256" <<'INNER'
set -eu
mode=$1; home=$2; alias_name=$3; repository=$4; source_commit=$5; package_version=$6
runtime_root=$7; runtime_id=$8; uv_version=$9; uv_target=${10}; uv_sha256=${11}; uv_lock_sha256=${12}
uv_archive_url=${13}; uv_archive_sha256=${14}
runtime_parent="$runtime_root/$alias_name"
runtime_dir="$runtime_parent/$runtime_id"
source_dir="$runtime_dir/source"
venv_dir="$runtime_dir/venv"
metadata="$runtime_dir/.cauce-runtime"
uv_candidate="$home/.local/bin/uv"

verify() {
  test -d "$runtime_dir" && test ! -L "$runtime_dir"
  test -f "$metadata" && test ! -L "$metadata"
  expected_metadata=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$source_commit" "$package_version" "$uv_version" "$uv_target" "$uv_sha256" "$uv_lock_sha256" \
    "$uv_archive_url" "$uv_archive_sha256")
  test "$(cat "$metadata")" = "$expected_metadata"
  test "$(git -C "$source_dir" rev-parse HEAD)" = "$source_commit"
  test -z "$(git -C "$source_dir" status --porcelain=v1 --untracked-files=all --ignored=matching)"
  test "$(sha256sum "$source_dir/uv.lock" | cut -d ' ' -f 1)" = "$uv_lock_sha256"
  test "$(sha256sum "$runtime_dir/uv" | cut -d ' ' -f 1)" = "$uv_sha256"
  # No entry may be writable or owned by the shared runtime UID. Symlinks are accepted only when
  # they resolve inside the immutable runtime or to the container's system Python.
  python3 - "$runtime_dir" <<'PY'
import os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
system_python = pathlib.Path("/usr/bin/python3").resolve(strict=True)
if root.resolve() != root or os.lstat(root).st_uid != 0:
    raise SystemExit(1)
for current, directories, files in os.walk(root, followlinks=False):
    for name in [*directories, *files]:
        path = pathlib.Path(current) / name
        details = os.lstat(path)
        if details.st_uid != 0:
            raise SystemExit(1)
        if stat.S_ISLNK(details.st_mode):
            resolved = path.resolve(strict=True)
            if resolved != system_python and root not in resolved.parents:
                raise SystemExit(1)
        elif stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode):
            if details.st_mode & 0o222:
                raise SystemExit(1)
        else:
            raise SystemExit(1)
PY
  (cd "$source_dir" && PYTHONDONTWRITEBYTECODE=1 "$venv_dir/bin/python" - "$package_version") <<'PY'
import importlib.metadata
import sys
import hermes_cli.oneshot  # noqa: F401

assert importlib.metadata.version("hermes-agent") == sys.argv[1]
PY
}

if [ "$mode" = check ]; then
  verify >/dev/null
  exit 0
fi

umask 077
# Create/open the /opt anchor component-wise without following symlinks. Existing directories are
# never chowned into compliance: a wrong owner/type/mode is a hard failure.
python3 - "$runtime_root" "$alias_name" <<'PY'
import os, pathlib, stat, sys
runtime_root = pathlib.PurePosixPath(sys.argv[1])
alias = sys.argv[2]
if runtime_root != pathlib.PurePosixPath("/opt/cauce-v3-hermes-runtime"):
    raise SystemExit(1)
opt_fd = os.open("/opt", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    try:
        os.mkdir(runtime_root.name, 0o755, dir_fd=opt_fd)
    except FileExistsError:
        pass
    root_fd = os.open(
        runtime_root.name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=opt_fd,
    )
    try:
        details = os.fstat(root_fd)
        if details.st_uid != 0 or stat.S_IMODE(details.st_mode) != 0o755:
            raise SystemExit(1)
        try:
            os.mkdir(alias, 0o755, dir_fd=root_fd)
        except FileExistsError:
            pass
        alias_fd = os.open(
            alias,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=root_fd,
        )
        try:
            alias_details = os.fstat(alias_fd)
            if alias_details.st_uid != 0 or stat.S_IMODE(alias_details.st_mode) != 0o755:
                raise SystemExit(1)
        finally:
            os.close(alias_fd)
    finally:
        os.close(root_fd)
finally:
    os.close(opt_fd)
PY

runtime_stage=''
created_runtime=0
cleanup() {
  if [ "$created_runtime" = 1 ] && [ -n "$runtime_stage" ] \
    && [ "$runtime_stage" = "$runtime_dir" ] && [ -d "$runtime_stage" ] \
    && [ ! -L "$runtime_stage" ]; then
    rm -rf -- "$runtime_stage"
  fi
}
trap cleanup EXIT HUP INT TERM

# Prepare the exact final path and a durable build marker in one short operation. A SIGKILL cannot
# run the shell trap; the next invocation (serialized by the alias lock) therefore distinguishes a
# helper-owned partial release from a published release and rebuilds only the former. A symlink,
# wrong owner, group/world-writable entry or marker mismatch is never deleted into compliance.
runtime_state=$(python3 - "$runtime_parent" "$runtime_id" 0 \
  "$source_commit" "$package_version" "$uv_version" "$uv_target" "$uv_sha256" \
  "$uv_lock_sha256" "$uv_archive_url" "$uv_archive_sha256" <<'PY'
# BEGIN HERMES_PARTIAL_RECOVERY_PY
import os
import pathlib
import re
import shutil
import stat
import sys

(
    runtime_parent_raw, runtime_id, owner_uid_raw, source_commit, package_version,
    uv_version, uv_target, uv_sha256, uv_lock_sha256, uv_archive_url, uv_archive_sha256,
) = sys.argv[1:]
owner_uid = int(owner_uid_raw)
runtime_parent = pathlib.Path(runtime_parent_raw)
if (
    not runtime_parent.is_absolute()
    or runtime_parent.resolve(strict=True) != runtime_parent
    or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", runtime_id) is None
):
    raise SystemExit("unsafe Hermes runtime parent or ID")
parent_details = os.lstat(runtime_parent)
if (
    not stat.S_ISDIR(parent_details.st_mode)
    or stat.S_ISLNK(parent_details.st_mode)
    or parent_details.st_uid != owner_uid
    or parent_details.st_mode & 0o022
):
    raise SystemExit("unsafe Hermes runtime parent ownership or mode")

runtime = runtime_parent / runtime_id
stage = runtime_parent / f".{runtime_id}.build-pending"
pending_name = ".cauce-build-pending"
ready_name = ".cauce-runtime"
pending_body = "\n".join((
    "cauce-hermes-build-v1", source_commit, package_version, uv_version, uv_target,
    uv_sha256, uv_lock_sha256, uv_archive_url, uv_archive_sha256,
)) + "\n"

def direct_details(path: pathlib.Path, label: str) -> os.stat_result:
    details = os.lstat(path)
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != owner_uid
        or details.st_mode & 0o022
    ):
        raise SystemExit(f"unsafe {label} ownership, mode or type")
    return details

def marker_matches(root: pathlib.Path) -> bool:
    marker = root / pending_name
    details = os.lstat(marker)
    if (
        not stat.S_ISREG(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_nlink != 1
        or details.st_uid != owner_uid
        or details.st_mode & 0o022
    ):
        raise SystemExit("ambiguous Hermes partial marker")
    return marker.read_text(encoding="utf-8") == pending_body

def validate_partial(root: pathlib.Path) -> None:
    direct_details(root, "Hermes partial release")
    if not marker_matches(root):
        raise SystemExit("Hermes partial marker does not match the requested release")
    system_python = pathlib.Path("/usr/bin/python3").resolve(strict=True)
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = pathlib.Path(current)
        current_details = os.lstat(current_path)
        if current_details.st_uid != owner_uid or current_details.st_mode & 0o022:
            raise SystemExit("ambiguous ownership or mode inside Hermes partial release")
        for name in [*directories, *files]:
            path = current_path / name
            details = os.lstat(path)
            if details.st_uid != owner_uid or details.st_mode & 0o022:
                raise SystemExit("ambiguous ownership or mode inside Hermes partial release")
            if stat.S_ISLNK(details.st_mode):
                try:
                    resolved = path.resolve(strict=True)
                except OSError as error:
                    raise SystemExit("ambiguous symlink inside Hermes partial release") from error
                if resolved != system_python and root not in resolved.parents:
                    raise SystemExit("Hermes partial release contains an escaping symlink")
            elif not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)):
                raise SystemExit("Hermes partial release contains a special entry")

def remove_validated_partial(root: pathlib.Path) -> None:
    validate_partial(root)
    for current, directories, _files in os.walk(root, topdown=False, followlinks=False):
        for name in directories:
            directory = pathlib.Path(current) / name
            if not directory.is_symlink():
                os.chmod(directory, 0o700)
        os.chmod(current, 0o700)
    shutil.rmtree(root)

if os.path.lexists(runtime):
    direct_details(runtime, "Hermes runtime release")
    ready = runtime / ready_name
    pending = runtime / pending_name
    if os.path.lexists(ready):
        ready_details = os.lstat(ready)
        if (
            not stat.S_ISREG(ready_details.st_mode)
            or stat.S_ISLNK(ready_details.st_mode)
            or ready_details.st_nlink != 1
            or ready_details.st_uid != owner_uid
            or ready_details.st_mode & 0o022
        ):
            raise SystemExit("ambiguous published Hermes release")
        if not os.path.lexists(pending):
            print("ready")
            raise SystemExit(0)
        # Crash after publishing the ready marker but before removing the durable build marker.
        # The release was never fully committed; authenticate the partial tree, then rebuild.
        remove_validated_partial(runtime)
    elif os.path.lexists(pending):
        remove_validated_partial(runtime)
    else:
        raise SystemExit("unmarked Hermes partial release requires operator inspection")

if os.path.lexists(stage):
    direct_details(stage, "Hermes preparation directory")
    entries = list(stage.iterdir())
    if not entries:
        stage.rmdir()
    elif len(entries) == 1 and entries[0].name == pending_name:
        remove_validated_partial(stage)
    else:
        raise SystemExit("ambiguous Hermes preparation directory")

os.mkdir(stage, 0o700)
stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    marker_fd = os.open(
        pending_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o400,
        dir_fd=stage_fd,
    )
    try:
        body = pending_body.encode("utf-8")
        offset = 0
        while offset < len(body):
            written = os.write(marker_fd, body[offset:])
            if written <= 0:
                raise SystemExit("incomplete Hermes build marker write")
            offset += written
        os.fsync(marker_fd)
    finally:
        os.close(marker_fd)
    os.fsync(stage_fd)
finally:
    os.close(stage_fd)
os.rename(stage, runtime)
parent_fd = os.open(runtime_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
print("build")
# END HERMES_PARTIAL_RECOVERY_PY
PY
)

if [ "$runtime_state" = build ]; then
  # Editable installs record absolute paths. Build directly at the final immutable path; a move
  # afterwards would leave __editable__.pth/direct_url pointing at a deleted staging directory.
  runtime_stage=$runtime_dir
  created_runtime=1
  mkdir "$runtime_stage/source"
  git -C "$runtime_stage/source" init --quiet
  git -C "$runtime_stage/source" remote add origin "$repository"
  env -i PATH=/usr/bin:/bin HOME=/nonexistent GIT_TERMINAL_PROMPT=0 \
    git -C "$runtime_stage/source" fetch --quiet --depth 1 origin "$source_commit"
  test "$(git -C "$runtime_stage/source" rev-parse FETCH_HEAD)" = "$source_commit"
  git -C "$runtime_stage/source" checkout --quiet --detach FETCH_HEAD
  test -z "$(git -C "$runtime_stage/source" status --porcelain=v1 --untracked-files=all --ignored=matching)"
  test "$(sha256sum "$runtime_stage/source/uv.lock" | cut -d ' ' -f 1)" = "$uv_lock_sha256"
  uv_resolved=$(readlink -f "$uv_candidate" 2>/dev/null || true)
  if [ -n "$uv_resolved" ] && [ -f "$uv_resolved" ] && [ ! -L "$uv_resolved" ] \
    && [ "$(sha256sum "$uv_resolved" | cut -d ' ' -f 1)" = "$uv_sha256" ]; then
    cp --dereference --no-preserve=ownership -- "$uv_resolved" "$runtime_stage/uv"
  else
    archive="$runtime_stage/uv.tar.gz"
    env -i PATH=/usr/bin:/bin /usr/bin/python3 - "$uv_archive_url" "$archive" <<'PY'
import pathlib, sys, urllib.request
url, destination = sys.argv[1:]
with urllib.request.urlopen(url, timeout=120) as response:
    pathlib.Path(destination).write_bytes(response.read())
PY
    test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = "$uv_archive_sha256"
    mkdir "$runtime_stage/uv-archive"
    tar -xzf "$archive" -C "$runtime_stage/uv-archive"
    extracted="$runtime_stage/uv-archive/uv-$uv_target/uv"
    test -f "$extracted" && test ! -L "$extracted"
    cp --no-preserve=ownership -- "$extracted" "$runtime_stage/uv"
    rm -rf -- "$archive" "$runtime_stage/uv-archive"
  fi
  test "$(sha256sum "$runtime_stage/uv" | cut -d ' ' -f 1)" = "$uv_sha256"
  chmod 0500 "$runtime_stage/uv"
  test "$("$runtime_stage/uv" --version)" = "uv $uv_version ($uv_target)"
  mkdir "$runtime_stage/uv-home"
  (
    cd "$runtime_stage/source"
    env -i PATH=/usr/bin:/bin HOME="$runtime_stage/uv-home" PYTHONDONTWRITEBYTECODE=1 \
      UV_PROJECT_ENVIRONMENT="$runtime_stage/venv" \
      "$runtime_stage/uv" sync --frozen --no-dev --link-mode copy --no-cache \
      --no-managed-python --python /usr/bin/python3 --no-progress
  )
  test -z "$(git -C "$runtime_stage/source" status --porcelain=v1 --untracked-files=all --ignored=matching)"
  printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$source_commit" "$package_version" "$uv_version" "$uv_target" "$uv_sha256" "$uv_lock_sha256" \
    "$uv_archive_url" "$uv_archive_sha256" \
    > "$runtime_stage/.cauce-runtime.pending"
  rm -rf -- "$runtime_stage/uv-home"
  chown -R 0:0 "$runtime_stage"
  # Keep the root directory writable by root until the ready marker is atomically published.
  chmod 0755 "$runtime_stage"
  find "$runtime_stage" -xdev -type d -exec chmod 0555 {} +
  find "$runtime_stage" -xdev -type f -perm /0111 -exec chmod 0555 {} +
  find "$runtime_stage" -xdev -type f ! -perm /0111 -exec chmod 0444 {} +
  chmod 0755 "$runtime_stage"
  mv -- "$runtime_stage/.cauce-runtime.pending" "$runtime_stage/.cauce-runtime"
  chmod 0444 "$runtime_stage/.cauce-runtime"
  chmod 0555 "$runtime_stage"
  rm -- "$runtime_stage/.cauce-build-pending"
  created_runtime=0
  runtime_stage=''
elif [ "$runtime_state" != ready ]; then
  printf 'provision-hermes-runtime: estado de preparación Hermes inválido\n' >&2
  exit 78
fi

verify >/dev/null
INNER

runtime_verifier="$ops_root/scripts/verify-hermes-runtime.py"
[[ -f $runtime_verifier && ! -L $runtime_verifier ]] \
  || { printf 'provision-hermes-runtime: verificador inmutable no disponible\n' >&2; exit 78; }
docker exec -i --user 0 "$container_id" /usr/bin/python3 - \
  --allowed-root "$runtime_root" --runtime-dir "$runtime_root/$alias_name/$runtime_id" \
  --source-commit "$source_commit" --package-version "$package_version" \
  --uv-version "$uv_version" --uv-target "$uv_target" \
  --uv-sha256 "$uv_sha256" --uv-lock-sha256 "$uv_lock_sha256" \
  --uv-archive-url "$uv_archive_url" --uv-archive-sha256 "$uv_archive_sha256" \
  < "$runtime_verifier" >/dev/null \
  || { printf 'provision-hermes-runtime: verificación del runtime inmutable falló\n' >&2; exit 78; }

# The import check is repeated under the real UID and with the persistent profile, no model or net.
docker exec -i --user "$container_user" "$container_id" sh -c \
  'set -eu; cd "$1"; HERMES_HOME="$2" PYTHONDONTWRITEBYTECODE=1 "$3" -c '\''import hermes_cli.oneshot'\''' \
  sh "$runtime_root/$alias_name/$runtime_id/source" \
  "$container_home/.local/share/cauce-v3/hermes/$alias_name" \
  "$runtime_root/$alias_name/$runtime_id/venv/bin/python" >/dev/null \
  || { printf 'provision-hermes-runtime: import Hermes bajo el usuario del alias falló\n' >&2; exit 78; }

printf 'Hermes %s: runtime inmutable %s verificado; perfil persistente separado (credenciales no copiadas).\n' \
  "$alias_name" "$package_version"
