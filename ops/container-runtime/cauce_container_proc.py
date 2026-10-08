from __future__ import annotations

import ctypes
import errno
import fcntl
import json
import os
import re
import select
import signal
import stat
import time
from typing import Any

from cauce_container_base import (
    ALIAS_RE,
    CONTAINER_ID_RE,
    DIGEST_RE,
    EXECUTABLE_KEYS,
    GENERATION_RE,
    IDENTITY_ENV_KEYS,
    LOCK_EXIT,
    LOCK_NAME,
    METADATA_KEYS,
    METADATA_NAME,
    SCHEMA_VERSION,
    TENANT_RE,
    WIRE_ALIAS_RE,
    ExecutableIdentityMismatch,
    PermanentError,
    canonical_absolute,
    fail,
    file_sha256,
    framed_hash,
)


def proc_stat(pid: int) -> dict[str, int | str]:
    try:
        raw = open(f"/proc/{pid}/stat", encoding="utf-8").read()
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
        with open(f"/proc/{pid}/status", encoding="utf-8") as stream:
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

    def __enter__(self) -> matched_fs_credentials:
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
    except PermissionError:
        try:
            with open(f"/proc/self/fdinfo/{pid_fd}", encoding="utf-8") as s:
                tpid = next((int(w[1]) for line in s if (w := line.split()) and w[0] == "Pid:"), 0)
            if tpid > 1 and (fpid := os.fork()) == 0:
                uid = os.stat(f"/proc/{tpid}").st_uid
                os.setresuid(uid, uid, uid)
                signal.pidfd_send_signal(pid_fd, process_signal)
                os._exit(0)
            elif tpid > 1:
                os.waitpid(fpid, 0)
        except Exception:
            pass


def pidfd_matches_starttime(pid: int, pid_fd: int, starttime: int) -> bool:
    if not pidfd_running(pid_fd):
        return False
    try:
        return proc_stat(pid)["starttime"] == starttime
    except (ProcessLookupError, PermissionError, OSError, PermanentError):
        return False


def guard_exec(init_starttime: int, command: list[str]) -> None:
    if not command:
        raise PermanentError("guarded command is required")
    if proc_stat(1)["starttime"] != init_starttime:
        raise PermanentError("container init generation changed before guarded operation")
    os.execvp(command[0], command)


def group_members(pgid: int) -> list[int]:
    members: list[int] = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                if proc_stat(int(name))["pgid"] == pgid:
                    members.append(int(name))
            except (ProcessLookupError, PermissionError, ValueError):
                pass
    return sorted(members)


def descendants(root_pid: int) -> list[int]:
    parent_to_children: dict[int, list[int]] = {}
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                parent_to_children.setdefault(int(proc_stat(int(name))["ppid"]), []).append(int(name))
            except (ProcessLookupError, PermissionError, ValueError):
                pass
    found, pending = [], list(parent_to_children.get(root_pid, []))
    while pending:
        if (pid := pending.pop()) not in found:
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
        if b"=" in item:
            k, v = item.split(b"=", 1)
            dk = k.decode("utf-8", "strict")
            if dk in wanted:
                selected[dk] = v.decode("utf-8", "strict")
    return selected


def alias_generation_pids(alias: str, generation: str, state_directory: str, *, exclude: set[int] | None = None) -> list[int]:
    # Environment is forgeable by any same-UID process. Matches are therefore used
    # only to detect ambiguous/untracked processes and force exit 78; they are never
    # trusted to establish a positive identity or authorize execution.
    skip = exclude or set()
    matches: list[int] = []
    for name in os.listdir("/proc"):
        if name.isdigit() and (pid := int(name)) > 1 and pid not in skip:
            try:
                env = selected_environment(pid)
                if env.get("CAUCE_RUNTIME_KEY", env.get("CAUCE_ALIAS")) == alias \
                        and env.get("CAUCE_CONTAINER_GENERATION") == generation and env.get("CAUCE_STATE_DIR") == state_directory:
                    matches.append(pid)
            except (ProcessLookupError, PermissionError, UnicodeDecodeError, OSError):
                pass
    return sorted(matches)


def command_line_hash(pid: int) -> str:
    try:
        raw = open(f"/proc/{pid}/cmdline", "rb").read()
    except FileNotFoundError as error:
        raise ProcessLookupError(pid) from error
    return framed_hash([raw])


def requested_executable_identity(requested_path: str) -> dict[str, Any]:
    canonical = os.path.realpath(requested_path)
    requested = os.stat(canonical, follow_symlinks=False)
    if not stat.S_ISREG(requested.st_mode):
        raise PermanentError("adapter executable is not a regular file")
    return {
        "path": canonical,
        "sha256": file_sha256(canonical),
        "device": requested.st_dev,
        "inode": requested.st_ino,
    }


def executable_identity(pid: int, requested_path: str) -> dict[str, Any]:
    identity = requested_executable_identity(requested_path)
    target_uid, target_gid = process_credentials(pid)
    try:
        with matched_fs_credentials(target_uid, target_gid):
            proc_link = os.readlink(f"/proc/{pid}/exe")
            proc_details = os.stat(f"/proc/{pid}/exe")
    except FileNotFoundError as error:
        raise ProcessLookupError(pid) from error
    identity.update({"procPath": proc_link, "procDevice": proc_details.st_dev,
                     "procInode": proc_details.st_ino, "cmdlineSha256": command_line_hash(pid)})
    return identity


def starting_executable_identity(requested_path: str) -> dict[str, Any]:
    identity = requested_executable_identity(requested_path)
    identity.update({"procPath": None, "procDevice": None, "procInode": None, "cmdlineSha256": None})
    return identity


def metadata_hint(raw: bytes) -> int | None:
    match = re.search(rb'"pid"\s*:\s*([0-9]+)', raw)
    if not match:
        return None
    value = int(match.group(1))
    return value if value > 1 else None


def validate_metadata(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict) or set(document) not in (METADATA_KEYS, METADATA_KEYS | {"wireAlias", "tenantId"}):
        raise PermanentError("lifecycle metadata has unexpected or missing fields")
    if document["schemaVersion"] != SCHEMA_VERSION or document["phase"] not in {"starting", "running"} \
            or not isinstance(document["alias"], str) or not ALIAS_RE.fullmatch(document["alias"]):
        raise PermanentError("lifecycle metadata identity is invalid")
    if "wireAlias" in document and (not isinstance(document["wireAlias"], str)
            or not WIRE_ALIAS_RE.fullmatch(document["wireAlias"]) or not isinstance(document["tenantId"], str)
            or not TENANT_RE.fullmatch(document["tenantId"])):
        raise PermanentError("lifecycle metadata wire identity is invalid")
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
        "CAUCE_ALIAS": document.get("wireAlias", document["alias"]),
        **({"CAUCE_RUNTIME_KEY": document["alias"], "CAUCE_TENANT_ID": document["tenantId"]}
           if "wireAlias" in document else {}),
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


def set_subreaper() -> None:
    if _LIBC.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER) failed")


def set_dumpable() -> None:
    # Ensure the controller's own /proc is introspectable by the same-uid (root) check
    # and stop verifiers even where CAP_SYS_PTRACE is unavailable (Docker default, or a
    # setuid launcher such as sudo that clears the dumpable flag). Only root can read it.
    _LIBC.prctl(4, 1, 0, 0, 0)  # PR_SET_DUMPABLE=1
