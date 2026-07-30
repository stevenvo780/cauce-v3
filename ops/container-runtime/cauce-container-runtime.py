#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
from typing import Any, Callable


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
ALIAS_RE = re.compile(r"^[a-z][a-z0-9-]*$")
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
IDENTITY_ENV_KEYS = ("CAUCE_ALIAS", "CAUCE_STATE_DIR", "CAUCE_CONTROL_DIR", "CAUCE_CONTAINER_ID", "CAUCE_CONTAINER_GENERATION")


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
            except FileNotFoundError:
                if create_components is None or len(traversed) <= len(create_components):
                    raise PermanentError("required state mount path does not exist")
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


def guard_exec(init_starttime: int, command: list[str]) -> None:
    if not command:
        raise PermanentError("guarded command is required")
    if proc_stat(1)["starttime"] != init_starttime:
        raise PermanentError("container init generation changed before guarded operation")
    os.execvp(command[0], command)


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


def proc_stat(pid: int) -> dict[str, int | str]:
    try:
        raw = open(f"/proc/{pid}/stat", "r", encoding="utf-8").read()
    except (FileNotFoundError, ProcessLookupError) as error:
        raise ProcessLookupError(pid) from error
    close = raw.rfind(")")
    if close < 0:
        raise PermanentError("process stat is malformed")
    fields = raw[close + 2:].split()
    if len(fields) < 20:
        raise PermanentError("process stat is incomplete")
    return {
        "state": fields[0],
        "ppid": int(fields[1]),
        "pgid": int(fields[2]),
        "sid": int(fields[3]),
        "starttime": int(fields[19]),
    }


def process_credentials(pid: int) -> tuple[int, int]:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8") as stream:
            raw = stream.read()
    except (FileNotFoundError, ProcessLookupError) as error:
        raise ProcessLookupError(pid) from error
    real_uid: int | None = None
    real_gid: int | None = None
    for line in raw.splitlines():
        if line.startswith("Uid:"):
            real_uid = int(line.split()[1])
        elif line.startswith("Gid:"):
            real_gid = int(line.split()[1])
    if real_uid is None or real_gid is None:
        raise PermanentError("process credentials are unavailable")
    return real_uid, real_gid


_LIBC = ctypes.CDLL(None, use_errno=True)
_LIBC.setfsuid.argtypes = [ctypes.c_uint]
_LIBC.setfsuid.restype = ctypes.c_int
_LIBC.setfsgid.argtypes = [ctypes.c_uint]
_LIBC.setfsgid.restype = ctypes.c_int


class matched_fs_credentials:
    """Temporarily match a target's fs credentials so a root controller can read the
    ptrace-gated /proc/<pid>/{exe,environ} of the non-root adapter it launched.

    A container's root usually lacks CAP_SYS_PTRACE (Docker drops it), so
    ptrace_may_access(PTRACE_MODE_READ_FSCREDS) is only satisfied when our fsuid/fsgid
    equal the target's. Switching fs credentials needs only CAP_SETUID/CAP_SETGID
    (which root keeps) and never changes the real/effective identity used for signals.
    Restored to root on exit. A no-op unless we are root and the target differs.
    """

    def __init__(self, uid: int, gid: int) -> None:
        self._switch = os.geteuid() == 0 and (uid != os.getuid() or gid != os.getgid())
        self._uid = uid
        self._gid = gid
        self._previous_uid: int | None = None
        self._previous_gid: int | None = None

    def __enter__(self) -> "matched_fs_credentials":
        if self._switch:
            # setfs[ug]id returns the previous value, not a success code. The
            # second call is therefore the confirmation: it must return the
            # requested value. Keep the originals so a partial switch is undone.
            previous_gid = int(_LIBC.setfsgid(self._gid))
            confirmed_gid = int(_LIBC.setfsgid(self._gid))
            if confirmed_gid != self._gid:
                _LIBC.setfsgid(previous_gid)
                raise PermanentError("could not match target filesystem gid")
            self._previous_gid = previous_gid

            previous_uid = int(_LIBC.setfsuid(self._uid))
            confirmed_uid = int(_LIBC.setfsuid(self._uid))
            if confirmed_uid != self._uid:
                _LIBC.setfsuid(previous_uid)
                _LIBC.setfsgid(previous_gid)
                self._previous_gid = None
                raise PermanentError("could not match target filesystem uid")
            self._previous_uid = previous_uid
        return self

    def __exit__(self, *_exc: Any) -> bool:
        if self._switch:
            previous_uid = self._previous_uid
            previous_gid = self._previous_gid
            if previous_uid is None or previous_gid is None:
                raise PermanentError("filesystem credentials were not switched completely")
            _LIBC.setfsuid(previous_uid)
            _LIBC.setfsgid(previous_gid)
            self._previous_uid = None
            self._previous_gid = None
            # Changing fs credentials clears the dumpable flag (suid_dumpable policy),
            # which would hide THIS controller's /proc from the same-uid root check/stop
            # verifiers. Re-mark it dumpable so root can still introspect it.
            _LIBC.prctl(4, 1, 0, 0, 0)  # PR_SET_DUMPABLE=1
        return False


def pid_exists(pid: int) -> bool:
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def pid_running(pid: int) -> bool:
    # A zombie is a terminated process awaiting reaping: it executes nothing and is,
    # for stop purposes, gone. Treating it as live would let a non-reaping init (or a
    # parent blocked in a synchronous call) wedge a teardown that already succeeded.
    if not pid_exists(pid):
        return False
    try:
        return proc_stat(pid)["state"] != "Z"
    except (ProcessLookupError, PermanentError):
        return False


def open_pidfd(pid: int) -> int:
    """Pin one numeric PID so later signals can never hit a reused PID."""
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise PermanentError("pidfd support is required for safe lifecycle teardown")
    try:
        return os.pidfd_open(pid, 0)
    except ProcessLookupError:
        raise
    except OSError as error:
        if error.errno in {errno.ENOSYS, errno.EINVAL}:
            raise PermanentError("pidfd support is unavailable for safe lifecycle teardown") from error
        raise PermanentError("process identity could not be pinned safely") from error


def pidfd_running(pid_fd: int) -> bool:
    poller = select.poll()
    poller.register(pid_fd, select.POLLIN | select.POLLHUP | select.POLLERR)
    return not poller.poll(0)


def signal_pidfd(pid_fd: int, process_signal: signal.Signals) -> None:
    try:
        signal.pidfd_send_signal(pid_fd, process_signal)
    except ProcessLookupError:
        pass


def pidfd_matches_starttime(pid: int, pid_fd: int, starttime: int) -> bool:
    if not pidfd_running(pid_fd):
        return False
    try:
        return proc_stat(pid)["starttime"] == starttime
    except (ProcessLookupError, PermissionError, OSError, PermanentError):
        return False


def group_members(pgid: int) -> list[int]:
    members: list[int] = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            if proc_stat(pid)["pgid"] == pgid:
                members.append(pid)
        except (ProcessLookupError, PermissionError, ValueError):
            continue
    return sorted(members)


def descendants(root_pid: int) -> list[int]:
    parent_to_children: dict[int, list[int]] = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            parent = int(proc_stat(pid)["ppid"])
        except (ProcessLookupError, PermissionError, ValueError):
            continue
        parent_to_children.setdefault(parent, []).append(pid)
    found: list[int] = []
    pending = list(parent_to_children.get(root_pid, []))
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found.append(pid)
        pending.extend(parent_to_children.get(pid, []))
    return sorted(found)


def selected_environment(pid: int) -> dict[str, str]:
    target_uid, target_gid = process_credentials(pid)
    try:
        with matched_fs_credentials(target_uid, target_gid):
            raw = open(f"/proc/{pid}/environ", "rb").read()
    except FileNotFoundError as error:
        raise ProcessLookupError(pid) from error
    selected: dict[str, str] = {}
    wanted = set(IDENTITY_ENV_KEYS)
    for item in raw.split(b"\0"):
        if b"=" not in item:
            continue
        key, value = item.split(b"=", 1)
        decoded_key = key.decode("utf-8", "strict")
        if decoded_key in wanted:
            selected[decoded_key] = value.decode("utf-8", "strict")
    return selected


def alias_generation_pids(alias: str, generation: str, state_directory: str, *, exclude: set[int] | None = None) -> list[int]:
    # Environment is forgeable by any same-UID process. Matches are therefore used
    # only to detect ambiguous/untracked processes and force exit 78; they are never
    # signal targets. Scoping by state keeps distinct alias instances separate.
    skip = set(exclude or ())
    matches: list[int] = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid <= 1 or pid in skip:
            continue
        try:
            environment = selected_environment(pid)
        except (ProcessLookupError, PermissionError, UnicodeDecodeError, OSError):
            continue
        if environment.get("CAUCE_ALIAS") == alias \
                and environment.get("CAUCE_CONTAINER_GENERATION") == generation \
                and environment.get("CAUCE_STATE_DIR") == state_directory:
            matches.append(pid)
    return sorted(matches)


def command_line_hash(pid: int) -> str:
    try:
        raw = open(f"/proc/{pid}/cmdline", "rb").read()
    except FileNotFoundError as error:
        raise ProcessLookupError(pid) from error
    return framed_hash([raw])


def executable_identity(pid: int, requested_path: str) -> dict[str, Any]:
    canonical = os.path.realpath(requested_path)
    requested = os.stat(canonical, follow_symlinks=False)
    if not stat.S_ISREG(requested.st_mode):
        raise PermanentError("adapter executable is not a regular file")
    target_uid, target_gid = process_credentials(pid)
    with matched_fs_credentials(target_uid, target_gid):
        proc_link = os.readlink(f"/proc/{pid}/exe")
        proc_details = os.stat(f"/proc/{pid}/exe")
    return {
        "path": canonical,
        "sha256": file_sha256(canonical),
        "device": requested.st_dev,
        "inode": requested.st_ino,
        "procPath": proc_link,
        "procDevice": proc_details.st_dev,
        "procInode": proc_details.st_ino,
        "cmdlineSha256": command_line_hash(pid),
    }


def starting_executable_identity(requested_path: str) -> dict[str, Any]:
    canonical = os.path.realpath(requested_path)
    requested = os.stat(canonical, follow_symlinks=False)
    if not stat.S_ISREG(requested.st_mode):
        raise PermanentError("adapter executable is not a regular file")
    return {
        "path": canonical,
        "sha256": file_sha256(canonical),
        "device": requested.st_dev,
        "inode": requested.st_ino,
        "procPath": None,
        "procDevice": None,
        "procInode": None,
        "cmdlineSha256": None,
    }


def wait_for_exec(tree: "PinnedLeaderTree", requested_path: str, timeout: float = 3.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    pid = tree.leader_pid
    canonical = os.path.realpath(requested_path).encode("utf-8")
    last_error: Exception | None = None
    previous: dict[str, Any] | None = None
    stable = 0
    while time.monotonic() < deadline:
        # Refresh while the exact leader is still pinned. If the adapter exits,
        # its Popen status is propagated by run_adapter rather than being
        # misclassified as a permanent executable-identity timeout.
        tree.refresh()
        if not tree.leader_is_live():
            raise AdapterExitedBeforeIdentity
        try:
            raw = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
            if canonical in raw:
                candidate = executable_identity(pid, requested_path)
                if candidate == previous:
                    stable += 1
                    if stable >= 2:
                        return candidate
                else:
                    previous = candidate
                    stable = 0
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError) as error:
            last_error = error
            if not tree.leader_is_live():
                raise AdapterExitedBeforeIdentity from error
        time.sleep(0.05)
    raise PermanentError("adapter did not establish its executable identity") from last_error


def metadata_hint(raw: bytes) -> int | None:
    match = re.search(rb'"pid"\s*:\s*([0-9]+)', raw)
    if not match:
        return None
    value = int(match.group(1))
    return value if value > 1 else None


def validate_metadata(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict) or set(document) != METADATA_KEYS:
        raise PermanentError("lifecycle metadata has unexpected or missing fields")
    if document["schemaVersion"] != SCHEMA_VERSION or document["phase"] not in {"starting", "running"} \
            or not isinstance(document["alias"], str) or not ALIAS_RE.fullmatch(document["alias"]):
        raise PermanentError("lifecycle metadata identity is invalid")
    canonical_absolute(document["stateDirectory"], "metadata state directory")
    canonical_absolute(document["controlDirectory"], "metadata control directory")
    for field in ("controllerPid", "controllerStarttime", "runtimeUid", "runtimeGid"):
        if not isinstance(document[field], int) or document[field] <= 0:
            raise PermanentError(f"lifecycle metadata {field} is invalid")
    for field in ("pid", "pgid", "sid", "starttime"):
        if document["phase"] == "starting":
            if document[field] is not None:
                raise PermanentError(f"starting lifecycle metadata {field} must be null")
        elif not isinstance(document[field], int) or document[field] <= 0:
            raise PermanentError(f"running lifecycle metadata {field} is invalid")
    if not isinstance(document["containerId"], str) or not CONTAINER_ID_RE.fullmatch(document["containerId"]):
        raise PermanentError("lifecycle metadata container ID is invalid")
    if not isinstance(document["containerGeneration"], str) or not GENERATION_RE.fullmatch(document["containerGeneration"]):
        raise PermanentError("lifecycle metadata generation is invalid")
    if not isinstance(document["bundleDigest"], str) or not DIGEST_RE.fullmatch(document["bundleDigest"]):
        raise PermanentError("lifecycle metadata bundle digest is invalid")
    executable = document["executable"]
    if not isinstance(executable, dict) or set(executable) != EXECUTABLE_KEYS:
        raise PermanentError("lifecycle executable metadata is invalid")
    canonical_absolute(executable["path"], "metadata executable path")
    if not isinstance(executable["sha256"], str) or not DIGEST_RE.fullmatch(executable["sha256"]):
        raise PermanentError("lifecycle executable digest is invalid")
    for field in ("device", "inode"):
        if not isinstance(executable[field], int) or executable[field] < 0:
            raise PermanentError("lifecycle executable file identity is invalid")
    for field in ("procDevice", "procInode"):
        if document["phase"] == "starting":
            if executable[field] is not None:
                raise PermanentError("starting process executable identity must be null")
        elif not isinstance(executable[field], int) or executable[field] < 0:
            raise PermanentError("running process executable identity is invalid")
    if document["phase"] == "starting":
        if executable["procPath"] is not None or executable["cmdlineSha256"] is not None:
            raise PermanentError("starting process executable fields must be null")
    elif not isinstance(executable["procPath"], str) or not executable["procPath"].startswith("/") \
            or not isinstance(executable["cmdlineSha256"], str) or not DIGEST_RE.fullmatch(executable["cmdlineSha256"]):
        raise PermanentError("running process executable identity is invalid")
    return document


def read_metadata(control_fd: int) -> tuple[dict[str, Any] | None, bytes | None]:
    try:
        metadata_fd = os.open(METADATA_NAME, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=control_fd)
    except FileNotFoundError:
        return None, None
    except OSError as error:
        raise PermanentError("lifecycle metadata cannot be opened safely") from error
    try:
        details = os.fstat(metadata_fd)
        if not stat.S_ISREG(details.st_mode) or details.st_size > 64 * 1024:
            raise PermanentError("lifecycle metadata is not a bounded regular file")
        raw = os.read(metadata_fd, 64 * 1024 + 1)
    finally:
        os.close(metadata_fd)
    try:
        return validate_metadata(json.loads(raw.decode("utf-8"))), raw
    except (UnicodeDecodeError, json.JSONDecodeError, PermanentError) as error:
        hint = metadata_hint(raw)
        if hint is not None and pid_exists(hint):
            raise PermanentError("live PID has incomplete or malformed lifecycle metadata") from error
        raise PermanentError("lifecycle metadata is malformed and was preserved") from error


def atomic_metadata(control_fd: int, document: dict[str, Any]) -> None:
    body = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    temporary = f".{METADATA_NAME}.{os.getpid()}.{time.monotonic_ns()}"
    temporary_fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=control_fd,
    )
    try:
        written = 0
        while written < len(body):
            written += os.write(temporary_fd, body[written:])
        os.fsync(temporary_fd)
    finally:
        os.close(temporary_fd)
    try:
        os.rename(temporary, METADATA_NAME, src_dir_fd=control_fd, dst_dir_fd=control_fd)
        os.fsync(control_fd)
    except Exception:
        try:
            os.unlink(temporary, dir_fd=control_fd)
        except FileNotFoundError:
            pass
        raise


def remove_metadata(control_fd: int) -> None:
    try:
        os.unlink(METADATA_NAME, dir_fd=control_fd)
        os.fsync(control_fd)
    except FileNotFoundError:
        pass


def open_lock(control_fd: int) -> int:
    try:
        lock_fd = os.open(LOCK_NAME, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=control_fd)
    except OSError as error:
        raise PermanentError("lifecycle lock cannot be opened safely") from error
    details = os.fstat(lock_fd)
    if not stat.S_ISREG(details.st_mode):
        os.close(lock_fd)
        raise PermanentError("lifecycle lock is not a regular file")
    if details.st_uid != os.geteuid():
        os.close(lock_fd)
        raise PermanentError("lifecycle lock is not owned by the lifecycle controller")
    return lock_fd


def lock_control(control_fd: int) -> int:
    lock_fd = open_lock(control_fd)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock_fd)
        fail("adapter lifecycle lock is held", LOCK_EXIT)
    return lock_fd


def lock_is_held(control_fd: int) -> bool:
    # Probe whether a live controller currently owns the lifecycle lock without
    # taking it. A held lock during a stop with no metadata is an ambiguous,
    # fail-closed condition (the controller may be mid-startup pre-publication).
    try:
        lock_fd = os.open(LOCK_NAME, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=control_fd)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise PermanentError("lifecycle lock cannot be probed safely") from error
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(lock_fd)


def expected_environment(document: dict[str, Any]) -> dict[str, str]:
    return {
        "CAUCE_ALIAS": document["alias"],
        "CAUCE_STATE_DIR": document["stateDirectory"],
        "CAUCE_CONTROL_DIR": document["controlDirectory"],
        "CAUCE_CONTAINER_ID": document["containerId"],
        "CAUCE_CONTAINER_GENERATION": document["containerGeneration"],
    }


def verify_adapter(document: dict[str, Any], alias: str, state_directory: str) -> None:
    # Prove the running-phase adapter PID is exactly the leader described by the
    # metadata. Raises ProcessLookupError if the PID is gone and PermanentError on
    # any mismatch. ExecutableIdentityMismatch is raised only after every lineage
    # field has matched, allowing stop (and only stop) to terminate a same-lineage
    # process that re-execed without turning other mismatches into signal targets.
    if document["alias"] != alias or document["stateDirectory"] != state_directory:
        raise PermanentError("lifecycle metadata alias/state mismatch")
    if document["phase"] != "running":
        raise PermanentError("lifecycle metadata is not in the running phase")
    pid = document["pid"]
    if not pid_exists(pid):
        raise ProcessLookupError(pid)
    details = proc_stat(pid)
    if details["starttime"] != document["starttime"]:
        raise PermanentError("live PID starttime differs from lifecycle metadata")
    if details["pgid"] != document["pgid"] or details["sid"] != document["sid"]:
        raise PermanentError("live PID process-group/session differs from lifecycle metadata")
    if document["pid"] != document["pgid"] or document["pid"] != document["sid"]:
        raise PermanentError("adapter is not the leader of its dedicated session")
    if selected_environment(pid) != expected_environment(document):
        raise PermanentError("live PID environment identity differs from lifecycle metadata")
    real_uid, real_gid = process_credentials(pid)
    if real_uid != document["runtimeUid"] or real_gid != document["runtimeGid"]:
        raise PermanentError("live PID runtime identity differs from lifecycle metadata")
    if real_uid == 0 or real_gid == 0:
        raise PermanentError("adapter must not run as root")
    if pid not in group_members(document["pgid"]):
        raise PermanentError("adapter session leader is absent from its process group")
    live_executable = executable_identity(pid, document["executable"]["path"])
    if live_executable != document["executable"]:
        raise ExecutableIdentityMismatch("live PID executable identity differs from lifecycle metadata")


def pin_verified_adapter(document: dict[str, Any], alias: str, state_directory: str, *, allow_reexec: bool) -> int:
    pid_fd = open_pidfd(document["pid"])
    try:
        try:
            verify_adapter(document, alias, state_directory)
        except ExecutableIdentityMismatch:
            if not allow_reexec:
                raise
        except ProcessLookupError:
            raise
        except (PermissionError, UnicodeDecodeError, OSError) as error:
            raise PermanentError("adapter process identity could not be verified; metadata was preserved") from error
        if not pidfd_running(pid_fd):
            raise ProcessLookupError(document["pid"])
        return pid_fd
    except BaseException:
        os.close(pid_fd)
        raise


def controller_is_live(document: dict[str, Any]) -> bool:
    controller_pid = document["controllerPid"]
    if not pid_exists(controller_pid):
        return False
    try:
        if proc_stat(controller_pid)["starttime"] != document["controllerStarttime"]:
            return False
        return selected_environment(controller_pid) == expected_environment(document)
    except (ProcessLookupError, PermissionError, OSError):
        return False


def verify_controller(document: dict[str, Any]) -> None:
    controller_pid = document["controllerPid"]
    if not pid_exists(controller_pid):
        raise ProcessLookupError(controller_pid)
    if proc_stat(controller_pid)["starttime"] != document["controllerStarttime"]:
        raise PermanentError("lifecycle controller starttime differs from metadata")
    if selected_environment(controller_pid) != expected_environment(document):
        raise PermanentError("lifecycle controller environment differs from metadata")


def pin_verified_controller(document: dict[str, Any]) -> int:
    controller_pid = document["controllerPid"]
    pid_fd = open_pidfd(controller_pid)
    try:
        verify_controller(document)
        if not pidfd_running(pid_fd):
            raise ProcessLookupError(controller_pid)
        return pid_fd
    except BaseException:
        os.close(pid_fd)
        raise


def require_current_generation(document: dict[str, Any], container_id: str, generation: str) -> None:
    if document["containerId"] != container_id or document["containerGeneration"] != generation:
        raise PermanentError("lifecycle metadata belongs to another container generation; no signal was sent")


def stale_generation_is_quiescent(
    control_fd: int,
    document: dict[str, Any],
    alias: str,
    state_directory: str,
    container_id: str,
    generation: str,
    *,
    probe_lock: bool,
) -> bool:
    """Prove that metadata from a prior container generation is inert.

    Container restarts preserve the writable layer on some Docker hosts, so a
    root-owned lifecycle document under ``/run`` may outlive the PID namespace.
    Such metadata must never authorize a signal in the replacement generation,
    but it must not permanently block a clean restart either.

    Returns ``False`` for current-generation metadata.  For stale metadata it
    fails closed if either generation still has an identifiable controller or
    adapter process, otherwise returns ``True`` without deleting or signalling
    anything.  The run path owns the lifecycle lock and performs the eventual
    durable metadata cleanup.
    """
    if document["containerId"] == container_id and document["containerGeneration"] == generation:
        return False
    if document["alias"] != alias or document["stateDirectory"] != state_directory:
        raise PermanentError("lifecycle metadata alias/state mismatch was preserved")
    if probe_lock and lock_is_held(control_fd):
        raise PermanentError("a lifecycle controller holds the lock for stale generation metadata")
    if controller_is_live(document):
        raise PermanentError("a prior container generation still has a live lifecycle controller")
    excluded = {os.getpid()}
    prior = alias_generation_pids(
        alias,
        document["containerGeneration"],
        state_directory,
        exclude=excluded,
    )
    if prior:
        raise PermanentError("a prior container generation still has live alias processes")
    current = alias_generation_pids(alias, generation, state_directory, exclude=excluded)
    if current:
        raise PermanentError("the current container generation has untracked alias processes")
    return True


def reap_children(protected: int | None = None) -> None:
    """Reap exited children, optionally leaving one PID's status untouched.

    set_subreaper() makes this controller the adoptive parent of every descendant the
    adapter orphans, so nothing else in the container will ever wait() for them: without
    a reap here they stay <defunct> for the whole (multi-day) life of the adapter.

    `protected` is the one PID whose exit status belongs to subprocess.Popen. Consuming
    it here would be silent corruption, not a hang: Popen._internal_poll() maps the
    resulting ECHILD to `returncode = 0`, so a harness that died with a real failure code
    would be reported as a clean exit and the adapter's PROCESS_EXIT_AMBIGUOUS
    classification would be destroyed. waitid(WNOWAIT) peeks without consuming, so the
    protected status stays pending for Popen.poll()/Popen.wait().
    """
    if protected is None:
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid == 0:
                return
    if not hasattr(os, "waitid") or not hasattr(os, "WNOWAIT"):
        # Without a non-consuming peek there is no way to reap orphans and still hand the
        # adapter's own status to Popen. Leaking a zombie is recoverable; losing the
        # adapter exit code is not, so this degrades to not reaping.
        return
    while True:
        try:
            peeked = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return
        if peeked is None or peeked.si_pid == 0:
            return
        if peeked.si_pid == protected:
            # The tracked child is the first entry of the kernel's sibling list, so it
            # shadows the rest while its status is pending. Popen.poll() consumes it on
            # the very next iteration and the following pass drains what is behind it.
            return
        try:
            os.waitpid(peeked.si_pid, os.WNOHANG)
        except ChildProcessError:
            return


class PinnedLeaderTree:
    """A leader and related processes pinned while that exact leader is alive.

    Numeric PGID/descendant discovery is permanently disabled once the original
    leader pidfd/starttime stops validating. Already pinned members remain safe to
    signal after leader reap because pidfds cannot retarget PID/PGID reuse.
    """

    def __init__(self, leader_pid: int) -> None:
        self.leader_pid = leader_pid
        leader_fd = open_pidfd(leader_pid)
        try:
            details = proc_stat(leader_pid)
            self.leader_starttime = int(details["starttime"])
            if not pidfd_matches_starttime(leader_pid, leader_fd, self.leader_starttime):
                raise ProcessLookupError(leader_pid)
        except BaseException:
            os.close(leader_fd)
            raise
        self.leader_fd = leader_fd
        self.pinned: dict[int, tuple[int, int]] = {
            leader_pid: (leader_fd, self.leader_starttime),
        }
        self.refresh()

    def leader_is_live(self) -> bool:
        return pidfd_matches_starttime(self.leader_pid, self.leader_fd, self.leader_starttime)

    def discard_exited(self) -> None:
        for pid, (pid_fd, _starttime) in list(self.pinned.items()):
            if not pidfd_running(pid_fd):
                if pid_fd != self.leader_fd:
                    os.close(pid_fd)
                del self.pinned[pid]

    def refresh(self) -> None:
        self.discard_exited()
        if not self.leader_is_live():
            return
        group = set(group_members(self.leader_pid))
        children = set(descendants(self.leader_pid))
        for pid in sorted(group | children):
            if pid in self.pinned or pid <= 1:
                continue
            pid_fd: int | None = None
            try:
                pid_fd = open_pidfd(pid)
                details = proc_stat(pid)
                starttime = int(details["starttime"])
                still_grouped = pid in group and details["pgid"] == self.leader_pid
                still_descendant = pid in children and pid in descendants(self.leader_pid)
                if self.leader_is_live() and (still_grouped or still_descendant) \
                        and pidfd_matches_starttime(pid, pid_fd, starttime):
                    self.pinned[pid] = (pid_fd, starttime)
                    pid_fd = None
            except (ProcessLookupError, PermissionError, OSError, PermanentError):
                pass
            finally:
                if pid_fd is not None:
                    os.close(pid_fd)

    def signal(self, process_signal: signal.Signals) -> None:
        self.refresh()
        for pid, (pid_fd, starttime) in list(self.pinned.items()):
            if pidfd_matches_starttime(pid, pid_fd, starttime):
                signal_pidfd(pid_fd, process_signal)
            elif pidfd_running(pid_fd):
                raise PermanentError("pinned process starttime changed before internal teardown signal")

    def wait_empty(self, timeout: float, *, can_reap: bool) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if can_reap:
                reap_children()
            self.refresh()
            if not self.pinned:
                return True
            time.sleep(0.05)
        if can_reap:
            reap_children()
        self.refresh()
        return not self.pinned

    def close(self) -> None:
        closed: set[int] = set()
        for pid_fd, _starttime in self.pinned.values():
            if pid_fd not in closed:
                os.close(pid_fd)
                closed.add(pid_fd)
        if self.leader_fd not in closed:
            os.close(self.leader_fd)
        self.pinned.clear()


def signal_known_tree(tree: PinnedLeaderTree, term_seconds: float, kill_seconds: float, *, can_reap: bool) -> None:
    tree.signal(signal.SIGTERM)
    if tree.wait_empty(term_seconds, can_reap=can_reap):
        return
    tree.signal(signal.SIGKILL)
    if not tree.wait_empty(kill_seconds, can_reap=can_reap):
        raise PermanentError("adapter descendant tree still has live pinned members after SIGKILL")


def wait_process_tracking(
    process: subprocess.Popen[bytes],
    tree: PinnedLeaderTree,
    timeout: float | None = None,
) -> int:
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        # Discovery happens before poll()/waitpid can reap and release the leader
        # PID. Once poll observes exit, tree.refresh() will never scan that PGID.
        tree.refresh()
        status = process.poll()
        if status is not None:
            return status
        # This is the only long-lived loop in the supervisor, so it is the only place
        # that can drain the orphans PR_SET_CHILD_SUBREAPER hands us while the adapter
        # runs. It runs after poll() so the leader's status is always claimed by Popen
        # first, and passes it as `protected` to close the exit-between-the-two race.
        reap_children(protected=process.pid)
        if deadline is not None and time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired(process.args, timeout)
        time.sleep(0.02)


def stop_signal_gate() -> None:
    """Bounded test-only barrier after pinning and before the first signal."""
    spec = os.environ.get("CAUCE_CONTAINER_TEST_STOP_GATE")
    if not spec:
        return
    parts = spec.split("|")
    if len(parts) != 3:
        return
    marker, release, seconds = parts
    try:
        limit = float(seconds)
        with open(marker, "w", encoding="utf-8") as stream:
            stream.write(f"pinned:{os.getpid()}\n")
    except (OSError, ValueError):
        return
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline and not os.path.exists(release):
        time.sleep(0.02)


def terminate_from_metadata(
    document: dict[str, Any],
    alias: str,
    state_directory: str,
    term_seconds: float,
    kill_seconds: float,
) -> None:
    # External teardown never signals a bare PID or PGID. The adapter leader and
    # every observed related process are pinned with pidfds; relation checks are
    # repeated after pinning. Pins survive TERM->KILL even if a target reparents,
    # changes session/environment, or the numeric PID/PGID becomes reusable.
    controller_pid = document["controllerPid"]
    pgid = document["pgid"]
    generation = document["containerGeneration"]
    self_pid = os.getpid()
    pinned: dict[int, tuple[int, int]] = {}
    controller_pin: tuple[int, int] | None = None

    if document["phase"] != "running" or document["pid"] is None:
        raise PermanentError("adapter leader is not published; metadata was preserved and no signal was sent")

    try:
        try:
            leader_fd = pin_verified_adapter(
                document, alias, state_directory, allow_reexec=True,
            )
            pinned[document["pid"]] = (leader_fd, document["starttime"])
        except ProcessLookupError as error:
            raise PermanentError("current-generation adapter PID is absent; metadata was preserved") from error
        try:
            controller_fd = pin_verified_controller(document)
            controller_pin = (controller_fd, document["controllerStarttime"])
        except (PermanentError, ProcessLookupError, PermissionError, OSError):
            # A dead/reused controller is never a traversal root or signal target.
            controller_pin = None

        def discard_exited() -> None:
            controller_fd = controller_pin[0] if controller_pin is not None else None
            for pid, (pid_fd, _starttime) in list(pinned.items()):
                if not pidfd_running(pid_fd):
                    if pid_fd != controller_fd:
                        os.close(pid_fd)
                    del pinned[pid]

        def relation_candidates() -> dict[int, set[str]]:
            related: dict[int, set[str]] = {}

            def add(pid: int, relation: str) -> None:
                if pid > 1 and pid != self_pid:
                    related.setdefault(pid, set()).add(relation)

            leader_pin = pinned.get(document["pid"])
            # Never trust a numeric PGID after the pinned leader has exited.
            if pgid is not None and leader_pin is not None \
                    and pidfd_matches_starttime(document["pid"], leader_pin[0], leader_pin[1]):
                for pid in group_members(pgid):
                    add(pid, "group")
            if leader_pin is not None and pidfd_matches_starttime(document["pid"], leader_pin[0], leader_pin[1]):
                for pid in descendants(document["pid"]):
                    add(pid, "descendant")
            return related

        def refresh_pins() -> None:
            discard_exited()
            for pid, relations in relation_candidates().items():
                if pid in pinned:
                    continue
                pid_fd: int | None = None
                try:
                    pid_fd = open_pidfd(pid)
                    if not pidfd_running(pid_fd):
                        continue
                    details = proc_stat(pid)
                    starttime = int(details["starttime"])
                    valid = False
                    if "group" in relations and pgid is not None:
                        leader_pin = pinned.get(document["pid"])
                        valid = leader_pin is not None \
                            and pidfd_matches_starttime(document["pid"], leader_pin[0], leader_pin[1]) \
                            and details["pgid"] == pgid
                    if not valid and "descendant" in relations:
                        root_pid = document["pid"]
                        root_pin = pinned.get(root_pid)
                        valid = root_pin is not None \
                            and pidfd_matches_starttime(root_pid, root_pin[0], root_pin[1]) \
                            and pid in descendants(root_pid)
                    if valid:
                        pinned[pid] = (pid_fd, starttime)
                        pid_fd = None
                except (ProcessLookupError, PermissionError, UnicodeDecodeError, OSError, PermanentError):
                    pass
                finally:
                    if pid_fd is not None:
                        os.close(pid_fd)

        def assert_no_environment_only_matches() -> None:
            allowed = set(pinned)
            if controller_pin is not None \
                    and pidfd_matches_starttime(controller_pid, controller_pin[0], controller_pin[1]):
                # The verified lifecycle controller carries the same environment
                # but is intentionally spared during a running-phase stop.
                allowed.add(controller_pid)
            matches = set(alias_generation_pids(alias, generation, state_directory, exclude={self_pid}))
            unexpected = sorted(matches - allowed)
            if unexpected:
                raise PermanentError(
                    "environment-only lifecycle identity matches an untracked process; metadata was preserved and no signal was sent"
                )

        def signal_all(process_signal: signal.Signals) -> None:
            refresh_pins()
            assert_no_environment_only_matches()
            for pid, (pid_fd, starttime) in list(pinned.items()):
                if pidfd_matches_starttime(pid, pid_fd, starttime):
                    signal_pidfd(pid_fd, process_signal)
                elif pidfd_running(pid_fd):
                    raise PermanentError("pinned process starttime changed before signalling; metadata was preserved")

        def wait_empty(timeout: float) -> bool:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                refresh_pins()
                assert_no_environment_only_matches()
                if not pinned:
                    return True
                time.sleep(0.05)
            refresh_pins()
            assert_no_environment_only_matches()
            return not pinned

        def wait_running_controller_exit(timeout: float) -> None:
            if controller_pin is None:
                return
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if not pidfd_running(controller_pin[0]):
                    return
                time.sleep(0.02)
            if pidfd_running(controller_pin[0]):
                raise PermanentError("lifecycle controller did not exit after adapter teardown; metadata was preserved")

        refresh_pins()
        assert_no_environment_only_matches()
        stop_signal_gate()
        signal_all(signal.SIGTERM)
        if wait_empty(term_seconds):
            wait_running_controller_exit(kill_seconds)
            return
        signal_all(signal.SIGKILL)
        if not wait_empty(kill_seconds):
            raise PermanentError("adapter tree still has live members after SIGKILL; metadata was preserved")
        wait_running_controller_exit(kill_seconds)
    finally:
        closed: set[int] = set()
        for pid_fd, _starttime in pinned.values():
            if pid_fd not in closed:
                os.close(pid_fd)
                closed.add(pid_fd)
        if controller_pin is not None and controller_pin[0] not in closed:
            os.close(controller_pin[0])


def set_subreaper() -> None:
    if _LIBC.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")


def set_dumpable() -> None:
    # Ensure the controller's own /proc is introspectable by the same-uid (root) check
    # and stop verifiers even where CAP_SYS_PTRACE is unavailable (Docker default, or a
    # setuid launcher such as sudo that clears the dumpable flag). Only root can read it.
    _LIBC.prctl(4, 1, 0, 0, 0)  # PR_SET_DUMPABLE=1


def child_credentials(runtime_uid: int, runtime_gid: int) -> dict[str, Any]:
    # Decide how the adapter child is launched. In production the controller runs
    # as root and drops the child to the exact non-root runtime UID/GID (rejecting
    # 0). In an unprivileged test the controller cannot change identity, so the
    # requested identity must equal the current one and no privilege change occurs.
    if os.geteuid() == 0:
        if runtime_uid <= 0 or runtime_gid <= 0:
            raise PermanentError("runtime uid/gid must be a non-root identity")
        return {"user": runtime_uid, "group": runtime_gid, "extra_groups": [runtime_gid]}
    if runtime_uid != os.getuid() or runtime_gid != os.getgid():
        raise PermanentError("a non-root controller cannot change the runtime identity")
    return {}


def remap_child_exit(status: int) -> int:
    if status < 0:
        return ADAPTER_RESTART_EXIT
    if status in RESERVED_SUPERVISOR_EXITS:
        return ADAPTER_RESTART_EXIT
    return status


def phase_gate(phase: str, should_stop: Callable[[], bool]) -> None:
    # Test-only, env-gated, bounded barrier used to exercise "stop during phase X".
    # Production never sets CAUCE_CONTAINER_TEST_PHASE_GATE, so this is a no-op there.
    spec = os.environ.get("CAUCE_CONTAINER_TEST_PHASE_GATE")
    if not spec:
        return
    parts = spec.split("|")
    if len(parts) != 3 or parts[0] != phase:
        return
    marker, seconds = parts[1], parts[2]
    try:
        limit = float(seconds)
    except ValueError:
        return
    try:
        with open(marker, "w", encoding="utf-8") as stream:
            stream.write(f"{phase}:{os.getpid()}\n")
    except OSError:
        return
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if should_stop():
            return
        time.sleep(0.02)


def startup_metadata(control_fd: int, alias: str, state_directory: str, container_id: str, generation: str) -> None:
    document, _ = read_metadata(control_fd)
    if document is None:
        return
    if document["alias"] != alias or document["stateDirectory"] != state_directory:
        raise PermanentError("lifecycle metadata alias/state mismatch was preserved")
    if stale_generation_is_quiescent(
        control_fd,
        document,
        alias,
        state_directory,
        container_id,
        generation,
        probe_lock=False,
    ):
        remove_metadata(control_fd)
        return
    if document["phase"] == "running":
        if pid_exists(document["pid"]):
            try:
                verify_adapter(document, alias, state_directory)
            except (PermanentError, ProcessLookupError) as error:
                raise PermanentError("live PID metadata mismatch was preserved") from error
            raise PermanentError("an adapter process is already live for this alias")
        if document["containerId"] == container_id and document["containerGeneration"] == generation:
            raise PermanentError("missing PID belongs to the current generation; metadata was preserved")
        remove_metadata(control_fd)
        return
    # starting phase left behind by a prior controller
    if controller_is_live(document):
        raise PermanentError("another lifecycle controller is already starting for this alias")
    if alias_generation_pids(alias, generation, state_directory, exclude={os.getpid()}):
        raise PermanentError("a prior start for the current generation left live processes; metadata was preserved")
    if document["containerId"] == container_id and document["containerGeneration"] == generation:
        raise PermanentError("a prior controller for the current generation vanished mid-start; metadata was preserved")
    remove_metadata(control_fd)


def run_adapter(args: argparse.Namespace) -> int:
    if not args.command:
        raise PermanentError("adapter command is required")
    launch_credentials = child_credentials(args.runtime_uid, args.runtime_gid)
    set_dumpable()
    control_fd = open_control_directory(args.control_dir)
    lock_fd = lock_control(control_fd)
    state_fd = open_directory(args.state)
    process: subprocess.Popen[bytes] | None = None
    process_tree: PinnedLeaderTree | None = None
    running_document: dict[str, Any] | None = None
    published_starting = False
    termination_requested = False

    def should_stop() -> bool:
        return termination_requested

    def forward(_signum: int, _frame: Any) -> None:
        nonlocal termination_requested
        termination_requested = True
        if process_tree is not None:
            process_tree.signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    signal.signal(signal.SIGHUP, forward)
    try:
        startup_metadata(control_fd, args.alias, args.state, args.container_id, args.generation)
        # Phase "pre-metadata": we own the lock but have not published yet. A
        # concurrent stop must detect us (held lock / env identity) and refuse,
        # never fail-open.
        phase_gate("pre-metadata", should_stop)
        if termination_requested:
            raise PermanentError("adapter launch was cancelled before metadata publication")
        controller_starttime = int(proc_stat(os.getpid())["starttime"])
        base_document = {
            "schemaVersion": SCHEMA_VERSION,
            "phase": "starting",
            "alias": args.alias,
            "stateDirectory": args.state,
            "controlDirectory": args.control_dir,
            "runtimeUid": args.runtime_uid,
            "runtimeGid": args.runtime_gid,
            "pid": None,
            "pgid": None,
            "sid": None,
            "starttime": None,
            "controllerPid": os.getpid(),
            "controllerStarttime": controller_starttime,
            "containerId": args.container_id,
            "containerGeneration": args.generation,
            "bundleDigest": args.bundle_digest,
            "executable": starting_executable_identity(args.command[0]),
        }
        # Publish the starting phase atomically the instant we own the control plane,
        # before any long operation. A concurrent stop can now identify us in any phase.
        validate_metadata(base_document)
        atomic_metadata(control_fd, base_document)
        published_starting = True

        # Phase "starting": starting metadata is on disk, no child yet.
        phase_gate("starting", should_stop)
        if termination_requested:
            remove_metadata(control_fd)
            raise PermanentError("adapter launch was cancelled before process creation")

        if bundle_digest(args.bundle) != args.bundle_digest:
            remove_metadata(control_fd)
            raise PermanentError("active bundle digest differs before adapter launch")
        set_subreaper()

        # Phase "pre-child": about to fork the adapter.
        phase_gate("pre-child", should_stop)
        if termination_requested:
            remove_metadata(control_fd)
            raise PermanentError("adapter launch was cancelled before process creation")

        process = subprocess.Popen(args.command, start_new_session=True, close_fds=True, **launch_credentials)
        try:
            # Pin before any phase wait, exec inspection or process.wait()/poll()
            # can observe and reap the leader.
            process_tree = PinnedLeaderTree(process.pid)
        except BaseException:
            # The direct Popen child has not been reaped, so its numeric PID cannot
            # yet be reused. Refuse lifecycle startup after best-effort leader cleanup.
            process.terminate()
            try:
                process.wait(timeout=max(1.0, args.kill_seconds))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=max(1.0, args.kill_seconds))
            raise
        try:
            # Phase "post-child": the child exists but metadata is still "starting".
            phase_gate("post-child", should_stop)
            if termination_requested:
                signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=False)
                wait_process_tracking(process, process_tree, timeout=max(1.0, args.kill_seconds))
                raise PermanentError("adapter launch was cancelled before metadata publication")
            executable = wait_for_exec(process_tree, args.command[0])
            details = proc_stat(process.pid)
            if details["pgid"] != process.pid or details["sid"] != process.pid:
                raise PermanentError("adapter did not start in a dedicated process session")
            running_document = dict(base_document)
            running_document.update({
                "phase": "running",
                "pid": process.pid,
                "pgid": process.pid,
                "sid": process.pid,
                "starttime": int(details["starttime"]),
                "executable": executable,
            })
            validate_metadata(running_document)
            verify_adapter(running_document, args.alias, args.state)
            atomic_metadata(control_fd, running_document)
        except AdapterExitedBeforeIdentity:
            # Popen returned only after the requested executable was launched,
            # so a child exit here is an adapter outcome, not proof of invalid
            # identity. Preserve its real status (remapping reserved supervisor
            # codes) and tear down only descendants pinned while the leader lived.
            status = wait_process_tracking(process, process_tree, timeout=max(1.0, args.kill_seconds))
            signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=True)
            remove_metadata(control_fd)
            return remap_child_exit(status)
        except BaseException:
            signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=False)
            try:
                wait_process_tracking(process, process_tree, timeout=max(1.0, args.kill_seconds))
            except subprocess.TimeoutExpired:
                pass
            remove_metadata(control_fd)
            raise

        status = wait_process_tracking(process, process_tree)
        signal_known_tree(process_tree, args.term_seconds, args.kill_seconds, can_reap=True)
        current, _ = read_metadata(control_fd)
        if current is not None and current != running_document:
            raise PermanentError("lifecycle metadata changed while adapter was running; it was preserved")
        remove_metadata(control_fd)
        return remap_child_exit(status)
    except BaseException:
        if published_starting and process is None:
            remove_metadata(control_fd)
        raise
    finally:
        if process_tree is not None:
            process_tree.close()
        os.close(lock_fd)
        os.close(state_fd)
        os.close(control_fd)


def stop_adapter(args: argparse.Namespace) -> None:
    try:
        control_fd = open_control_directory(args.control_dir)
    except DirectoryAccessError:
        # Inaccessibility cannot be treated as absence: neither metadata nor a
        # held lock can be inspected, so stopped state is not provable.
        raise
    except PermanentError:
        # No usable control directory for this generation. Prove nothing survives.
        if alias_generation_pids(args.alias, args.generation, args.state, exclude={os.getpid()}):
            raise PermanentError("untracked processes still carry this alias generation; nothing was signalled")
        return
    try:
        document, _ = read_metadata(control_fd)
        if document is None:
            # Fail-closed: a held lock (controller mid-startup pre-publication) or any
            # surviving alias+generation process is ambiguous and must not report stopped.
            if lock_is_held(control_fd):
                raise PermanentError("a lifecycle controller holds the lock without published metadata; preserved")
            if alias_generation_pids(args.alias, args.generation, args.state, exclude={os.getpid()}):
                raise PermanentError("untracked processes still carry this alias generation; nothing was signalled")
            return
        if stale_generation_is_quiescent(
            control_fd,
            document,
            args.alias,
            args.state,
            args.container_id,
            args.generation,
            probe_lock=True,
        ):
            # Pre-start stop deliberately leaves stale metadata in place.  The
            # subsequent run command owns the lifecycle lock and removes it
            # durably before publishing the replacement generation.
            return
        require_current_generation(document, args.container_id, args.generation)
        if document["phase"] == "running":
            terminate_from_metadata(
                document, args.alias, args.state, args.term_seconds, args.kill_seconds,
            )
        else:
            # No adapter leader identity exists yet. Controller PID/starttime is
            # lifecycle metadata, not authority to signal an unregistered target.
            raise PermanentError("adapter leader is not published; metadata was preserved and no signal was sent")
        remove_metadata(control_fd)
    finally:
        os.close(control_fd)


def check_adapter(args: argparse.Namespace) -> None:
    control_fd = open_control_directory(args.control_dir)
    try:
        document, _ = read_metadata(control_fd)
        if document is None:
            raise PermanentError("adapter lifecycle metadata is absent")
        require_current_generation(document, args.container_id, args.generation)
        if document["phase"] != "running":
            raise PermanentError("adapter is still starting; running state is not proven")
        if document["bundleDigest"] != args.bundle_digest:
            raise PermanentError("active bundle digest differs from lifecycle metadata")
        verify_adapter(document, args.alias, args.state)
        verify_controller(document)
        if document["pid"] not in descendants(document["controllerPid"]):
            raise PermanentError("adapter leader is not a descendant of its lifecycle controller")
        if bundle_digest(args.bundle) != args.bundle_digest:
            raise PermanentError("active bundle content digest differs")
        print(f"adapter {args.alias} is running")
    finally:
        os.close(control_fd)


def assert_stopped(args: argparse.Namespace) -> None:
    try:
        control_fd = open_control_directory(args.control_dir)
    except DirectoryAccessError:
        raise
    except PermanentError:
        control_fd = None
    try:
        if control_fd is not None:
            document, _ = read_metadata(control_fd)
            if document is not None:
                if not stale_generation_is_quiescent(
                    control_fd,
                    document,
                    args.alias,
                    args.state,
                    args.container_id,
                    args.generation,
                    probe_lock=True,
                ):
                    require_current_generation(document, args.container_id, args.generation)
                    if document["phase"] == "running" and pid_exists(document["pid"]):
                        raise PermanentError("adapter lifecycle metadata still identifies a live PID")
                    if controller_is_live(document):
                        raise PermanentError("a lifecycle controller is still starting for this alias")
                    raise PermanentError("adapter lifecycle metadata remains; stopped state is not proven")
            if lock_is_held(control_fd):
                raise PermanentError("a lifecycle controller holds the lock; stopped state is not proven")
        stragglers = alias_generation_pids(args.alias, args.generation, args.state, exclude={os.getpid()})
        if stragglers:
            raise PermanentError("an untracked adapter process still has this alias identity")
        print(f"adapter {args.alias} is stopped")
    finally:
        if control_fd is not None:
            os.close(control_fd)


def common_lifecycle(parser: argparse.ArgumentParser, *, require_bundle: bool) -> None:
    parser.add_argument("--alias", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--control-dir", required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--generation", required=True)
    if require_bundle:
        parser.add_argument("--bundle", required=True)
        parser.add_argument("--bundle-digest", required=True)
    parser.add_argument("--term-seconds", type=float, default=25.0)
    parser.add_argument("--kill-seconds", type=float, default=5.0)


parser = argparse.ArgumentParser(description="Fail-closed Cauce container lifecycle helper")
subparsers = parser.add_subparsers(dest="action", required=True)
prepare = subparsers.add_parser("prepare-state")
prepare.add_argument("--mount", required=True)
prepare.add_argument("--state", required=True)
prepare.add_argument("--uid", type=int, required=True)
prepare.add_argument("--gid", type=int, required=True)
prepare_control_parser = subparsers.add_parser("prepare-control")
prepare_control_parser.add_argument("--base", required=True)
prepare_control_parser.add_argument("--alias", required=True)
digest_parser = subparsers.add_parser("bundle-digest")
digest_parser.add_argument("path")
guard_parser = subparsers.add_parser("guard-exec")
guard_parser.add_argument("--init-starttime", type=int, required=True)
guard_parser.add_argument("command", nargs=argparse.REMAINDER)
run_parser = subparsers.add_parser("run")
common_lifecycle(run_parser, require_bundle=True)
run_parser.add_argument("--runtime-uid", type=int, required=True)
run_parser.add_argument("--runtime-gid", type=int, required=True)
run_parser.add_argument("command", nargs=argparse.REMAINDER)
stop_parser = subparsers.add_parser("stop")
common_lifecycle(stop_parser, require_bundle=False)
check_parser = subparsers.add_parser("check")
common_lifecycle(check_parser, require_bundle=True)
stopped_parser = subparsers.add_parser("stopped")
common_lifecycle(stopped_parser, require_bundle=False)
arguments = parser.parse_args()


def _validate_identity(namespace: argparse.Namespace, *, require_bundle: bool) -> None:
    if not ALIAS_RE.fullmatch(namespace.alias) or not CONTAINER_ID_RE.fullmatch(namespace.container_id) \
            or not GENERATION_RE.fullmatch(namespace.generation):
        raise PermanentError("lifecycle identity arguments are invalid")
    canonical_absolute(namespace.control_dir, "control directory")
    canonical_absolute(namespace.state, "state directory")
    if require_bundle and not DIGEST_RE.fullmatch(namespace.bundle_digest):
        raise PermanentError("lifecycle identity arguments are invalid")


try:
    if arguments.action == "prepare-state":
        prepare_state(arguments.mount, arguments.state, arguments.uid, arguments.gid)
    elif arguments.action == "prepare-control":
        prepare_control(arguments.base, arguments.alias)
    elif arguments.action == "bundle-digest":
        print(bundle_digest(arguments.path))
    elif arguments.action == "guard-exec":
        guard_exec(arguments.init_starttime, arguments.command)
    elif arguments.action == "run":
        _validate_identity(arguments, require_bundle=True)
        raise SystemExit(run_adapter(arguments))
    elif arguments.action == "stop":
        _validate_identity(arguments, require_bundle=False)
        stop_adapter(arguments)
    elif arguments.action == "check":
        _validate_identity(arguments, require_bundle=True)
        check_adapter(arguments)
    elif arguments.action == "stopped":
        _validate_identity(arguments, require_bundle=False)
        assert_stopped(arguments)
except PermanentError as error:
    fail(str(error), PERMANENT_EXIT)
