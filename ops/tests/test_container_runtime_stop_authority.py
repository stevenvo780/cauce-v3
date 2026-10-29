from __future__ import annotations

import ctypes
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from contextlib import ExitStack, contextmanager
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "container-runtime"))
import cauce_container_tree as TREE
from cauce_container_adoption import mutation_guard
from cauce_container_base import STOP_AUTHORITY, PermanentError
from cauce_container_proc import validate_metadata


@contextmanager
def external_stop(*, legacy: bool = False):
    events = []
    document = {"phase": "running", "pid": 11, "starttime": 21, "controllerPid": 12,
                "controllerStarttime": 22, "containerGeneration": "a" * 64}
    if not legacy:
        document["stopAuthority"] = STOP_AUTHORITY
    guard = mock.Mock(side_effect=lambda _document: events.append("guard"))
    cas = mock.Mock(side_effect=lambda: events.append("cas"))
    running = {31: True, 32: True}
    active = False

    @contextmanager
    def fence(candidate):
        nonlocal active
        guard(candidate)
        active = True
        try:
            yield
        finally:
            active = False
            events.append("release")

    def record_signal(fd, process_signal):
        if not active:
            raise AssertionError("signal outside the input fence")
        events.append((fd, process_signal))
        running[fd] = False
        if fd == 31 and not legacy:
            running[32] = False

    def is_running(fd):
        if any(isinstance(event, tuple) for event in events) and not active:
            raise AssertionError("process wait outside the input fence")
        return running[fd]

    with ExitStack() as stack:
        stack.enter_context(mock.patch.dict(sys.modules, {
            "cauce_container_restart": types.SimpleNamespace(restart_fence=fence),
        }))
        node = stack.enter_context(mock.patch.object(TREE, "pin_verified_adapter", return_value=31))
        controller = stack.enter_context(mock.patch.object(TREE, "pin_verified_controller", return_value=32))
        stack.enter_context(mock.patch.object(TREE, "alias_generation_pids", return_value=[11, 12]))
        stack.enter_context(mock.patch.object(TREE, "pidfd_matches_starttime", return_value=True))
        stack.enter_context(mock.patch.object(TREE, "pidfd_running", side_effect=is_running))
        stack.enter_context(mock.patch.object(TREE, "stop_signal_gate"))
        stack.enter_context(mock.patch.object(TREE.os, "close"))
        signals = stack.enter_context(mock.patch.object(TREE, "signal_pidfd", side_effect=record_signal))
        yield document, node, controller, guard, cas, signals, events


class StopAuthorityTests(unittest.TestCase):
    def terminate(self, document, cas):
        TREE.terminate_from_metadata(document, "owned", "/owned/state", 0.1, 0.1, before_signal=cas,
                                     claim_lifecycle_lock=lambda: None)

    def test_new_controller_receives_no_signal(self):
        with external_stop() as (document, node, _controller, guard, cas, signals, events):
            self.terminate(document, cas)
            node.assert_called_once_with(document, "owned", "/owned/state", allow_reexec=True)
            guard.assert_called_once_with(document)
            signals.assert_called_once_with(31, signal.SIGTERM)
            self.assertEqual(events, ["guard", "cas", (31, signal.SIGTERM), "release"])

    def controller_lingering(self, events, seconds):
        signalled = {}

        def running(fd):
            if not any(isinstance(event, tuple) for event in events):
                return True
            if fd == 31:
                return False
            start = signalled.setdefault("at", time.monotonic())
            return time.monotonic() - start < seconds
        return mock.patch.object(TREE, "pidfd_running", side_effect=running)

    def test_new_controller_gets_the_time_to_reap_descendants_the_leader_left_behind(self):
        with external_stop() as (document, _node, _controller, _guard, cas, _signals, events):
            # Longer than kill_seconds (0.1), within the controller's own SIGTERM + SIGKILL cleanup.
            with self.controller_lingering(events, 0.3):
                self.terminate(document, cas)
            self.assertEqual(events, ["guard", "cas", (31, signal.SIGTERM), "release"])

    def test_new_controller_that_never_exits_still_fails_bounded(self):
        with external_stop() as (document, _node, _controller, _guard, cas, _signals, events):
            with self.controller_lingering(events, 60), self.assertRaisesRegex(PermanentError, "did not exit"):
                self.terminate(document, cas)

    def test_legacy_controller_is_killed_before_adapter_term(self):
        with external_stop(legacy=True) as (document, node, _controller, _guard, cas, _signals, events):
            self.terminate(document, cas)
            node.assert_called_once_with(document, "owned", "/owned/state", allow_reexec=False)
            self.assertEqual(events, ["guard", "cas", (32, signal.SIGKILL), "cas", (31, signal.SIGTERM), "release"])

    def test_legacy_unverified_controller_is_preserved(self):
        with external_stop(legacy=True) as (document, _node, controller, _guard, cas, signals, _events):
            controller.side_effect = PermanentError("identity mismatch")
            with self.assertRaisesRegex(PermanentError, "RESTART_HOLD_LEGACY_CONTROLLER_UNVERIFIED"):
                self.terminate(document, cas)
            signals.assert_not_called()

    def test_legacy_dead_controller_is_not_treated_as_a_safe_new_controller(self):
        with external_stop(legacy=True) as (document, _node, controller, _guard, cas, signals, _events):
            controller.side_effect = ProcessLookupError(document["controllerPid"])
            with self.assertRaisesRegex(PermanentError, "RESTART_HOLD_LEGACY_CONTROLLER_UNVERIFIED"):
                self.terminate(document, cas)
            signals.assert_not_called()

    def test_legacy_reexec_mismatch_is_not_signal_authority(self):
        with external_stop(legacy=True) as (document, node, controller, _guard, cas, signals, _events):
            node.side_effect = PermanentError("executable identity mismatch")
            with self.assertRaisesRegex(PermanentError, "executable identity mismatch"):
                self.terminate(document, cas)
            controller.assert_not_called()
            signals.assert_not_called()

    def test_unknown_stop_authority_never_reaches_process_pinning(self):
        with external_stop() as (document, node, controller, _guard, cas, signals, _events):
            document["stopAuthority"] = "unknown"
            with self.assertRaisesRegex(PermanentError, "RESTART_HOLD_STOP_AUTHORITY_UNKNOWN"):
                self.terminate(document, cas)
            node.assert_not_called()
            controller.assert_not_called()
            signals.assert_not_called()

    def test_stop_authority_is_optional_only_for_legacy_and_strict_when_present(self):
        document = {"schemaVersion": 2, "phase": "starting", "alias": "owned", "stateDirectory": "/owned/state",
            "controlDirectory": "/owned/control", "runtimeUid": 1000, "runtimeGid": 1000,
            "pid": None, "pgid": None, "sid": None, "starttime": None, "controllerPid": 11, "controllerStarttime": 12,
            "containerId": "a" * 64, "containerGeneration": "b" * 64, "bundleDigest": "sha256:" + "c" * 64,
            "executable": {"path": "/owned/adapter", "sha256": "sha256:" + "d" * 64, "device": 1, "inode": 2,
                "procPath": None, "procDevice": None, "procInode": None, "cmdlineSha256": None}}
        for identity in ({}, {"wireAlias": "wire_alias", "tenantId": "Owned"}):
            for authority in ({}, {"stopAuthority": STOP_AUTHORITY}):
                candidate = dict(document, **identity, **authority)
                self.assertEqual(validate_metadata(candidate), candidate)
        for authority in (None, False, "", "unknown"):
            with self.subTest(authority=authority), self.assertRaises(PermanentError):
                validate_metadata(dict(document, stopAuthority=authority))
        with self.assertRaises(PermanentError):
            validate_metadata(dict(document, stopAuthority=STOP_AUTHORITY, unknown=True))

    def test_guard_hold_preserves_both_processes(self):
        with external_stop(legacy=True) as (document, _node, _controller, guard, cas, signals, _events):
            guard.side_effect = PermanentError("RESTART_HOLD_DRAFT")
            with self.assertRaisesRegex(PermanentError, "RESTART_HOLD_DRAFT"):
                self.terminate(document, cas)
            signals.assert_not_called()
            cas.assert_not_called()

    def test_fence_restore_failure_after_node_signal_is_partial(self):
        with external_stop() as (document, _node, _controller, _guard, cas, signals, _events):
            module = sys.modules['cauce_container_restart']
            original = module.restart_fence

            @contextmanager
            def failed_restore(candidate):
                with original(candidate):
                    yield
                raise PermanentError('RESTART_PARTIAL_INPUT_RESTORE_UNKNOWN')

            module.restart_fence = failed_restore
            with self.assertRaisesRegex(PermanentError, 'RESTART_PARTIAL_ADAPTER_TEARDOWN'):
                self.terminate(document, cas)
            signals.assert_called_once_with(31, signal.SIGTERM)

    def test_metadata_drift_before_bridge_preserves_both_processes(self):
        with external_stop(legacy=True) as (document, _node, _controller, _guard, cas, signals, _events):
            cas.side_effect = PermanentError("metadata changed")
            with self.assertRaisesRegex(PermanentError, "metadata changed"):
                self.terminate(document, cas)
            signals.assert_not_called()

    def test_bridge_failure_after_controller_stop_is_explicitly_partial(self):
        with external_stop(legacy=True) as (document, _node, _controller, _guard, cas, signals, _events):
            cas.side_effect = [None, PermanentError("metadata changed")]
            with self.assertRaisesRegex(PermanentError, "RESTART_PARTIAL_LEGACY_CONTROLLER_STOPPED_METADATA_PRESERVED"):
                self.terminate(document, cas)
            signals.assert_called_once_with(32, signal.SIGKILL)

    def test_legacy_node_is_not_signalled_before_lifecycle_lock_is_claimed(self):
        with external_stop(legacy=True) as (document, _node, _controller, _guard, cas, _signals, events):
            TREE.terminate_from_metadata(document, "owned", "/owned/state", 0.1, 0.1, before_signal=cas,
                                         claim_lifecycle_lock=lambda: events.append("lock"))
            self.assertEqual(events, ["guard", "cas", (32, signal.SIGKILL), "lock", "cas", (31, signal.SIGTERM), "release"])

    def test_retained_legacy_lock_is_partial_without_any_node_signal(self):
        with external_stop(legacy=True) as (document, _node, _controller, _guard, cas, signals, _events):
            claim = mock.Mock(side_effect=PermanentError("lifecycle lock retained"))
            with self.assertRaisesRegex(PermanentError, "RESTART_PARTIAL_LEGACY_CONTROLLER_STOPPED_METADATA_PRESERVED"):
                TREE.terminate_from_metadata(document, "owned", "/owned/state", 0.1, 0.1, before_signal=cas,
                                             claim_lifecycle_lock=claim)
            signals.assert_called_once_with(32, signal.SIGKILL)

    def test_exclusive_stop_fence_blocks_second_stop_startup_and_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            control = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            first = mutation_guard(control, exclusive=True)
            try:
                for exclusive in (False, True):
                    with self.assertRaises(PermanentError):
                        mutation_guard(control, exclusive=exclusive)
            finally:
                os.close(first)
            shared = mutation_guard(control)
            try:
                with self.assertRaises(PermanentError):
                    mutation_guard(control, exclusive=True)
            finally:
                os.close(shared)
                os.close(control)

    def test_direct_and_reparented_children_survive_leader_teardown(self):
        previous = ctypes.c_int()
        libc = ctypes.CDLL(None, use_errno=True)
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        process = None
        leader = None
        children = []
        try:
            with tempfile.TemporaryDirectory() as directory:
                marker = pathlib.Path(directory) / "owned-children.json"
                source = """import json,signal,subprocess,sys,time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
children = [subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], env={}, start_new_session=detached)
            for detached in (False, True)]
with open(sys.argv[1], 'w') as stream: json.dump([child.pid for child in children], stream)
time.sleep(60)
"""
                process = subprocess.Popen([sys.executable, "-c", source, str(marker)], start_new_session=True,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                children = json.loads(marker.read_text())
                leader = TREE.PinnedAdapterLeader(process.pid)
                self.assertEqual(set(leader.pinned), {process.pid})
                TREE.signal_known_tree(leader, 0.1, 1, can_reap=False)
                process.wait(timeout=5)
                for pid in children:
                    self.assertEqual(TREE.proc_stat(pid)["ppid"], os.getpid())
                    self.assertNotEqual(TREE.proc_stat(pid)["state"], "Z")
                self.assertEqual(leader.pinned, {})
        finally:
            if leader is not None:
                leader.close()
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for pid in children:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            libc.prctl(36, previous.value, 0, 0, 0)


if __name__ == "__main__":
    unittest.main()
