from __future__ import annotations

import contextlib
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cauce_pty_agent import session_recovery as recovery

HARNESSES = ("claude", "codex", "muse", "grok")


class SessionRecoveryPhysicalIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-recovery-physical-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "home"
        self.state = self.home / "state"
        self.workspace = self.home / "workspace"
        self.state.mkdir(parents=True, mode=0o700)
        self.workspace.mkdir(mode=0o700)
        self.wire = "wire-" + uuid.uuid4().hex[:12]
        self.physical = "physical-" + uuid.uuid4().hex[:12]
        self.node = os.path.realpath(sys.executable)

    @contextlib.contextmanager
    def adapter(self, harness: str, *, overrides: dict[str, str | None] | None = None,
                session_leader: bool = True):
        environment = {
            "HOME": str(self.home), "PATH": os.defpath,
            "CAUCE_ALIAS": self.wire, "CAUCE_RUNTIME_KEY": self.physical,
            "CAUCE_TENANT_ID": "zz-canary-recovery", "CAUCE_STATE_DIR": str(self.state),
            "CAUCE_CONTAINER_ID": "c" * 64, "CAUCE_CONTAINER_GENERATION": "a" * 64,
            "CAUCE_SHARED_SESSION": "1", "CAUCE_SHARED_SESSION_WORKSPACE": str(self.workspace),
        }
        for key, value in (overrides or {}).items():
            if value is None:
                environment.pop(key, None)
            else:
                environment[key] = value
        bundle = {
            "alias": self.wire, "harness": harness, "home": str(self.home),
            "runtime_uid": os.geteuid(), "tenant_id": "zz-canary-recovery", "container_id": "c" * 64,
            "session_recovery": {"state_directory": str(self.state), "adapter_generation": "a" * 64},
            "tmux_tui": {"path": "/usr/bin/tmux", "socket": "cauce", "alias": self.physical},
        }
        script = f"/usr/share/cauce-fixture/bin/{harness}.js"
        helper = "/usr/share/cauce-fixture/bin/shared-session.js"
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", "import time; time.sleep(60)", script],
            env=environment, start_new_session=session_leader,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            with mock.patch.object(recovery, "trusted_file", side_effect=lambda path, **_: path in {
                script, helper, self.node,
            }) as trusted:
                yield bundle, environment, trusted
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def probe(self, bundle):
        return recovery.adapter_command(bundle, time.monotonic() + 3)

    def test_each_harness_uses_the_accredited_physical_alias_and_preserves_wire_environment(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness) as (bundle, environment, trusted):
                selected = self.probe(bundle)
                self.assertIsNotNone(selected)
                command, selected_environment = selected
                self.assertEqual(command, [
                    self.node, "/usr/share/cauce-fixture/bin/shared-session.js", "recovery-preview",
                    "--alias", self.physical, "--harness", harness, "--workspace", str(self.workspace),
                    "--state", str(self.state),
                ])
                self.assertEqual(selected_environment, environment)
                self.assertEqual(bundle["alias"], self.wire)
                self.assertEqual(trusted.call_args_list, [
                    mock.call(f"/usr/share/cauce-fixture/bin/{harness}.js"),
                    mock.call("/usr/share/cauce-fixture/bin/shared-session.js"),
                    mock.call(self.node, executable=True),
                ])

    def test_each_harness_rejects_another_wire_alias_even_when_the_physical_alias_matches(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness, overrides={
                "CAUCE_ALIAS": "another-visible-alias",
            }) as (bundle, _, trusted):
                self.assertIsNone(self.probe(bundle))
                trusted.assert_not_called()

    def test_each_harness_rejects_another_physical_alias_even_when_the_wire_alias_matches(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness, overrides={
                "CAUCE_RUNTIME_KEY": "another-physical-alias",
            }) as (bundle, _, trusted):
                self.assertIsNone(self.probe(bundle))
                trusted.assert_not_called()

    def test_each_harness_rejects_foreign_wire_when_runtime_key_equals_the_bundle_wire(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness, overrides={
                "CAUCE_ALIAS": "another-visible-alias", "CAUCE_RUNTIME_KEY": self.wire,
            }) as (bundle, _, trusted):
                bundle["tmux_tui"]["alias"] = self.wire
                self.assertIsNone(self.probe(bundle))
                trusted.assert_not_called()

    def test_each_harness_rejects_identity_drift_before_trusting_executables(self) -> None:
        for harness in HARNESSES:
            for key, value in {
                "CAUCE_CONTAINER_GENERATION": "b" * 64,
                "CAUCE_TENANT_ID": "another-tenant",
                "CAUCE_CONTAINER_ID": "d" * 64,
                "CAUCE_STATE_DIR": str(self.home),
                "HOME": self.temporary.name,
                "CAUCE_ALIAS": None,
            }.items():
                with self.subTest(harness=harness, key=key), self.adapter(harness, overrides={
                    key: value,
                }) as (bundle, _, trusted):
                    self.assertIsNone(self.probe(bundle))
                    trusted.assert_not_called()

    def test_each_harness_requires_a_descriptor_for_a_distinct_physical_alias(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness) as (bundle, _, trusted):
                del bundle["tmux_tui"]["alias"]
                self.assertIsNone(self.probe(bundle))
                trusted.assert_not_called()

    def test_each_harness_preserves_legacy_wire_equals_physical_with_or_without_runtime_key(self) -> None:
        for harness in HARNESSES:
            for key in (None, self.wire):
                with self.subTest(harness=harness, runtime_key=key), self.adapter(harness, overrides={
                    "CAUCE_RUNTIME_KEY": key,
                }) as (bundle, _, _):
                    del bundle["tmux_tui"]["alias"]
                    command, environment = self.probe(bundle)
                    self.assertEqual(command[command.index("--alias") + 1], self.wire)
                    self.assertEqual(environment["CAUCE_ALIAS"], self.wire)

    def test_each_harness_rejects_malformed_wire_and_physical_names(self) -> None:
        for harness in HARNESSES:
            with self.adapter(harness) as (bundle, _, trusted):
                for field in ("wire", "physical"):
                    for invalid in ("../other", "", None, 7):
                        with self.subTest(harness=harness, field=field, value=invalid):
                            changed = {**bundle, "tmux_tui": dict(bundle["tmux_tui"])}
                            if field == "wire":
                                changed["alias"] = invalid
                            else:
                                changed["tmux_tui"]["alias"] = invalid
                            self.assertIsNone(self.probe(changed))
                trusted.assert_not_called()

    def test_each_harness_still_requires_a_session_and_process_group_leader(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness, session_leader=False) as (bundle, _, trusted):
                self.assertIsNone(self.probe(bundle))
                trusted.assert_not_called()

    def test_each_harness_still_rejects_an_untrusted_helper(self) -> None:
        for harness in HARNESSES:
            with self.subTest(harness=harness), self.adapter(harness) as (bundle, _, trusted):
                trusted.side_effect = lambda path, **_: path != "/usr/share/cauce-fixture/bin/shared-session.js"
                self.assertIsNone(self.probe(bundle))
                trusted.assert_any_call("/usr/share/cauce-fixture/bin/shared-session.js")

    def test_trusted_file_keeps_root_ownership_and_parent_mode_requirements(self) -> None:
        self.assertTrue(recovery.trusted_file("/usr/bin/env", executable=True))
        writable = self.home / "helper.js"
        writable.write_text("fixture")
        self.assertFalse(recovery.trusted_file(str(writable)))
        linked = self.home / "node"
        linked.symlink_to("/usr/bin/env")
        self.assertFalse(recovery.trusted_file(str(linked), executable=True))


if __name__ == "__main__":
    unittest.main()
