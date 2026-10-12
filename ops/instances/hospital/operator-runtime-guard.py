#!/usr/bin/env python3
"""Install the Hospital trusted runtime and prove the operator container cannot rewrite it.

The runtime holds what the operator executes to produce supervision evidence (praxis-proof.py,
praxis-qa-review.py) and the optional Muse fallback (muse-cli-backend.py plus its OpenClaw plugin). It lives
root:root outside every agent workspace and reaches the operator container only through a read-only bind
mount at the same path. The Muse fallback of the operator stays off unless explicitly enabled.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

# cauce:requiere none

RUNTIME_ROOT = "/opt/cauce-hospital/runtime"
RUNTIME_FILES = ("muse-cli-backend.py", "praxis-proof.py", "praxis-qa-review.py")
PLUGIN_DIRECTORY = "openclaw-muse-native"
PLUGIN_FILES = ("index.js", "openclaw.plugin.json", "package.json")
ACTOR = "1000:1000"
OPENCLAW_CONFIG = "/home/node/.openclaw/openclaw.json"
OPENCLAW_EXTENSION = "/home/node/.openclaw/extensions/hospital-muse-native"
MUSE_MOUNTS = ("/home/node/.muse", "/opt/muse-code")
MUSE_PATHS = ("/home/node/.muse/config", "/opt/muse-code/muse")
FALLBACK_FLAG = "CAUCE_HOSPITAL_OPERATOR_MUSE_FALLBACK"
FALLBACK_MARKERS = (b"muse-cli", b"hospital-muse-native")
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
DOCKER_TIMEOUT_SECONDS = 60
PROBE = ('for p in "$@"; do if [ -L "$p" ]; then echo "link $p"; elif [ -w "$p" ]; then echo "writable $p"; '
         'elif [ -r "$p" ]; then echo "readonly $p"; else echo "missing $p"; fi; done')
EXISTENCE = 'for p in "$@"; do if [ -e "$p" ] || [ -L "$p" ]; then echo "present $p"; else echo "absent $p"; fi; done'


class GuardError(Exception):
    def __init__(self, *codes: str) -> None:
        self.codes = codes
        super().__init__(", ".join(codes))


def runtime_entries() -> list[str]:
    return [*RUNTIME_FILES, *(f"{PLUGIN_DIRECTORY}/{name}" for name in PLUGIN_FILES)]


def within(path: str, root: str) -> bool:
    return PurePosixPath(path).is_relative_to(PurePosixPath(root))


def trusted_ancestors(path: Path, owner: int) -> None:
    """Every existing ancestor must be a real directory that only root (or owner) can rename entries in."""
    for ancestor in (*reversed(path.parents), path):
        try:
            info = os.lstat(ancestor)
        except FileNotFoundError:
            return
        sticky = info.st_mode & stat.S_ISVTX
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, owner}
                or info.st_mode & 0o022 and not sticky):
            raise GuardError(f"untrusted_ancestor:{ancestor}")


def read_regular(path: Path) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise GuardError(f"source_unreadable:{path}") from error
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise GuardError(f"source_not_regular:{path}")
        data = handle.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise GuardError(f"source_too_large:{path}")
    return data


def ensure_directory(path: Path, owner: int, group: int) -> None:
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode):
        raise GuardError(f"runtime_path_not_directory:{path}")
    os.chown(path, owner, group, follow_symlinks=False)
    os.chmod(path, 0o755)


def replace_file(destination: Path, data: bytes, owner: int, group: int) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchown(handle.fileno(), owner, group)
            os.fchmod(handle.fileno(), 0o644)
            os.fsync(handle.fileno())
        # Replace entries inside the directory, never the directory: a bind mount pins the directory inode.
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def prune(directory: Path, keep: set[str]) -> None:
    for entry in os.scandir(directory):
        if entry.name in keep:
            continue
        if entry.is_dir(follow_symlinks=False):
            shutil.rmtree(entry.path)
        else:
            os.unlink(entry.path)


def check_local(root: Path, owner: int) -> dict[str, str]:
    """Return sha256 per entry after proving only `owner` can write the runtime and its exact layout."""
    trusted_ancestors(root, owner)
    errors: list[str] = []
    expected = {"": set(RUNTIME_FILES) | {PLUGIN_DIRECTORY}, PLUGIN_DIRECTORY: set(PLUGIN_FILES)}
    for relative, names in expected.items():
        directory = root / relative if relative else root
        try:
            info = os.lstat(directory)
        except FileNotFoundError:
            errors.append(f"runtime_directory_missing:{directory}")
            continue
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022
                or info.st_mode & 0o005 != 0o005):
            errors.append(f"runtime_directory_untrusted:{directory}")
            continue
        present = set(os.listdir(directory))
        if present != names:
            errors.append(f"runtime_layout_unexpected:{directory}")
    digests: dict[str, str] = {}
    for relative in runtime_entries():
        path = root / relative
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            errors.append(f"runtime_file_missing:{path}")
            continue
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022
                or info.st_mode & 0o004 != 0o004):
            errors.append(f"runtime_file_untrusted:{path}")
            continue
        digests[relative] = hashlib.sha256(read_regular(path)).hexdigest()
    if errors:
        raise GuardError(*errors)
    return digests


def install(source: Path, root: Path, owner: int = 0, group: int = 0) -> dict[str, str]:
    sources = {name: source / name for name in RUNTIME_FILES}
    sources.update({f"{PLUGIN_DIRECTORY}/{name}": source / PLUGIN_DIRECTORY / name for name in PLUGIN_FILES})
    payload = {relative: read_regular(path) for relative, path in sources.items()}
    trusted_ancestors(root.parent, owner)
    for directory in (root.parent, root, root / PLUGIN_DIRECTORY):
        ensure_directory(directory, owner, group)
    for relative, data in payload.items():
        replace_file(root / relative, data, owner, group)
    prune(root, set(RUNTIME_FILES) | {PLUGIN_DIRECTORY})
    prune(root / PLUGIN_DIRECTORY, set(PLUGIN_FILES))
    digests = check_local(root, owner)
    for relative, data in payload.items():
        if digests[relative] != hashlib.sha256(data).hexdigest():
            raise GuardError(f"runtime_install_mismatch:{relative}")
    return digests


def docker(binary: str, *arguments: str) -> bytes:
    try:
        completed = subprocess.run([binary, *arguments], stdin=subprocess.DEVNULL, capture_output=True,
                                   timeout=DOCKER_TIMEOUT_SECONDS, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuardError(f"docker_failed:{arguments[0]}") from error
    if completed.returncode != 0 or len(completed.stdout) > MAX_OUTPUT_BYTES:
        raise GuardError(f"docker_failed:{arguments[0]}")
    return completed.stdout


def actor(binary: str, container: str, *command: str) -> bytes:
    return docker(binary, "exec", "-u", ACTOR, container, *command)


def verdicts(output: bytes) -> dict[str, str]:
    """Map each probed path to its verdict from `<verdict> <path>` lines."""
    result = {}
    for line in output.decode("utf-8", "replace").splitlines():
        verdict, separator, path = line.partition(" ")
        if separator:
            result[path] = verdict
    return result


def inspect(binary: str, container: str) -> dict:
    try:
        value = json.loads(docker(binary, "inspect", "--type", "container", container))
    except ValueError as error:
        raise GuardError("inspect_invalid") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise GuardError("inspect_invalid")
    return value[0]


def mount_errors(info: dict, root: str, fallback: bool) -> list[str]:
    state, mounts = info.get("State"), info.get("Mounts")
    if not isinstance(state, dict) or state.get("Running") is not True:
        return ["container_not_running"]
    if not isinstance(mounts, list) or any(not isinstance(mount, dict) or not isinstance(mount.get("Destination"), str)
                                           for mount in mounts):
        return ["inspect_invalid"]
    errors = []
    runtime = [mount for mount in mounts if mount["Destination"] == root]
    if (len(runtime) != 1 or runtime[0].get("Type") != "bind" or runtime[0].get("Source") != root
            or runtime[0].get("RW") is not False):
        errors.append("runtime_mount_not_read_only_bind")
    if any(mount["Destination"] != root and within(mount["Destination"], root) for mount in mounts):
        errors.append("runtime_mount_shadowed")
    if not fallback and any(within(mount["Destination"], muse) for mount in mounts for muse in MUSE_MOUNTS):
        errors.append("operator_has_muse_runtime")
    return errors


def fallback_env(info: dict) -> bool:
    config = info.get("Config")
    environment = config.get("Env") if isinstance(config, dict) else None
    if not isinstance(environment, list):
        return False
    return any(item == f"{FALLBACK_FLAG}=1" for item in environment if isinstance(item, str))


def verify(container: str, root: str = RUNTIME_ROOT, fallback: bool = False, *, binary: str = "docker",
           owner: int = 0) -> None:
    digests = check_local(Path(root), owner)
    info = inspect(binary, container)
    errors = mount_errors(info, root, fallback)
    if errors in (["container_not_running"], ["inspect_invalid"]):
        raise GuardError(*errors)

    probed = [root, f"{root}/{PLUGIN_DIRECTORY}", *(f"{root}/{relative}" for relative in runtime_entries())]
    access = verdicts(actor(binary, container, "sh", "-c", PROBE, "sh", *probed))
    offending = [path for path in probed if access.get(path) != "readonly"]
    errors.extend(f"runtime_not_read_only_for_actor:{path}" for path in offending)
    if not offending:
        # sha256sum prints `<hex>  <path>`; the container must see the exact bytes installed on the host.
        listing = actor(binary, container, "sha256sum", *probed[2:]).decode("utf-8", "replace").splitlines()
        seen = {path: value for value, separator, path in (line.partition("  ") for line in listing) if separator}
        errors.extend(f"runtime_digest_mismatch:{relative}" for relative in runtime_entries()
                      if seen.get(f"{root}/{relative}") != digests[relative])

    config = actor(binary, container, "cat", OPENCLAW_CONFIG)
    presence = verdicts(actor(binary, container, "sh", "-c", EXISTENCE, "sh", OPENCLAW_EXTENSION, *MUSE_PATHS))
    if any(presence.get(path) not in {"present", "absent"} for path in (OPENCLAW_EXTENSION, *MUSE_PATHS)):
        errors.append("presence_probe_invalid")
    present = {path for path, verdict in presence.items() if verdict == "present"}
    if OPENCLAW_EXTENSION in present:
        errors.append("operator_has_writable_muse_plugin")
    if fallback:
        if not fallback_env(info):
            errors.append("operator_env_lacks_muse_fallback_opt_in")
        if f"{root}/{PLUGIN_DIRECTORY}".encode() not in config:
            errors.append("operator_plugin_not_loaded_from_trusted_runtime")
    else:
        if fallback_env(info):
            errors.append("operator_env_enables_muse_fallback")
        if any(marker in config for marker in FALLBACK_MARKERS):
            errors.append("operator_config_references_muse_fallback")
        if present & set(MUSE_PATHS) and "operator_has_muse_runtime" not in errors:
            errors.append("operator_has_muse_runtime")
    if errors:
        raise GuardError(*errors)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    install_command = commands.add_parser("install")
    install_command.add_argument("--source", required=True, type=Path)
    verify_command = commands.add_parser("verify")
    verify_command.add_argument("--container", required=True)
    verify_command.add_argument("--muse-fallback", required=True, choices=("0", "1"))
    options = parser.parse_args(argv)
    try:
        if os.geteuid() != 0:
            raise GuardError("requires_root")
        if options.command == "install":
            install(options.source, Path(RUNTIME_ROOT))
            print(f"Runtime confiable instalado en {RUNTIME_ROOT} (root:root, sin escritura para el agente)")
        else:
            verify(options.container, RUNTIME_ROOT, options.muse_fallback == "1")
            state = "ACTIVADO" if options.muse_fallback == "1" else "desactivado"
            print(f"Runtime confiable montado de solo lectura en {options.container}; "
                  f"fallback Muse del operador: {state}")
    except (GuardError, OSError) as error:
        codes = error.codes if isinstance(error, GuardError) else (f"os_error:{error.strerror}:{error.filename}",)
        for code in codes:
            print(f"operator-runtime-guard: {code}", file=sys.stderr)
        print("Ver docs/v4-migracion-plan.md §4 (runtime confiable y fallback Muse del operador)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
