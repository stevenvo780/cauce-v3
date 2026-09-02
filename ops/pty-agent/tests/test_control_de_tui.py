#!/usr/bin/env python3
"""The writable TUI mode: who may type into the shared pane, and who holds the keyboard.

`harness` stays a viewer (test_read_only_harness.py proves it). `harness_rw` is the mode that
types, and it is only sound on the tmux route, the only one with a pane barrier. Three local
sources can hold its keyboard -- the adapter's paste, which fences the pane with
`@cauce_input_barrier`; this agent's own governance write transactions; and the tmux prefix
byte, which would otherwise carry the browser to the tmux command prompt -- and while any of
them holds it the burst is DROPPED and answered with one INPUT_REFUSED frame.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tty
import unittest
import uuid
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402

TMUX = shutil.which("tmux")
SESSION_ID = "11111111-2222-3333-4444-555555555555"
KEYSTROKES = b"echo hola\r"
TMUX_PREFIX_BYTE = 0x02
PREFIX_BURST = b"e\x02:"
ALIAS_KEY_HEX = "ab" * 32
FAR_FUTURE = 4102444800


def _bundle(**overrides: object) -> dict:
    document = {
        "tenant_id": "Steven", "alias": "jarvis", "container_id": "claw", "generation": "gen-1",
        "image_id": "sha256:deadbeef", "runtime_user": "claw", "runtime_uid": 1000,
        "runtime_gid": 1000, "home": "/home/claw",
        "shell_candidates": [["/bin/bash", "-l"], ["/bin/sh", "-l"]],
        "harness_command": None, "harness": "claude", "relay_host": "100.64.0.6",
        "relay_port": 8445, "alias_key_hex": ALIAS_KEY_HEX,
        "client_cert_pem": "-----BEGIN CERTIFICATE-----\n",
        "client_key_pem": "-----BEGIN PRIVATE KEY-----\n",
        "ca_pem": "-----BEGIN CERTIFICATE-----\n", "agent_version": "1",
        "tmux_tui": {"path": TMUX or "/usr/bin/tmux", "socket": "cauce"},
    }
    document.update(overrides)  # type: ignore[arg-type]
    return document


def _ticket(mode: str) -> str:
    payload = {
        "v": 1, "sid": SESSION_ID, "op": "unattributed:console-basic-auth", "sub": "Steven:kant",
        "tgt": {
            "tenant": "Steven", "alias": "jarvis", "container": "claw", "generation": "gen-1",
            "image": "sha256:deadbeef", "uid": 1000, "user": "claw",
        },
        "mode": mode, "iat": 1750000000, "exp": FAR_FUTURE,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"),
    ).decode("ascii").rstrip("=")
    signature = hmac.new(
        bytes.fromhex(ALIAS_KEY_HEX), ("v1." + encoded).encode("ascii"), hashlib.sha256,
    ).digest()
    return f"v1.{encoded}.{base64.urlsafe_b64encode(signature).decode('ascii').rstrip('=')}"


def _frames(instance: agent.PtyAgent) -> list[tuple[int, dict]]:
    decoded = agent.FrameDecoder().feed(bytes(instance.outbound))
    return [(tag, json.loads(payload.decode("utf-8"))) for tag, payload in decoded]


def _refusals(instance: agent.PtyAgent) -> list[dict]:
    return [document for tag, document in _frames(instance) if tag == agent.TAG_INPUT_REFUSED]


class WritableTuiTypesUnlessSomebodyHoldsThePane(unittest.TestCase):
    """The same frame, the same pty; what changes is the mode and who holds the keyboard."""

    def _deliver(self, mode: str, *, held: bool = False, pending: str = "",
                 data: bytes = KEYSTROKES, bursts: int = 1) -> tuple[bytes, list[dict]]:
        master, slave = os.openpty()
        try:
            tty.setraw(slave)
            os.set_blocking(master, False)
            os.set_blocking(slave, False)
            instance = agent.PtyAgent(_bundle())
            # The server prefix is a fact of the live tmux; pinned here so no unit test forks one.
            instance.input_barrier.prefixes = frozenset({TMUX_PREFIX_BYTE})
            session = agent.PtySession(SESSION_ID, 0, master, mode, ["/usr/bin/tmux"])
            instance.sessions[SESSION_ID] = session
            if pending:
                held_by = (instance.pending_writes if pending == "write"
                           else instance.pending_write_batches)
                held_by["cccccccc-1111-2222-3333-777777777777"] = object()
            with mock.patch.object(agent, "pane_input_barrier_held", return_value=held):
                for _ in range(bursts):
                    instance._on_stdin(SESSION_ID, data)
            try:
                arrived = os.read(slave, 4096)
            except BlockingIOError:
                arrived = b""
            return arrived, _refusals(instance)
        finally:
            os.close(master)
            os.close(slave)

    def test_harness_rw_types_into_the_pane(self) -> None:
        arrived, refusals = self._deliver("harness_rw")
        self.assertEqual(arrived, KEYSTROKES)
        self.assertEqual(refusals, [])

    def test_control_negativo_harness_sigue_sin_escribir_nada(self) -> None:
        """Without this, an agent that dropped EVERY byte would pass the test above."""
        arrived, refusals = self._deliver("harness")
        self.assertEqual(arrived, b"")
        self.assertEqual(refusals, [])

    def test_a_pane_barrier_drops_the_burst_and_answers_once(self) -> None:
        arrived, refusals = self._deliver("harness_rw", held=True)
        self.assertEqual(arrived, b"", "a keystroke reached a pane the adapter had fenced")
        self.assertEqual(refusals, [{"session_id": SESSION_ID, "reason": "pane_input_barrier"}])

    def test_a_pending_write_batch_drops_the_burst_too(self) -> None:
        arrived, refusals = self._deliver("harness_rw", pending="batch")
        self.assertEqual(arrived, b"")
        self.assertEqual(
            refusals, [{"session_id": SESSION_ID, "reason": "governance_write_in_flight"}])

    def test_a_pending_single_file_write_drops_the_burst_too(self) -> None:
        """The gate reads BOTH transaction maps: a one-file WRITE holds the keyboard as well."""
        arrived, refusals = self._deliver("harness_rw", pending="write")
        self.assertEqual(arrived, b"")
        self.assertEqual(
            refusals, [{"session_id": SESSION_ID, "reason": "governance_write_in_flight"}])

    def test_a_burst_carrying_the_tmux_prefix_never_reaches_the_pane(self) -> None:
        arrived, refusals = self._deliver("harness_rw", data=PREFIX_BURST)
        self.assertEqual(arrived, b"", "the browser reached the tmux command prompt")
        self.assertEqual(refusals, [{"session_id": SESSION_ID, "reason": "tmux_prefix"}])

    def test_control_negativo_the_same_burst_is_ordinary_input_for_a_shell(self) -> None:
        arrived, refusals = self._deliver("shell", data=PREFIX_BURST)
        self.assertEqual(arrived, PREFIX_BURST)
        self.assertEqual(refusals, [])

    def test_one_frame_per_burst_and_never_a_queue_that_replays_later(self) -> None:
        arrived, refusals = self._deliver("harness_rw", held=True, bursts=3)
        self.assertEqual(arrived, b"")
        self.assertEqual(len(refusals), 3)

    def test_the_refused_bytes_are_not_parked_in_pending_input(self) -> None:
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 0, -1, "harness_rw", ["/usr/bin/tmux"])
        instance.sessions[SESSION_ID] = session
        instance.input_barrier.prefixes = frozenset({TMUX_PREFIX_BYTE})
        with mock.patch.object(agent, "pane_input_barrier_held", return_value=True):
            instance._on_stdin(SESSION_ID, KEYSTROKES)
        self.assertEqual(session.pending_input, b"")
        self.assertFalse(session.eof, "the refusal reached the descriptor before dropping")


class ThePaneIsProbedOncePerTtl(unittest.TestCase):
    def test_the_cache_holds_for_the_ttl_and_is_rechecked_after_it_lapses(self) -> None:
        barrier = agent.InputBarrier(_bundle())
        with mock.patch.object(agent, "pane_input_barrier_held", return_value=False) as probe:
            self.assertFalse(barrier.pane_held(100.0))
            self.assertFalse(barrier.pane_held(100.0 + agent.INPUT_BARRIER_TTL - 0.01))
            self.assertEqual(probe.call_count, 1, "a keystroke became its own tmux fork")
            self.assertFalse(barrier.pane_held(100.0 + agent.INPUT_BARRIER_TTL))
            self.assertEqual(probe.call_count, 2)

    def test_the_ttl_is_the_frozen_quarter_second(self) -> None:
        self.assertEqual(agent.INPUT_BARRIER_TTL, 0.25)

    def test_governance_short_circuits_before_forking_tmux(self) -> None:
        barrier = agent.InputBarrier(_bundle())
        barrier.prefixes = frozenset({TMUX_PREFIX_BYTE})
        with mock.patch.object(agent, "pane_input_barrier_held", return_value=False) as probe:
            self.assertEqual(barrier.refusal(b"", True, 100.0), "governance_write_in_flight")
            probe.assert_not_called()

    def test_an_unreadable_server_falls_back_to_the_default_prefix_and_reads_it_once(self) -> None:
        """An empty set would forward the one byte this gate exists to stop."""
        barrier = agent.InputBarrier(_bundle())
        with mock.patch("cauce_pty_agent.input_barrier.subprocess.run", side_effect=OSError) as run:
            self.assertEqual(barrier.prefix_bytes(), frozenset({TMUX_PREFIX_BYTE}))
            self.assertEqual(barrier.prefix_bytes(), frozenset({TMUX_PREFIX_BYTE}))
        self.assertEqual(run.call_count, 2, "prefix/prefix2 were re-read on the second burst")

    def test_an_unreadable_pane_is_a_held_pane(self) -> None:
        """Fail-closed: a tmux that does not answer must never be read as «nobody is typing»."""
        self.assertTrue(agent.pane_input_barrier_held(_bundle(tmux_tui=None)))
        self.assertTrue(agent.pane_input_barrier_held(
            _bundle(tmux_tui={"path": "/nonexistent/tmux", "socket": "cauce"})))


class TerminalResponsesFollowTheTuiSet(unittest.TestCase):
    def _deliver_response(self, mode: str, data: bytes = b"\x1b[0n") -> bytes:
        master, slave = os.openpty()
        try:
            tty.setraw(slave)
            os.set_blocking(master, False)
            os.set_blocking(slave, False)
            instance = agent.PtyAgent(_bundle())
            session = agent.PtySession(SESSION_ID, 0, master, mode, ["/usr/bin/tmux"])
            instance.sessions[SESSION_ID] = session
            instance._on_terminal_response(SESSION_ID, data)
            try:
                return os.read(slave, 4096)
            except BlockingIOError:
                return b""
        finally:
            os.close(master)
            os.close(slave)

    def test_both_tui_modes_receive_the_emulator_answer(self) -> None:
        for mode in sorted(agent.TUI_MODES):
            with self.subTest(mode=mode):
                self.assertEqual(self._deliver_response(mode), b"\x1b[0n")

    def test_control_negativo_a_shell_never_gets_the_technical_channel(self) -> None:
        with self.assertRaises(agent.ProtocolError):
            self._deliver_response("shell")

    def test_the_mode_sets_keep_their_polarity(self) -> None:
        self.assertEqual(agent.READ_ONLY_MODES, frozenset({"harness"}))
        self.assertEqual(agent.TUI_MODES, frozenset({"harness", "harness_rw"}))
        self.assertEqual(agent.WRITABLE_TUI_MODES, frozenset({"harness_rw"}))
        self.assertEqual(agent.MODES, ("shell", "harness", "harness_rw"))


class AWritableTuiOnlyExistsOnTheTmuxRoute(unittest.TestCase):
    def _open(self, mode: str, **overrides: object) -> list[tuple[int, dict]]:
        instance = agent.PtyAgent(_bundle(**overrides))
        with mock.patch.object(instance, "_spawn") as spawn:
            spawn.return_value = agent.PtySession(SESSION_ID, 4242, -1, mode, ["/usr/bin/tmux"])
            instance._on_open({"session_id": SESSION_ID, "ticket": _ticket(mode)})
        return _frames(instance)

    def test_the_bundle_harness_command_route_refuses_to_become_writable(self) -> None:
        [(tag, document)] = self._open(
            "harness_rw", harness_command=["/usr/bin/openclaw", "tui"], tmux_tui=None,
            harness="openclaw")
        self.assertEqual(tag, agent.TAG_OPEN_ERR)
        self.assertEqual(document["reason"], "writable_tui_unavailable")
        self.assertEqual(document["detail"], "harness_command")

    def test_the_openclaw_route_refuses_to_become_writable(self) -> None:
        [(tag, document)] = self._open(
            "harness_rw", tmux_tui=None, harness="openclaw",
            openclaw_tui={"node": "/usr/bin/node", "entry": "/opt/openclaw/entry.js",
                          "state_directory": "/home/claw/.openclaw", "history_limit": 100})
        self.assertEqual(tag, agent.TAG_OPEN_ERR)
        self.assertEqual(document["reason"], "writable_tui_unavailable")
        self.assertEqual(document["detail"], "openclaw_tui")

    def test_control_negativo_those_routes_still_serve_the_viewer_mode(self) -> None:
        [(tag, document)] = self._open(
            "harness", harness_command=["/usr/bin/openclaw", "tui"], tmux_tui=None,
            harness="openclaw")
        self.assertEqual(tag, agent.TAG_OPEN_OK, document)

    def test_the_tmux_route_opens_a_writable_tui_and_declares_its_geometry(self) -> None:
        with mock.patch.object(agent, "tmux_window_geometry", return_value=(120, 40)):
            frames = self._open("harness_rw")
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_OPEN_OK, agent.TAG_GEOMETRY])
        self.assertEqual(frames[0][1]["mode"], "harness_rw")
        self.assertEqual(frames[1][1], {"session_id": SESSION_ID, "cols": 120, "rows": 40})

    def test_an_unmeasurable_window_sends_no_geometry_instead_of_a_guess(self) -> None:
        with mock.patch.object(agent, "tmux_window_geometry", return_value=None):
            frames = self._open("harness_rw")
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_OPEN_OK])

    def test_the_declared_geometry_goes_through_the_shared_clamp(self) -> None:
        with mock.patch.object(agent, "tmux_window_geometry", return_value=(9999, 1)):
            frames = self._open("harness_rw")
        self.assertEqual(
            frames[1][1], {"session_id": SESSION_ID, "cols": agent.MAX_COLS, "rows": agent.MIN_ROWS})


class GeometryFollowsTheBrowserWhileControlIsHeld(unittest.TestCase):
    def _resize(self, mode: str) -> list[int]:
        master, slave = os.openpty()
        try:
            instance = agent.PtyAgent(_bundle())
            session = agent.PtySession(SESSION_ID, 0, master, mode, ["/usr/bin/tmux"])
            instance.sessions[SESSION_ID] = session
            with mock.patch.object(agent, "tmux_window_geometry", return_value=(100, 30)):
                instance._on_resize({"session_id": SESSION_ID, "cols": 100, "rows": 30})
            return [tag for tag, _ in _frames(instance)]
        finally:
            os.close(master)
            os.close(slave)

    def test_a_resize_in_harness_rw_republishes_the_real_size(self) -> None:
        self.assertEqual(self._resize("harness_rw"), [agent.TAG_GEOMETRY])

    def test_control_negativo_a_viewer_resize_publishes_nothing(self) -> None:
        self.assertEqual(self._resize("harness"), [])

    def test_ten_resizes_inside_the_ttl_fork_tmux_once(self) -> None:
        """A window drag emits one RESIZE per changed column; each fork blocks the select loop."""
        master, slave = os.openpty()
        try:
            instance = agent.PtyAgent(_bundle())
            instance.sessions[SESSION_ID] = agent.PtySession(
                SESSION_ID, 0, master, "harness_rw", ["/usr/bin/tmux"])
            measured = subprocess.CompletedProcess([TMUX or "tmux"], 0, b"100 30\n", b"")
            with mock.patch(
                    "cauce_pty_agent.input_barrier.subprocess.run", return_value=measured) as run:
                for _ in range(10):
                    instance._on_resize({"session_id": SESSION_ID, "cols": 100, "rows": 30})
            self.assertEqual(run.call_count, 1, "every RESIZE became its own tmux fork")
            published = [document for tag, document in _frames(instance)
                         if tag == agent.TAG_GEOMETRY]
            self.assertEqual(len(published), 10)
            self.assertEqual(
                published[-1], {"session_id": SESSION_ID, "cols": 100, "rows": 30},
                "the cached geometry stopped being the measured one")
        finally:
            os.close(master)
            os.close(slave)


class ThePresenceOfHarnessRwIsMeasured(unittest.TestCase):
    def test_a_bundle_without_the_tmux_route_never_advertises_harness_rw(self) -> None:
        instance = agent.PtyAgent(_bundle(
            tmux_tui=None, harness="openclaw", harness_command=["/usr/bin/openclaw", "tui"]))
        self.assertEqual(instance.modes, ["shell", "harness"])

    @unittest.skipUnless(TMUX, "tmux is required to validate the descriptor")
    def test_control_positivo_the_tmux_route_advertises_both_tui_modes(self) -> None:
        instance = agent.PtyAgent(agent.validate_bundle(_bundle()))
        self.assertEqual(instance.modes, ["shell", "harness", "harness_rw"])


@unittest.skipUnless(TMUX, "tmux is required to read a real pane option")
class TheBarrierIsReadFromARealPane(unittest.TestCase):
    """No double: the option the adapter really sets, read from a real tmux server."""

    def setUp(self) -> None:
        self.socket = f"cauce-pty-test-{os.getpid()}-{uuid.uuid4().hex[:10]}"
        self.env = dict(os.environ, TERM="xterm")
        self.bundle = _bundle(alias="zeus", tmux_tui={"path": TMUX, "socket": self.socket})
        subprocess.run(
            [TMUX, "-L", self.socket, "new-session", "-d", "-s", "cauce-zeus", "-n", "agente",
             "-x", "120", "-y", "40", "sleep 30"],
            check=True, env=self.env,
        )

    def tearDown(self) -> None:
        subprocess.run(
            [TMUX, "-L", self.socket, "kill-server"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, env=self.env,
        )

    def _set_barrier(self, token: str) -> None:
        subprocess.run(
            [TMUX, "-L", self.socket, "set-option", "-p", "-t", "cauce-zeus:agente",
             "@cauce_input_barrier", token],
            check=True, env=self.env,
        )

    def test_a_free_pane_reads_as_free_and_a_fenced_one_as_held(self) -> None:
        self.assertFalse(agent.pane_input_barrier_held(self.bundle))
        self._set_barrier("f" * 64)
        self.assertTrue(agent.pane_input_barrier_held(self.bundle))

    def test_a_keystroke_is_dropped_while_the_real_option_is_set(self) -> None:
        self._set_barrier("a" * 64)
        master, slave = os.openpty()
        try:
            tty.setraw(slave)
            os.set_blocking(master, False)
            os.set_blocking(slave, False)
            instance = agent.PtyAgent(self.bundle)
            instance.sessions[SESSION_ID] = agent.PtySession(
                SESSION_ID, 0, master, "harness_rw", ["/usr/bin/tmux"])
            instance._on_stdin(SESSION_ID, KEYSTROKES)
            try:
                arrived = os.read(slave, 4096)
            except BlockingIOError:
                arrived = b""
        finally:
            os.close(master)
            os.close(slave)
        self.assertEqual(arrived, b"")
        self.assertEqual(
            _refusals(instance), [{"session_id": SESSION_ID, "reason": "pane_input_barrier"}])

    def _split(self) -> str:
        """Splits the harness window and returns the id of the pane that is NOT active."""
        subprocess.run(
            [TMUX, "-L", self.socket, "split-window", "-d", "-t", "cauce-zeus:agente", "sleep 30"],
            check=True, env=self.env,
        )
        listed = subprocess.run(
            [TMUX, "-L", self.socket, "list-panes", "-t", "cauce-zeus:agente",
             "-F", "#{pane_id} #{pane_active}"],
            check=True, capture_output=True, env=self.env,
        ).stdout.decode()
        inactive = [line.split(" ")[0] for line in listed.strip().split("\n")
                    if line.endswith(" 0")]
        self.assertEqual(len(inactive), 1, listed)
        return inactive[0]

    def test_a_fenced_pane_that_is_not_the_active_one_still_refuses(self) -> None:
        """`show-options -p -t <window>` answers for the ACTIVE pane: a split hid the barrier."""
        pane = self._split()
        subprocess.run(
            [TMUX, "-L", self.socket, "set-option", "-p", "-t", pane,
             "@cauce_input_barrier", "b" * 64],
            check=True, env=self.env,
        )
        self.assertTrue(agent.pane_input_barrier_held(self.bundle))

    def test_the_server_prefix_is_read_from_the_live_server(self) -> None:
        self.assertEqual(agent.InputBarrier(self.bundle).prefix_bytes(), frozenset({0x02}))
        subprocess.run(
            [TMUX, "-L", self.socket, "set-option", "-g", "prefix", "C-a"],
            check=True, env=self.env,
        )
        self.assertEqual(agent.InputBarrier(self.bundle).prefix_bytes(), frozenset({0x01}))

    def test_the_real_window_size_is_measured_not_guessed(self) -> None:
        self.assertEqual(agent.tmux_window_geometry(self.bundle), (120, 40))

    def test_a_window_of_another_alias_is_not_measurable(self) -> None:
        self.assertIsNone(agent.tmux_window_geometry(
            _bundle(alias="kant", tmux_tui={"path": TMUX, "socket": self.socket})))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
