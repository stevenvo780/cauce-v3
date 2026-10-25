from __future__ import annotations

import fcntl
import json
import os
import re
import signal
import stat

from cauce_container_base import ALIAS_RE, WIRE_ALIAS_RE, PermanentError, canonical_absolute, open_directory
from cauce_container_proc import matched_fs_credentials, selected_environment

MAX_LEASE_BYTES = 1024
INSTANCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,127}")


def assert_alias_quiescent(runtime_alias: str, wire_alias: str, state_directory: str) -> None:
    for name in os.listdir("/proc"):
        if not name.isdigit() or (pid := int(name)) == os.getpid():
            continue
        try:
            environment = selected_environment(pid)
        except ProcessLookupError:
            continue
        except (OSError, UnicodeError, ValueError, PermanentError) as error:
            raise PermanentError("consumer lease process absence could not be verified") from error
        if environment.get("CAUCE_STATE_DIR") == state_directory \
                and (environment.get("CAUCE_RUNTIME_KEY") == runtime_alias or environment.get("CAUCE_ALIAS") == wire_alias):
            raise PermanentError("a residual process still carries this consumer alias and state")


def legacy_document(raw: bytes) -> None:
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        document = dict(pairs)
        if len(document) != len(pairs):
            raise ValueError("duplicate fields")
        return document

    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeError, ValueError) as error:
        raise PermanentError("consumer lease legacy record is unknown") from error
    if not isinstance(document, dict) or set(document) != {"pid", "instance_id"} \
            or type(document["pid"]) is not int or not 0 < document["pid"] <= 9_007_199_254_740_991 \
            or not isinstance(document["instance_id"], str) or INSTANCE_RE.fullmatch(document["instance_id"]) is None:
        raise PermanentError("consumer lease legacy record is unknown")


def lease_identity(details: os.stat_result, uid: int, gid: int) -> tuple[int, ...]:
    if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o600 \
            or details.st_uid != uid or details.st_gid != gid or details.st_nlink != 1 \
            or not 0 < details.st_size <= MAX_LEASE_BYTES:
        raise PermanentError("consumer lease file is unsafe")
    return (details.st_dev, details.st_ino, details.st_mode, details.st_uid, details.st_gid,
            details.st_nlink, details.st_size, details.st_mtime_ns, details.st_ctime_ns)


def retire_consumer_lease(state_fd: int, state_directory: str, runtime_alias: str, wire_alias: str,
                          runtime_uid: int, runtime_gid: int) -> bool:
    if not isinstance(runtime_alias, str) or ALIAS_RE.fullmatch(runtime_alias) is None \
            or not isinstance(wire_alias, str) or WIRE_ALIAS_RE.fullmatch(wire_alias) is None \
            or type(runtime_uid) is not int or type(runtime_gid) is not int or runtime_uid <= 0 or runtime_gid <= 0:
        raise PermanentError("consumer lease retirement identity is invalid")
    canonical_absolute(state_directory, "consumer state directory")
    name = f".consumer-{wire_alias}.lock"
    lease_fd: int | None = None
    leased = False
    broken = False

    def lease_break(_signum: int, _frame: object) -> None:
        nonlocal broken
        broken = True

    try:
        with matched_fs_credentials(runtime_uid, runtime_gid):
            try:
                lease_fd = os.open(name, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=state_fd)
            except FileNotFoundError:
                return False
        original = lease_identity(os.fstat(lease_fd), runtime_uid, runtime_gid)
        raw = os.pread(lease_fd, MAX_LEASE_BYTES + 1, 0)
        if len(raw) != original[6]:
            raise PermanentError("consumer lease changed while it was inspected")
        legacy_document(raw)
        assert_alias_quiescent(runtime_alias, wire_alias, state_directory)
        previous_handler = signal.signal(signal.SIGIO, lease_break)
        try:
            with matched_fs_credentials(runtime_uid, runtime_gid):
                fcntl.fcntl(lease_fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
                leased = True
            assert_alias_quiescent(runtime_alias, wire_alias, state_directory)
            current_directory = open_directory(state_directory)
            try:
                current = os.fstat(current_directory)
                original_directory = os.fstat(state_fd)
                if (current.st_dev, current.st_ino) != (original_directory.st_dev, original_directory.st_ino):
                    raise PermanentError("consumer state directory changed before retirement")
            finally:
                os.close(current_directory)
            os.fsync(state_fd)
            if lease_identity(os.fstat(lease_fd), runtime_uid, runtime_gid) != original \
                    or lease_identity(os.stat(name, dir_fd=state_fd, follow_symlinks=False), runtime_uid, runtime_gid) != original \
                    or os.pread(lease_fd, MAX_LEASE_BYTES + 1, 0) != raw \
                    or broken or fcntl.fcntl(lease_fd, fcntl.F_GETLEASE) != fcntl.F_WRLCK:
                raise PermanentError("consumer lease changed before retirement")
            os.unlink(name, dir_fd=state_fd)
            os.fsync(state_fd)
            return True
        finally:
            try:
                if leased:
                    with matched_fs_credentials(runtime_uid, runtime_gid):
                        fcntl.fcntl(lease_fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            finally:
                signal.signal(signal.SIGIO, previous_handler)
    except (OSError, ValueError) as error:
        raise PermanentError("consumer lease exclusive retirement could not be verified") from error
    finally:
        if lease_fd is not None:
            os.close(lease_fd)
