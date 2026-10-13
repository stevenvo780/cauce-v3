#!/usr/bin/env python3
"""Install the Hospital trusted runtime and verify its host-enforced read-only boundary.

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
INSTANCE_RUNTIME = "/opt/hospital-agent/runtime"
DEVELOPER_SIDES = {"teseo": "backend", "perseo": "frontend"}
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


def boundary_errors(info: dict, alias: str) -> list[str]:
    config, host, mounts = info.get("Config"), info.get("HostConfig"), info.get("Mounts")
    network_settings, state = info.get("NetworkSettings"), info.get("State")
    networks = network_settings.get("Networks") if isinstance(network_settings, dict) else None
    if (not isinstance(config, dict) or not isinstance(host, dict) or not isinstance(mounts, list)
            or not isinstance(state, dict) or not isinstance(networks, dict)
            or alias not in ("operador", *DEVELOPER_SIDES)
            or any(not isinstance(mount, dict) or not isinstance(mount.get("Source"), str)
                   or not isinstance(mount.get("Destination"), str) for mount in mounts)):
        return ["boundary_inspect_invalid"]
    errors = []
    if config.get("User") != ACTOR:
        errors.append("container_user_not_actor")
    if host.get("Privileged") is not False:
        errors.append("container_privileged")
    if host.get("ReadonlyRootfs") is not True:
        errors.append("container_rootfs_writable")
    scratch = host.get("Tmpfs")
    if scratch is not None and (not isinstance(scratch, dict) or set(scratch) - {"/tmp"}
                                or any(not isinstance(value, str) for value in scratch.values())):
        errors.append("container_tmpfs_not_allowed")
    security = host.get("SecurityOpt") or []
    if not isinstance(security, list) or not any(value in ("no-new-privileges", "no-new-privileges:true")
                                               for value in security):
        errors.append("container_can_gain_privileges")
    added, dropped = host.get("CapAdd") or [], host.get("CapDrop") or []
    if not isinstance(added, list) or added or not isinstance(dropped, list) or "ALL" not in dropped:
        errors.append("container_capabilities_unsafe")
    if (host.get("Devices") or host.get("DeviceRequests") or any(host.get(mode) not in (None, "", "private")
                                                               for mode in ("PidMode", "IpcMode"))
            or host.get("NetworkMode") == "host"
            or str(host.get("NetworkMode", "")).startswith("container:")):
        errors.append("container_host_access")
    for mount in mounts:
        source, destination = mount.get("Source"), mount.get("Destination")
        if mount.get("Type") == "tmpfs" and source == "" and destination == "/tmp" and mount.get("RW") is True:
            continue
        if (not isinstance(source, str) or not isinstance(destination, str)
                or not PurePosixPath(source).is_absolute() or not PurePosixPath(destination).is_absolute()
                or ".." in PurePosixPath(source).parts or ".." in PurePosixPath(destination).parts):
            errors.append("boundary_mount_invalid")
            continue
        if (source in ("/", "/proc", "/sys", "/dev")
                or any(within(socket, source) or within(socket, destination)
                       for socket in ("/var/run/docker.sock", "/run/docker.sock"))):
            errors.append("container_host_access")
        if mount.get("RW") is not False and (within(source, RUNTIME_ROOT) or within(RUNTIME_ROOT, source)):
            errors.append("runtime_source_has_writable_alias")
        if mount.get("RW") is not False and within(RUNTIME_ROOT, destination):
            errors.append("runtime_ancestor_mounted_writable")
    if alias == "operador":
        errors.extend(mount_errors(info, RUNTIME_ROOT, False))
        if any(mount["Source"] and (within(mount["Source"], f"{INSTANCE_RUNTIME}/{name}")
                                   or within(f"{INSTANCE_RUNTIME}/{name}", mount["Source"]))
               for mount in mounts for name in ("state-muse-operator", "muse-code-bin")):
            errors.append("operator_has_muse_runtime")
        if fallback_env(info):
            errors.append("operator_env_enables_muse_fallback")
        if set(networks) != {"hospital-agent_operator", "hospital-agent_browser-control"}:
            errors.append("operator_networks_unexpected")
    else:
        side = DEVELOPER_SIDES[alias]
        allowed = {
            "/home/node/.muse": (f"{INSTANCE_RUNTIME}/state-muse-{side}", True),
            "/opt/muse-code": (f"{INSTANCE_RUNTIME}/muse-code-bin", False),
            "/home/node/clawd": (f"{INSTANCE_RUNTIME}/developer-workspace/{side}", True),
            "/home/node/clawd/project": (f"{INSTANCE_RUNTIME}/developer-candidates/{side}/crm", True),
            "/home/node/clawd/praxis": (f"{INSTANCE_RUNTIME}/praxis/{side}", True),
            "/home/node/clawd/praxis-upstream": (f"{INSTANCE_RUNTIME}/praxis/operator", False),
            "/run/hospital-access": (f"/run/hospital-access/{alias}", False),
        }
        seen = []
        for mount in mounts:
            destination = mount.get("Destination")
            if mount.get("Type") == "tmpfs" and mount.get("Source") == "" and destination == "/tmp" and mount.get("RW") is True:
                continue
            seen.append(destination)
            if (destination not in allowed or mount.get("Type") != "bind"
                    or (mount.get("Source"), mount.get("RW")) != allowed.get(destination)):
                errors.append("developer_mount_not_allowed")
        if len(seen) != len(allowed) or set(seen) != set(allowed):
            errors.append("developer_mount_layout_unexpected")
        if set(networks) != {f"hospital-agent_builder-{side}"}:
            errors.append("developer_networks_unexpected")
        if info.get("State", {}).get("Running") is not True:
            errors.append("container_not_running")
    return sorted(set(errors))


def verify_operator_state(info: dict) -> None:
    state_root = f"{INSTANCE_RUNTIME}/state-operator"
    mounted = [mount for mount in info["Mounts"] if mount.get("Destination") == "/home/node/.openclaw"]
    if (len(mounted) != 1 or mounted[0].get("Type") != "bind" or mounted[0].get("Source") != state_root
            or any(mount.get("Destination") != "/home/node/.openclaw"
                   and any(within(path, mount["Destination"]) or within(mount["Destination"], path)
                           for path in (OPENCLAW_CONFIG, OPENCLAW_EXTENSION)) for mount in info["Mounts"])):
        raise GuardError("operator_state_mount_untrusted")
    source = Path(state_root)
    for parent in (*reversed(source.parents), source):
        if not stat.S_ISDIR(os.lstat(parent).st_mode):
            raise GuardError("operator_state_path_untrusted")
    config = read_regular(source / "openclaw.json")
    try:
        decoded = json.loads(config)
        if not isinstance(decoded, dict):
            raise ValueError
    except (ValueError, RecursionError) as error:
        raise GuardError("operator_config_invalid") from error
    if any(marker.decode() in json.dumps(decoded, ensure_ascii=False) for marker in FALLBACK_MARKERS):
        raise GuardError("operator_config_references_muse_fallback")
    extensions = source / "extensions"
    if extensions.is_symlink() or os.path.lexists(extensions / "hospital-muse-native"):
        raise GuardError("operator_has_writable_muse_plugin")


def verify_boundary(container: str, alias: str, *, binary: str = "docker") -> None:
    info = inspect(binary, container)
    errors = boundary_errors(info, alias)
    if errors:
        raise GuardError(*errors)
    if alias == "operador":
        verify_operator_state(info)


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
        # Container commands are diagnostic; only host ownership and Docker's read-only bind enforce trust.
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
    boundary_command = commands.add_parser("verify-boundary")
    boundary_command.add_argument("--container", required=True)
    boundary_command.add_argument("--alias", required=True, choices=("operador", *DEVELOPER_SIDES))
    options = parser.parse_args(argv)
    try:
        if os.geteuid() != 0:
            raise GuardError("requires_root")
        if options.command == "install":
            install(options.source, Path(RUNTIME_ROOT))
            print(f"Runtime confiable instalado en {RUNTIME_ROOT} (root:root, sin escritura para el agente)")
        elif options.command == "verify-boundary":
            verify_boundary(options.container, options.alias)
            print(f"Montajes y configuración de {options.alias} verificados desde el host; "
                  "la política de egress requiere comprobación independiente")
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
