from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest import mock

from .test_tmux_dynamic import TMUX, _loadable_bundle, agent, tmux_runtime


@unittest.skipUnless(TMUX, "tmux is required for native presence")
class NativeTmuxPresenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.socket = f"cauce-pty-test-native-{os.getpid()}-{uuid.uuid4().hex[:10]}"
        self.env = dict(os.environ, TERM="xterm")

    def tearDown(self) -> None:
        subprocess.run([TMUX, "-L", self.socket, "kill-server"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False, env=self.env)

    def _bundle(self, harness: str = "muse") -> dict:
        return agent.validate_bundle(_loadable_bundle(harness=harness,
            tmux_tui={"path": TMUX, "socket": self.socket}))

    def _session(self, harness: str = "muse", *, alias: str = "zeus", panes: int = 1) -> None:
        subprocess.run([TMUX, "-L", self.socket, "new-session", "-d", "-s", "cauce-zeus",
                        "-n", "agente", "sleep 30"], check=True, env=self.env)
        for key, value in (("@cauce_alias", alias), ("@cauce_harness", harness)):
            subprocess.run([TMUX, "-L", self.socket, "set-option", "-t", "cauce-zeus", key, value],
                           check=True, env=self.env)
        if panes != 1:
            subprocess.run([TMUX, "-L", self.socket, "split-window", "-d", "-t", "cauce-zeus:agente",
                            "sleep 30"], check=True, env=self.env)

    def test_missing_native_pane_advertises_shell_only(self) -> None:
        for harness in ("muse", "grok"):
            with self.subTest(harness=harness):
                self.assertEqual(agent.PtyAgent(self._bundle(harness)).modes, ["shell"])

    def test_exact_live_native_pane_advertises_both_modes(self) -> None:
        self._session()
        self.assertEqual(agent.PtyAgent(self._bundle()).modes, ["shell", "harness", "harness_rw"])
        subprocess.run([TMUX, "-L", self.socket, "set-option", "-t", "cauce-zeus", "@cauce_harness", "grok"],
                       check=True, env=self.env)
        self.assertEqual(agent.PtyAgent(self._bundle("grok")).modes, ["shell", "harness", "harness_rw"])

    def test_other_harness_marker_never_advertises_native_modes(self) -> None:
        self._session("claude")
        self.assertEqual(agent.PtyAgent(self._bundle()).modes, ["shell"])

    def test_other_alias_marker_never_advertises_native_modes(self) -> None:
        self._session(alias="kant")
        self.assertEqual(agent.PtyAgent(self._bundle()).modes, ["shell"])

    def test_split_native_pane_never_advertises_native_modes(self) -> None:
        self._session(panes=2)
        self.assertEqual(agent.PtyAgent(self._bundle()).modes, ["shell"])

    def test_unreadable_native_pane_never_advertises_native_modes(self) -> None:
        self._session()
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("tmux", 2)):
            self.assertEqual(agent.PtyAgent(self._bundle()).modes, ["shell"])

    def test_msp_or_headless_without_tmux_never_advertises_native_modes(self) -> None:
        for harness in ("muse", "grok"):
            bundle = agent.validate_bundle(_loadable_bundle(harness=harness, tmux_tui=None))
            self.assertEqual(agent.PtyAgent(bundle).modes, ["shell"])

    def test_static_command_does_not_substitute_for_a_native_pane(self) -> None:
        bundle = agent.validate_bundle(_loadable_bundle(harness="muse", tmux_tui=None,
                                                       harness_command=["/bin/cat"]))
        self.assertEqual(agent.PtyAgent(bundle).modes, ["shell"])

    def test_native_pane_degradation_replaces_stale_hello(self) -> None:
        self._session()
        instance = agent.PtyAgent(self._bundle())
        self.assertEqual(instance.modes, ["shell", "harness", "harness_rw"])
        instance.acknowledged = True
        instance.last_ping = time.monotonic()
        instance.next_dynamic_capability_check = 0.0
        subprocess.run([TMUX, "-L", self.socket, "set-option", "-t", "cauce-zeus", "@cauce_harness", "claude"],
                       check=True, env=self.env)
        with self.assertRaisesRegex(agent.ProtocolError, "dynamic harness capability changed"):
            instance._maintain()

    def test_a_pinned_fleet_channel_waits_for_its_canonical_panel_then_reconnects_with_current_modes(self):
        for harness in ('claude', 'codex', 'grok', 'muse'):
            with self.subTest(harness=harness), tempfile.TemporaryDirectory(prefix='cauce-pty-pinned-') as temporary:
                state = pathlib.Path(temporary)
                directory = state / ('tmux-' + str(os.geteuid()))
                directory.mkdir(mode=0o700)
                socket = str(directory / 'cauce')
                environment = {'CAUCE_ALIAS': 'logical_alias', 'CAUCE_RUNTIME_KEY': 'physical-one', 'TMUX_TMPDIR': str(state)}
                bundle = agent.validate_bundle(_loadable_bundle(alias='logical_alias', harness=harness,
                    runtime_uid=os.geteuid(), runtime_gid=os.getegid(),
                    tmux_tui={'path': TMUX, 'socket': 'cauce', 'alias': 'physical-one', 'state_directory': str(state)},
                    session_recovery={'state_directory': str(state), 'adapter_generation': 'a' * 64}))
                try:
                    with mock.patch.object(tmux_runtime, '_matching_environments', return_value=[environment]):
                        channel = agent.PtyAgent(bundle)
                        self.assertEqual(channel.modes, ['shell'])
                        channel.acknowledged = True
                        channel.last_ping = time.monotonic()
                        subprocess.run([TMUX, '-S', socket, 'new-session', '-d', '-s', 'cauce-physical-one',
                                        '-n', 'agente', 'sleep 30'], check=True, env=self.env)
                        for key, value in (('@cauce_alias', 'physical-one'), ('@cauce_harness', harness)):
                            subprocess.run([TMUX, '-S', socket, 'set-option', '-t', 'cauce-physical-one', key, value], check=True)
                        with self.assertRaisesRegex(agent.ProtocolError, 'dynamic harness capability changed'):
                            channel._maintain()
                        current = agent.PtyAgent(bundle)
                        self.assertEqual(current.modes, ['shell', 'harness', 'harness_rw'])
                        current.acknowledged = True
                        current.last_ping = time.monotonic()
                        subprocess.run([TMUX, '-S', socket, 'set-option', '-t', 'cauce-physical-one',
                                        '@cauce_alias', 'foreign'], check=True)
                        with self.assertRaisesRegex(agent.ProtocolError, 'dynamic harness capability changed'):
                            current._maintain()
                        self.assertEqual(agent.PtyAgent(bundle).modes, ['shell'])
                finally:
                    subprocess.run([TMUX, '-S', socket, 'kill-server'], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    unittest.main()
