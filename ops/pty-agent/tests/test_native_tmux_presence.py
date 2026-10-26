from __future__ import annotations

import base64
import hashlib
import hmac
import importlib
import json
import os
import pathlib
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest import mock

from .test_tmux_dynamic import TMUX, _loadable_bundle, agent, tmux_runtime

agent_module = importlib.import_module("cauce_pty_agent.agent")
session_module = importlib.import_module("cauce_pty_agent.session")
SESSION_ID = "11111111-2222-3333-4444-555555555555"
FULL_MODES = ["shell", "harness", "harness_rw"]


def _ticket(mode: str) -> str:
    payload = {
        "v": 1, "sid": SESSION_ID, "op": "unattributed:console-basic-auth", "sub": "Steven:kant",
        "tgt": {"tenant": "Steven", "alias": "zeus", "container": "claw", "generation": "gen-1",
                "image": "sha256:deadbeef", "uid": 1000, "user": "claw"},
        "mode": mode, "iat": int(time.time()), "exp": int(time.time()) + 60,
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(bytes.fromhex("ab" * 32), ("v1." + encoded).encode(), hashlib.sha256).digest()
    return f"v1.{encoded}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"


def _frames(instance: agent.PtyAgent) -> list[tuple[int, dict]]:
    return [(tag, json.loads(payload)) for tag, payload in agent.FrameDecoder().feed(bytes(instance.outbound))]


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
        with mock.patch.object(session_module, "TUI_RESTART_WAIT", 0.0), \
                self.assertRaisesRegex(agent.ProtocolError, "dynamic harness capability changed"):
            instance._maintain()

    def _connected(self) -> agent.PtyAgent:
        instance = agent.PtyAgent(self._bundle())
        instance.acknowledged = True
        instance.last_ping = time.monotonic()
        instance.next_dynamic_capability_check = 0.0
        return instance

    def _open_shell(self, instance: agent.PtyAgent) -> None:
        instance.sessions["s1"] = agent.PtySession("s1", 0, -1, "shell", ["/bin/sh"])

    def test_gained_native_pane_keeps_open_sessions_and_reconnects_after_the_last_one(self) -> None:
        instance = self._connected()
        self.assertEqual(instance.modes, ["shell"])
        self._open_shell(instance)
        self._session()
        instance._maintain()
        self.assertEqual(instance.modes, ["shell"])
        self.assertIn("s1", instance.sessions)
        del instance.sessions["s1"]
        instance.next_dynamic_capability_check = 0.0
        with self.assertRaisesRegex(agent.ProtocolError, "dynamic harness capability changed"):
            instance._maintain()

    def _kill_session(self) -> None:
        subprocess.run([TMUX, "-L", self.socket, "kill-session", "-t", "=cauce-zeus"], check=True, env=self.env)

    def _restarting(self) -> agent.PtyAgent:
        self._session()
        instance = self._connected()
        self.assertEqual(instance.modes, FULL_MODES)
        self._kill_session()
        return instance

    def test_a_restarting_pane_keeps_presence_and_open_sessions(self) -> None:
        instance = self._restarting()
        self._open_shell(instance)
        instance._maintain()
        self.assertEqual(instance.modes, FULL_MODES)
        self.assertIn("s1", instance.sessions)
        self.assertIsNotNone(instance.tui_restart_until)
        self._session()
        instance.next_dynamic_capability_check = 0.0
        instance._maintain()
        self.assertIsNone(instance.tui_restart_until)
        self.assertEqual(instance.modes, FULL_MODES)
        self.assertIn("s1", instance.sessions)

    def test_lost_native_pane_reconnects_with_open_sessions_once_the_restart_wait_expires(self) -> None:
        instance = self._restarting()
        self._open_shell(instance)
        instance._maintain()
        instance.tui_restart_until = time.monotonic() - 1.0
        instance.next_dynamic_capability_check = 0.0
        with self.assertRaisesRegex(agent.ProtocolError, "dynamic harness capability changed"):
            instance._maintain()

    def _spawned(self, instance: agent.PtyAgent) -> mock.MagicMock:
        return mock.patch.object(instance, "_spawn", side_effect=lambda session_id, mode, argv, rows, cols:
                                 agent.PtySession(session_id, 2**31 - 1, -1, mode, argv))

    def test_a_tui_open_in_the_restart_gap_waits_and_attaches_to_the_new_pane(self) -> None:
        instance = self._restarting()
        with self._spawned(instance) as spawn:
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("harness_rw")})
            self.assertEqual(_frames(instance), [])
            instance._maintain()
            self.assertEqual(_frames(instance), [])
            self.assertIn(SESSION_ID, instance.pending_opens)
            self._session()
            instance.next_pending_open_poll = 0.0
            instance._maintain()
        tag, document = _frames(instance)[0]
        self.assertEqual((tag, document["mode"]), (agent.TAG_OPEN_OK, "harness_rw"))
        argv = spawn.call_args.args[2]
        self.assertEqual(argv[3:5], ["if-shell", "-F"])
        self.assertEqual(argv[-2], "attach-session -t cauce-zeus:agente")
        self.assertEqual(instance.modes, FULL_MODES)
        self.assertEqual(instance.pending_opens, {})

    def test_a_deferred_open_is_refused_before_the_relay_open_timeout(self) -> None:
        self.assertLess(session_module.OPEN_TUI_WAIT, 10.0)
        instance = self._restarting()
        with mock.patch.object(session_module, "OPEN_TUI_WAIT", 0.0), self._spawned(instance) as spawn:
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("harness")})
            instance._maintain()
        spawn.assert_not_called()
        self.assertEqual(_frames(instance), [(agent.TAG_OPEN_ERR, {
            "session_id": SESSION_ID, "reason": "mode_unavailable", "detail": "tui_restarting"})])

    def test_a_deferred_open_checks_its_ticket_again_when_the_pane_is_back(self) -> None:
        instance = self._restarting()
        with self._spawned(instance) as spawn:
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("harness_rw")})
            self._session()
            with mock.patch.object(session_module.time, "time", return_value=time.time() + 3600):
                instance._maintain()
        spawn.assert_not_called()
        self.assertEqual(_frames(instance), [(agent.TAG_OPEN_ERR, {
            "session_id": SESSION_ID, "reason": "ticket_expired"})])

    def test_a_relay_close_drops_a_deferred_open_for_good(self) -> None:
        instance = self._restarting()
        with self._spawned(instance) as spawn:
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("harness_rw")})
            instance._on_close({"session_id": SESSION_ID, "reason": "open_timeout"})
            self._session()
            instance.next_pending_open_poll = 0.0
            instance._maintain()
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("harness_rw")})
        spawn.assert_not_called()
        self.assertEqual(_frames(instance), [(agent.TAG_OPEN_ERR, {
            "session_id": SESSION_ID, "reason": "duplicate_session"})])

    def test_a_shell_open_in_the_restart_gap_is_served_at_once(self) -> None:
        instance = self._restarting()
        with self._spawned(instance) as spawn:
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("shell")})
        spawn.assert_called_once()
        self.assertEqual(_frames(instance)[0][0], agent.TAG_OPEN_OK)
        self.assertEqual(instance.pending_opens, {})

    def test_a_shell_only_presence_never_defers_a_tui_open(self) -> None:
        instance = self._connected()
        self.assertEqual(instance.modes, ["shell"])
        with self._spawned(instance):
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket("harness_rw")})
        self.assertEqual(instance.pending_opens, {})
        self.assertIsNone(instance.tui_restart_until)

    def test_first_hello_waits_for_the_configured_tui(self) -> None:
        instance = agent.PtyAgent(self._bundle())
        self.assertEqual(instance.modes, ["shell"])
        polls = []
        with mock.patch.object(agent_module.time, "sleep", side_effect=lambda _: polls.append(self._session())):
            instance._await_initial_tui()
        self.assertEqual(len(polls), 1)
        self.assertEqual(instance._advertised_modes(), ["shell", "harness", "harness_rw"])

    def test_first_hello_goes_out_shell_only_once_the_wait_expires(self) -> None:
        instance = agent.PtyAgent(self._bundle())
        with mock.patch.object(agent_module, "INITIAL_TUI_WAIT", 0.0), mock.patch.object(agent_module.time, "sleep") as sleep:
            instance._await_initial_tui()
        sleep.assert_not_called()

    def test_first_hello_never_waits_without_a_configured_tui(self) -> None:
        instance = agent.PtyAgent(agent.validate_bundle(_loadable_bundle(harness="muse", tmux_tui=None)))
        with mock.patch.object(agent_module, "tmux_tui_available") as available:
            instance._await_initial_tui()
        available.assert_not_called()

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
                        with mock.patch.object(session_module, 'TUI_RESTART_WAIT', 0.0), \
                                self.assertRaisesRegex(agent.ProtocolError, 'dynamic harness capability changed'):
                            current._maintain()
                        self.assertEqual(agent.PtyAgent(bundle).modes, ['shell'])
                finally:
                    subprocess.run([TMUX, '-S', socket, 'kill-server'], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    unittest.main()
