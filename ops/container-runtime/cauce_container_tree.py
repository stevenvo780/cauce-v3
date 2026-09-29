from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import Any

from cauce_container_base import AdapterExitedBeforeIdentity, PermanentError
from cauce_container_proc import (
    alias_generation_pids,
    descendants,
    executable_identity,
    group_members,
    open_pidfd,
    pidfd_matches_starttime,
    pidfd_running,
    pin_verified_adapter,
    pin_verified_controller,
    proc_stat,
    reap_children,
    signal_pidfd,
)


def wait_for_exec(tree: PinnedLeaderTree, requested_path: str, timeout: float = 3.0) -> dict[str, Any]:
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
