from __future__ import annotations

import errno
import hashlib
import os
import re
import stat
import sys

PERMANENT_EXIT = 78
LOCK_EXIT = 73
ARGUMENT_EXIT = 2
# Reserved exit codes the host unit maps to RestartPreventExitStatus. A legitimate
# adapter exit that happens to use one of these must NOT be confused with a permanent
# supervisor failure, so the controller remaps it to ADAPTER_RESTART_EXIT.
RESERVED_SUPERVISOR_EXITS = frozenset({ARGUMENT_EXIT, LOCK_EXIT, PERMANENT_EXIT})
ADAPTER_RESTART_EXIT = 70
METADATA_NAME = "cauce-v3-adapter.json"
LOCK_NAME = "cauce-v3-adapter.lock"
ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
WIRE_ALIAS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
TENANT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
CONTAINER_ID_RE = re.compile(r"^[a-f0-9]{64}$")
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
GENERATION_RE = re.compile(r"^[a-f0-9]{64}$")
SCHEMA_VERSION = 2
METADATA_KEYS = {
    "schemaVersion", "phase", "alias", "stateDirectory", "controlDirectory", "runtimeUid", "runtimeGid",
    "pid", "pgid", "sid", "starttime", "controllerPid", "controllerStarttime",
    "containerId", "containerGeneration", "bundleDigest", "executable",
}
EXECUTABLE_KEYS = {
    "path", "sha256", "device", "inode", "procPath", "procDevice", "procInode", "cmdlineSha256",
}
IDENTITY_ENV_KEYS = ("CAUCE_ALIAS", "CAUCE_RUNTIME_KEY", "CAUCE_TENANT_ID", "CAUCE_STATE_DIR",
                     "CAUCE_CONTROL_DIR", "CAUCE_CONTAINER_ID", "CAUCE_CONTAINER_GENERATION")


class PermanentError(RuntimeError):
    pass


class ExecutableIdentityMismatch(PermanentError):
    """The adapter lineage is proven, but its live executable changed."""


class AdapterExitedBeforeIdentity(RuntimeError):
    """The successfully exec'd adapter exited before identity sampling stabilized."""


class DirectoryAccessError(PermanentError):
    """A lifecycle directory exists but cannot be traversed safely."""


def fail(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def canonical_absolute(path: str, label: str) -> list[str]:
    if not path.startswith("/") or "\x00" in path or "//" in path:
        raise PermanentError(f"{label} is not a canonical absolute path")
    components = path.split("/")[1:]
    if not components or any(part in {"", ".", ".."} for part in components):
        raise PermanentError(f"{label} is not a canonical absolute path")
    if "/" + "/".join(components) != path:
        raise PermanentError(f"{label} is not a canonical absolute path")
    return components


def open_directory(path: str, *, create_below: str | None = None, uid: int | None = None, gid: int | None = None) -> int:
    components = canonical_absolute(path, "directory")
    create_components = canonical_absolute(create_below, "creation boundary") if create_below else None
    if create_components is not None and components[:len(create_components)] != create_components:
        raise PermanentError("state directory escapes its declared mount")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    current = os.open("/", flags)
    traversed: list[str] = []
    try:
        for component in components:
            traversed.append(component)
            try:
                following = os.open(component, flags, dir_fd=current)
            except FileNotFoundError as err:
                if create_components is None or len(traversed) <= len(create_components):
                    raise PermanentError("required state mount path does not exist") from err
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current)
                    following = os.open(component, flags, dir_fd=current)
                except OSError as error:
                    if error.errno in {errno.EACCES, errno.EPERM}:
                        raise DirectoryAccessError("directory path is not accessible") from error
                    raise
                if uid is not None and gid is not None:
                    os.fchown(following, uid, gid)
                    os.fchmod(following, 0o700)
            except OSError as error:
                if error.errno in {errno.EACCES, errno.EPERM}:
                    raise DirectoryAccessError("directory path is not accessible") from error
                if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                    raise PermanentError("state path contains a symlink or non-directory component") from error
                raise
            os.close(current)
            current = following
        return current
    except Exception:
        os.close(current)
        raise


def prepare_state(mount: str, state_directory: str, uid: int, gid: int) -> None:
    mount_components = canonical_absolute(mount, "mount destination")
    state_components = canonical_absolute(state_directory, "state directory")
    if state_components[:len(mount_components)] != mount_components:
        raise PermanentError("state directory escapes its declared mount")
    mount_fd = open_directory(mount)
    os.close(mount_fd)
    state_fd = open_directory(state_directory, create_below=mount, uid=uid, gid=gid)
    try:
        details = os.fstat(state_fd)
        if not stat.S_ISDIR(details.st_mode):
            raise PermanentError("state leaf is not a directory")
        os.fchown(state_fd, uid, gid)
        os.fchmod(state_fd, 0o700)
        os.fsync(state_fd)
    finally:
        os.close(state_fd)


def prepare_control(base: str, alias: str) -> None:
    # Create the root-owned control directory that holds the lock and lifecycle
    # metadata. It lives outside the runtime-user-owned state mount so the adapter
    # UID can never unlink or forge the control plane.
    if os.geteuid() != 0:
        raise PermanentError("control directory preparation requires root")
    if not ALIAS_RE.fullmatch(alias):
        raise PermanentError("control directory alias is invalid")
    canonical_absolute(base, "control base")
    control = f"{base}/{alias}"
    control_fd = open_directory(control, create_below="/run", uid=0, gid=0)
    try:
        details = os.fstat(control_fd)
        if not stat.S_ISDIR(details.st_mode):
            raise PermanentError("control path is not a directory")
        if details.st_uid != 0 or details.st_gid != 0:
            raise PermanentError("control directory ownership is not root:root")
        os.fchown(control_fd, 0, 0)
        os.fchmod(control_fd, 0o700)
        os.fsync(control_fd)
    finally:
        os.close(control_fd)


def open_control_directory(control_directory: str) -> int:
    # Open (never create) the control directory and prove it is owned by the
    # controller's own effective UID and inaccessible to group/other. In
    # production the controller is root, so a control dir owned by the adapter
    # UID (or writable by it) is rejected fail-closed.
    control_fd = open_directory(control_directory)
    try:
        details = os.fstat(control_fd)
        if not stat.S_ISDIR(details.st_mode):
            raise PermanentError("control path is not a directory")
        if details.st_uid != os.geteuid():
            raise PermanentError("control directory is not owned by the lifecycle controller")
        if details.st_mode & 0o077:
            raise PermanentError("control directory is group- or world-accessible")
    except Exception:
        os.close(control_fd)
        raise
    return control_fd


def framed_hash(parts: list[bytes]) -> str:
    digest = hashlib.sha256()
    for value in parts:
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
    return f"sha256:{digest.hexdigest()}"


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def bundle_digest(root_path: str) -> str:
    canonical = os.path.realpath(root_path)
    if not os.path.isabs(root_path) or not os.path.isdir(canonical):
        raise PermanentError("bundle root is unavailable")
    root_prefix = canonical + os.sep
    entries: list[tuple[str, os.stat_result]] = []
    for current, directories, files in os.walk(canonical, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        relative_current = os.path.relpath(current, canonical)
        if relative_current != ".":
            entries.append((relative_current, os.lstat(current)))
        for name in files:
            relative = name if relative_current == "." else f"{relative_current}/{name}"
            entries.append((relative, os.lstat(os.path.join(current, name))))
        for name in list(directories):
            candidate = os.path.join(current, name)
            if os.path.islink(candidate):
                relative = name if relative_current == "." else f"{relative_current}/{name}"
                entries.append((relative, os.lstat(candidate)))
                directories.remove(name)
    payload: list[bytes] = []
    for relative, details in sorted(entries, key=lambda item: item[0]):
        full_path = os.path.join(canonical, relative)
        mode = stat.S_IMODE(details.st_mode)
        if stat.S_ISREG(details.st_mode):
            kind = b"file"
            with open(full_path, "rb", buffering=0) as stream:
                content = stream.read()
        elif stat.S_ISDIR(details.st_mode):
            kind = b"directory"
            content = b""
        elif stat.S_ISLNK(details.st_mode):
            kind = b"symlink"
            target = os.readlink(full_path)
            resolved = os.path.realpath(full_path)
            if resolved != canonical and not resolved.startswith(root_prefix):
                raise PermanentError("bundle symlink escapes its release")
            content = target.encode("utf-8")
        else:
            raise PermanentError("bundle contains an unsupported entry type")
        payload.extend((relative.encode("utf-8"), kind, f"{mode:o}".encode("ascii"), content))
    return framed_hash(payload)
