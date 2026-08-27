#!/usr/bin/env python3
"""Regression tests for per-OPEN, same-server tmux identity binding."""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import time
import unittest
import uuid

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402

TMUX = shutil.which("tmux")


def _bundle(socket_name: str, *, alias: str = "zeus", harness: str = "claude") -> dict:
    return {
        "tmux_tui": {"path": TMUX or "/usr/bin/tmux", "socket": socket_name},
        "alias": alias,
        "harness": harness,
    }


@unittest.skipUnless(TMUX, "tmux is required for the real identity regression")
class DynamicTmuxIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.socket = f"cauce-pty-test-{os.getpid()}-{uuid.uuid4().hex[:10]}"
        self.env = dict(os.environ, TERM="xterm")

    def tearDown(self) -> None:
        subprocess.run(
            [TMUX, "-L", self.socket, "kill-server"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            env=self.env,
        )

    def _session(self, marker_alias: str, marker_harness: str) -> str:
        subprocess.run(
            [TMUX, "-L", self.socket, "new-session", "-d", "-s", "cauce-zeus", "-n", "tui", "sleep 30"],
            check=True,
            env=self.env,
        )
        subprocess.run(
            [TMUX, "-L", self.socket, "set-option", "-t", "cauce-zeus", "@cauce_alias", marker_alias],
            check=True,
            env=self.env,
        )
        subprocess.run(
            [TMUX, "-L", self.socket, "set-option", "-t", "cauce-zeus", "@cauce_harness", marker_harness],
            check=True,
            env=self.env,
        )
        return subprocess.check_output(
            [TMUX, "-L", self.socket, "display-message", "-p", "-t", "cauce-zeus", "#{session_id}"],
            text=True,
            env=self.env,
        ).strip()

    def test_correct_identity_attaches_read_only_on_the_current_server(self) -> None:
        self._session("zeus", "claude")
        argv = agent.resolve_tmux_tui_command(_bundle(self.socket))
        self.assertIsNotNone(argv)
        master, slave = os.openpty()
        try:
            process = subprocess.Popen(
                argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=self.env,
            )
            os.close(slave)
            slave = -1
            time.sleep(0.2)
            self.assertIsNone(process.poll(), "the verified client did not remain attached")
            subprocess.run([TMUX, "-L", self.socket, "kill-server"], check=True, env=self.env)
            process.wait(timeout=3)
        finally:
            if slave >= 0:
                os.close(slave)
            os.close(master)
            if "process" in locals() and process.poll() is None:
                process.kill()
                process.wait(timeout=3)

    def test_the_same_resolver_discovers_a_session_created_after_agent_start(self) -> None:
        """No launcher/agent restart: a descriptor built before tmux exists works on a later OPEN."""
        argv = agent.resolve_tmux_tui_command(_bundle(self.socket))
        self.assertIsNotNone(argv)
        assert argv is not None
        before = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            env=self.env,
        )
        self.assertNotEqual(before.returncode, 0)

        self._session("zeus", "claude")
        master, slave = os.openpty()
        try:
            after = subprocess.Popen(
                argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=self.env,
            )
            os.close(slave)
            slave = -1
            time.sleep(0.2)
            self.assertIsNone(after.poll(), "the unchanged per-OPEN resolver did not discover tmux")
            subprocess.run([TMUX, "-L", self.socket, "kill-server"], check=True, env=self.env)
            after.wait(timeout=3)
        finally:
            if slave >= 0:
                os.close(slave)
            os.close(master)
            if "after" in locals() and after.poll() is None:
                after.kill()
                after.wait(timeout=3)

    def test_reused_session_id_after_server_restart_cannot_retarget_another_identity(self) -> None:
        old_id = self._session("zeus", "claude")
        argv = agent.resolve_tmux_tui_command(_bundle(self.socket))
        self.assertIsNotNone(argv)
        subprocess.run([TMUX, "-L", self.socket, "kill-server"], check=True, env=self.env)
        time.sleep(0.1)

        reused_id = self._session("kant", "codex")
        self.assertEqual(reused_id, old_id, "fixture did not reproduce tmux id reuse")
        refused = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            env=self.env,
        )
        self.assertEqual(refused.returncode, 77)

    def test_missing_exact_tui_target_fails_closed(self) -> None:
        subprocess.run(
            [TMUX, "-L", self.socket, "new-session", "-d", "-s", "cauce-kant", "-n", "tui", "sleep 30"],
            check=True,
            env=self.env,
        )
        argv = agent.resolve_tmux_tui_command(_bundle(self.socket))
        refused = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            env=self.env,
        )
        self.assertNotEqual(refused.returncode, 0)


class TmuxDescriptorValidationTest(unittest.TestCase):
    @unittest.skipUnless(TMUX, "tmux is required")
    def test_valid_system_tmux_descriptor_is_accepted(self) -> None:
        self.assertEqual(
            agent._tmux_tui_config({"path": TMUX, "socket": "cauce"}, "claude", "zeus"),
            {"path": TMUX, "socket": "cauce"},
        )

    def test_wrong_harness_or_unsafe_socket_is_refused(self) -> None:
        for descriptor, harness in (
            ({"path": "/usr/bin/tmux", "socket": "../other"}, "claude"),
            ({"path": "/usr/bin/tmux", "socket": "cauce"}, "openclaw"),
        ):
            with self.subTest(descriptor=descriptor, harness=harness), self.assertRaises(agent.PermanentError):
                agent._tmux_tui_config(descriptor, harness, "zeus")

    def test_argv_contains_atomic_identity_check_and_read_only_attach(self) -> None:
        argv = agent.resolve_tmux_tui_command(_bundle("cauce"))
        self.assertEqual(argv[:7], [TMUX or "/usr/bin/tmux", "-L", "cauce", "if-shell", "-F", "-t", "cauce-zeus:tui"])
        self.assertIn("#{session_name}", argv[7])
        self.assertIn("@cauce_alias", argv[7])
        self.assertIn("@cauce_harness", argv[7])
        self.assertEqual(argv[8], "attach-session -r -f ignore-size -t cauce-zeus:tui")
        self.assertEqual(argv[9], 'run-shell "exit 77"')


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
