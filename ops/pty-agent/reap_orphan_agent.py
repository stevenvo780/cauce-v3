#!/usr/bin/env python3
from __future__ import annotations

import errno
import os
import signal
import sys
import time
from typing import Final

TERM_TIMEOUT_SECONDS: Final = 2.0
KILL_TIMEOUT_SECONDS: Final = 2.0
POLL_SECONDS: Final = 0.05
Identity = tuple[int, int, tuple[bytes, ...]]


class ReapError(RuntimeError):
    pass


def expected_cmdlines(bundle_path: str, alias_name: str) -> frozenset[tuple[bytes, ...]]:
    bundle = os.fsencode(bundle_path)
    return frozenset((
        (b"/usr/bin/python3", b"-m", b"cauce_pty_agent", b"--bundle", bundle),
        (
            b"/usr/bin/python3",
            os.fsencode(f"/var/tmp/cauce-pty-agent-{alias_name}.py"),
            b"--bundle",
            bundle,
        ),
    ))


def check_capabilities() -> None:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ReapError("pidfd signalling is unavailable")
    try:
        pid_fd = os.pidfd_open(os.getpid(), 0)
    except (AttributeError, OSError) as error:
        raise ReapError(f"cannot open a pidfd: {error}") from error
    try:
        signal.pidfd_send_signal(pid_fd, 0)
    except (AttributeError, OSError) as error:
        raise ReapError(f"cannot probe pidfd signalling: {error}") from error
    finally:
        os.close(pid_fd)


def parse_cmdline(raw: bytes) -> tuple[bytes, ...]:
    arguments = raw.split(b"\0")
    if arguments and arguments[-1] == b"":
        arguments.pop()
    return tuple(arguments)


def read_identity(pid: int, *, strict: bool = False) -> Identity | None:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as stream:
            cmdline = parse_cmdline(stream.read())
        with open(f"/proc/{pid}/stat", encoding="utf-8") as stream:
            raw_stat = stream.read()
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        if strict:
            raise ReapError(f"cannot revalidate PID {pid}: {error}") from error
        return None
    closing = raw_stat.rfind(")")
    fields = raw_stat[closing + 2 :].split() if closing >= 0 else []
    if len(fields) <= 19:
        if strict:
            raise ReapError(f"cannot parse identity for PID {pid}")
        return None
    try:
        starttime = int(fields[19])
    except ValueError as error:
        if strict:
            raise ReapError(f"invalid starttime for PID {pid}") from error
        return None
    return pid, starttime, cmdline


def read_process_uid(pid: int) -> int | None:
    try:
        return os.stat(f"/proc/{pid}").st_uid
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise ReapError(f"cannot identify owner of PID {pid}: {error}") from error


def discover(bundle_path: str, alias_name: str) -> list[Identity]:
    expected = expected_cmdlines(bundle_path, alias_name)
    try:
        entries = os.listdir("/proc")
    except OSError as error:
        raise ReapError(f"cannot enumerate container processes: {error}") from error
    identities: list[Identity] = []
    runtime_uid = os.geteuid()
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        owner_uid = read_process_uid(pid)
        if owner_uid is None:
            continue
        # Every supported launcher runs the agent as this effective UID. An unreadable process
        # owned by it could be the orphan, so observation errors must stop the replacement.
        identity = read_identity(pid, strict=owner_uid == runtime_uid)
        if identity is not None and identity[2] in expected:
            identities.append(identity)
    return sorted(identities)


def send_pinned(pid_fd: int, process_signal: signal.Signals, pid: int) -> bool:
    try:
        signal.pidfd_send_signal(pid_fd, process_signal)
    except ProcessLookupError:
        return False
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        raise ReapError(f"cannot signal pinned PID {pid}: {error}") from error
    return True


def wait_identity_gone(identity: Identity, timeout_seconds: float) -> bool:
    pid = identity[0]
    deadline = time.monotonic() + timeout_seconds
    while True:
        current = read_identity(pid, strict=True)
        if current is None or current != identity:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(POLL_SECONDS, remaining))


def reap_candidate(identity: Identity) -> None:
    pid = identity[0]
    try:
        pid_fd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return
    except (AttributeError, OSError) as error:
        raise ReapError(f"cannot pin PID {pid}: {error}") from error
    try:
        if read_identity(pid, strict=True) != identity:
            return
        if not send_pinned(pid_fd, signal.SIGTERM, pid):
            return
        if wait_identity_gone(identity, TERM_TIMEOUT_SECONDS):
            return
        if read_identity(pid, strict=True) != identity:
            return
        if not send_pinned(pid_fd, signal.SIGKILL, pid):
            return
        if not wait_identity_gone(identity, KILL_TIMEOUT_SECONDS):
            raise ReapError(f"pinned PID {pid} survived SIGKILL")
    finally:
        os.close(pid_fd)


def reap(bundle_path: str, alias_name: str) -> None:
    check_capabilities()
    identities = discover(bundle_path, alias_name)
    if not identities:
        return
    pids = " ".join(str(identity[0]) for identity in identities)
    print(
        f"cauce-pty-launcher: reaping orphan agents alias={alias_name} pids={pids}",
        file=sys.stderr,
        flush=True,
    )
    for identity in identities:
        reap_candidate(identity)
    remaining = discover(bundle_path, alias_name)
    if remaining:
        pids = " ".join(str(identity[0]) for identity in remaining)
        raise ReapError(f"matching PTY agents remain after reap: {pids}")


def main() -> int:
    if sys.argv[1:] == ["--check-capabilities"]:
        try:
            check_capabilities()
        except ReapError as error:
            print(f"cauce-pty-reaper: unavailable capability: {error}", file=sys.stderr)
            return 78
        return 0
    if len(sys.argv) != 3:
        print(
            "usage: reap_orphan_agent.py [--check-capabilities | BUNDLE_PATH ALIAS]",
            file=sys.stderr,
        )
        return 2
    try:
        reap(sys.argv[1], sys.argv[2])
    except ReapError as error:
        print(f"cauce-pty-launcher: unsafe orphan state: {error}", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
