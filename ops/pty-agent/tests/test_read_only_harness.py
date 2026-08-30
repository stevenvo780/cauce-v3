#!/usr/bin/env python3
"""Pruebas para verificar que el modo `harness` sea estrictamente de solo lectura en el pty.

Valida que ninguna pulsación de teclas o entrada de stdin llegue al proceso del pty
cuando la sesión está en modo `harness`, contrastándolo con el modo `shell`.
"""
from __future__ import annotations

import os
import pathlib
import signal
import sys
import tty
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402

SESSION_ID = "11111111-2222-3333-4444-555555555555"
KEYSTROKES = b"rm -rf /\n"
ALIAS_KEY_HEX = "ab" * 32


def _bundle(**overrides: object) -> dict:
    document = {
        "tenant_id": "Steven", "alias": "jarvis", "container_id": "claw", "generation": "gen-1",
        "image_id": "sha256:deadbeef", "runtime_user": "claw", "runtime_uid": 1000, "runtime_gid": 1000,
        "home": "/home/claw", "shell_candidates": [["/bin/bash", "-l"], ["/bin/sh", "-l"]],
        "harness_command": ["/usr/bin/openclaw", "tui"], "harness": "openclaw",
        "relay_host": "100.64.0.6", "relay_port": 8445, "alias_key_hex": ALIAS_KEY_HEX,
        "client_cert_pem": "-----BEGIN CERTIFICATE-----\n",
        "client_key_pem": "-----BEGIN PRIVATE KEY-----\n",
        "ca_pem": "-----BEGIN CERTIFICATE-----\n", "agent_version": "1",
    }
    document.update(overrides)  # type: ignore[arg-type]
    return document


class StdinReachesOnlyWritableModes(unittest.TestCase):
    """La misma trama, el mismo pty; lo unico que cambia es el modo de la sesion."""

    def _deliver(self, mode: str) -> bytes:
        """Mete KEYSTROKES por la via del relay y devuelve lo que llego al proceso."""
        master, slave = os.openpty()
        try:
            os.set_blocking(master, False)
            os.set_blocking(slave, False)
            instance = agent.PtyAgent(_bundle())
            session = agent.PtySession(SESSION_ID, 0, master, mode, ["/usr/bin/openclaw", "tui"])
            instance.sessions[SESSION_ID] = session
            instance._on_stdin(SESSION_ID, KEYSTROKES)
            try:
                return os.read(slave, 4096)
            except BlockingIOError:
                return b""
        finally:
            os.close(master)
            os.close(slave)

    def test_harness_is_read_only_nothing_reaches_the_pty(self) -> None:
        self.assertEqual(
            self._deliver("harness"),
            b"",
            "una pulsacion de la consola llego a la TUI del agente: el modo harness no es de solo lectura",
        )

    def test_control_negativo_shell_si_recibe_lo_que_se_teclea(self) -> None:
        """Sin esto, un agente que descartara TODA la entrada pasaria la prueba de arriba."""
        self.assertEqual(self._deliver("shell"), KEYSTROKES)

    def _eof_after_stdin_on_a_dead_fd(self, mode: str) -> bool:
        """Con un descriptor ya cerrado, escribir marca `eof`. Si no se intenta, `eof` sigue False.

        Es la forma de comprobar que el rechazo ocurre ANTES de tocar el fd, y no despues de
        intentarlo. Mirar `pending_input` no serviria: `_write_session` lo vacia en el mismo
        paso, asi que quedaria vacio en los dos casos y la prueba no podria fallar nunca.
        """
        master, slave = os.openpty()
        os.close(master)
        os.close(slave)
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 0, master, mode, ["/usr/bin/openclaw", "tui"])
        instance.sessions[SESSION_ID] = session
        instance._on_stdin(SESSION_ID, KEYSTROKES)
        return session.eof

    def test_a_read_only_session_never_touches_the_descriptor(self) -> None:
        self.assertFalse(
            self._eof_after_stdin_on_a_dead_fd("harness"),
            "el agente intento escribir en el pty de un visor: el rechazo llega tarde",
        )

    def test_control_negativo_shell_si_intenta_escribir_y_lo_nota(self) -> None:
        """El control negativo del anterior: prueba que el metodo de medicion detecta la escritura."""
        self.assertTrue(self._eof_after_stdin_on_a_dead_fd("shell"))


class EmulatorResponsesAreNotHumanInput(unittest.TestCase):
    def _deliver_response(self, mode: str, data: bytes) -> bytes:
        master, slave = os.openpty()
        try:
            tty.setraw(slave)
            os.set_blocking(master, False)
            os.set_blocking(slave, False)
            instance = agent.PtyAgent(_bundle())
            session = agent.PtySession(SESSION_ID, 0, master, mode, ["/usr/bin/openclaw", "tui"])
            instance.sessions[SESSION_ID] = session
            instance._on_terminal_response(SESSION_ID, data)
            try:
                return os.read(slave, 4096)
            except BlockingIOError:
                return b""
        finally:
            os.close(master)
            os.close(slave)

    def test_da_dsr_reach_a_read_only_harness_through_the_technical_path(self) -> None:
        response = b"\x1b[?1;2c\x1b[>0;276;0c\x1b[0n\x1b[24;80R\x1b[?24;80R"
        self.assertTrue(agent.is_terminal_emulator_response(response))
        self.assertEqual(self._deliver_response("harness", response), response)

    def test_the_technical_path_is_not_valid_for_an_interactive_shell(self) -> None:
        with self.assertRaisesRegex(agent.ProtocolError, "read-only"):
            self._deliver_response("shell", b"\x1b[0n")

    def test_text_paste_mouse_and_generic_ansi_fail_closed(self) -> None:
        abusive = (
            b"whoami\r", b"\x1b[31m", b"\x1b[<0;1;1M", b"\x1b[201;1R",
            b"\x1b[1;501R", b"\x1b[0;1R", "á".encode(), b"\x1b[0n" * 100,
        )
        for payload in abusive:
            with self.subTest(payload=payload):
                self.assertFalse(agent.is_terminal_emulator_response(payload))
                with self.assertRaises(agent.ProtocolError):
                    self._deliver_response("harness", payload)


class WindowGeometryUsesOneClamp(unittest.TestCase):
    def test_open_and_resize_geometry_bounds_are_shared(self) -> None:
        self.assertEqual(agent._window({"cols": 1, "rows": 1}), (agent.MIN_ROWS, agent.MIN_COLS))
        self.assertEqual(
            agent._window({"cols": 9999, "rows": 9999}),
            (agent.MAX_ROWS, agent.MAX_COLS),
        )

    def test_non_integer_geometry_is_a_protocol_violation(self) -> None:
        documents = (
            {"cols": "80", "rows": 24},
            {"cols": 80.5, "rows": 24},
            {"cols": True, "rows": 24},
        )
        for document in documents:
            with self.subTest(document=document), self.assertRaises(agent.ProtocolError):
                agent._window(document)


class PerSessionFlowControl(unittest.TestCase):
    def test_pause_and_resume_touch_only_the_named_session(self) -> None:
        instance = agent.PtyAgent(_bundle())
        first = agent.PtySession(SESSION_ID, 111, 10, "shell", ["/bin/sh"])
        other_id = "22222222-3333-4444-5555-666666666666"
        second = agent.PtySession(other_id, 222, 11, "shell", ["/bin/sh"])
        instance.sessions = {SESSION_ID: first, other_id: second}

        instance._on_output_flow({"session_id": SESSION_ID}, True)
        self.assertTrue(first.output_paused)
        self.assertFalse(second.output_paused)
        instance._on_output_flow({"session_id": SESSION_ID}, False)
        self.assertFalse(first.output_paused)

    def test_pause_holds_bytes_that_were_buffered_before_the_pause(self) -> None:
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 111, 10, "shell", ["/bin/sh"])
        session.out.extend(b"x" * (agent.FLUSH_BYTES + 808))
        instance.sessions = {SESSION_ID: session}

        instance._on_output_flow({"session_id": SESSION_ID}, True)
        instance._flush_session(session)

        self.assertEqual(len(session.out), agent.FLUSH_BYTES + 808)
        self.assertEqual(instance.outbound, b"")

    def test_resume_flushes_only_the_named_session(self) -> None:
        instance = agent.PtyAgent(_bundle())
        first = agent.PtySession(SESSION_ID, 111, 10, "shell", ["/bin/sh"])
        other_id = "22222222-3333-4444-5555-666666666666"
        second = agent.PtySession(other_id, 222, 11, "shell", ["/bin/sh"])
        first.out.extend(b"a" * agent.FLUSH_BYTES)
        second.out.extend(b"b" * agent.FLUSH_BYTES)
        instance.sessions = {SESSION_ID: first, other_id: second}
        instance._on_output_flow({"session_id": SESSION_ID}, True)
        instance._on_output_flow({"session_id": other_id}, True)

        instance._on_output_flow({"session_id": SESSION_ID}, False)

        self.assertFalse(first.output_paused)
        self.assertEqual(first.out, b"")
        self.assertTrue(instance.outbound)
        self.assertTrue(second.output_paused)
        self.assertEqual(second.out, b"b" * agent.FLUSH_BYTES)

    def test_invalid_flow_control_fails_closed(self) -> None:
        instance = agent.PtyAgent(_bundle())
        with self.assertRaises(agent.ProtocolError):
            instance._on_output_flow({"session_id": "not-a-session"}, True)

    def test_input_flood_hangs_up_only_its_session_with_a_bounded_buffer(self) -> None:
        instance = agent.PtyAgent(_bundle())
        first = agent.PtySession(SESSION_ID, 111, 10, "shell", ["/bin/sh"])
        other_id = "22222222-3333-4444-5555-666666666666"
        second = agent.PtySession(other_id, 222, 11, "shell", ["/bin/sh"])
        instance.sessions = {SESSION_ID: first, other_id: second}
        first.pending_input.extend(b"x" * agent.SESSION_INPUT_HIGH_WATER)

        with mock.patch.object(instance, "_signal") as signal_process:
            instance._on_stdin(SESSION_ID, b"overflow")

        self.assertEqual(first.pending_input, b"")
        self.assertEqual(first.close_reason, "input_flood")
        self.assertIsNotNone(first.kill_deadline)
        self.assertIsNone(second.kill_deadline)
        signal_process.assert_called_once()

    def test_agent_advertises_session_scoped_flow_control(self) -> None:
        self.assertIn("session_output_flow_control", agent.FEATURES)

    def test_paused_buffer_does_not_force_a_zero_timeout_busy_loop(self) -> None:
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 111, 10, "shell", ["/bin/sh"])
        session.out.extend(b"x" * agent.FLUSH_BYTES)
        session.output_paused = True
        session.last_flush = 1.0
        instance.sessions = {SESSION_ID: session}
        instance.acknowledged = True
        instance.last_ping = 100.0

        with mock.patch.object(agent.time, "monotonic", return_value=100.0):
            self.assertGreater(instance._timeout(), 0.0)

    def test_reaped_paused_session_forces_final_stdout_before_closed(self) -> None:
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 111, -1, "shell", ["/bin/sh"])
        session.out.extend(b"final output")
        session.output_paused = True
        session.reaped = True
        session.eof = True
        session.exit_code = 0
        instance.sessions = {SESSION_ID: session}
        instance.acknowledged = True
        instance.last_ping = 100.0

        with (
            mock.patch.object(instance, "_reap"),
            mock.patch.object(agent.time, "monotonic", return_value=100.0),
        ):
            instance._maintain()

        frames = agent.FrameDecoder().feed(bytes(instance.outbound))
        self.assertEqual([tag for tag, _ in frames], [agent.TAG_STDOUT, agent.TAG_CLOSED])
        self.assertEqual(agent.decode_data(frames[0][1]), (SESSION_ID, b"final output"))
        self.assertNotIn(SESSION_ID, instance.sessions)


class CloseAlwaysReapsTheChild(unittest.TestCase):
    def test_close_sends_hup_and_escalates_to_kill_at_the_deadline(self) -> None:
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 111, 10, "shell", ["/bin/sh"])
        instance.sessions = {SESSION_ID: session}

        with mock.patch.object(instance, "_signal") as signal_process:
            instance._on_close({"session_id": SESSION_ID, "reason": "operator_closed"})
            self.assertEqual(session.close_reason, "operator_closed")
            self.assertIsNotNone(session.kill_deadline)
            signal_process.assert_called_once_with(session, signal.SIGHUP)

            assert session.kill_deadline is not None
            instance.acknowledged = True
            instance.last_ping = session.kill_deadline
            with (
                mock.patch.object(instance, "_reap"),
                mock.patch.object(instance, "_flush_session"),
                mock.patch.object(agent.time, "monotonic", return_value=session.kill_deadline + 0.001),
            ):
                instance._maintain()
            self.assertEqual(signal_process.call_args_list[-1], mock.call(session, signal.SIGKILL))

    def test_lost_tls_teardown_kills_a_child_that_ignores_hup(self) -> None:
        instance = agent.PtyAgent(_bundle())
        session = agent.PtySession(SESSION_ID, 111, -1, "shell", ["/bin/sh"])
        instance.sessions = {SESSION_ID: session}

        with (
            mock.patch.object(instance, "_signal") as signal_process,
            mock.patch.object(instance, "_reap"),
            mock.patch.object(agent.time, "monotonic", side_effect=[10.0, 10.0 + agent.KILL_GRACE + 1]),
        ):
            instance._terminate_sessions()

        self.assertEqual(signal_process.call_args_list, [
            mock.call(session, signal.SIGHUP),
            mock.call(session, signal.SIGKILL),
        ])
        self.assertEqual(instance.sessions, {})


class TheReadOnlyContractIsDeclared(unittest.TestCase):
    """El conjunto de modos de visor es explicito, y `shell` no esta en el."""

    def test_harness_is_declared_read_only(self) -> None:
        self.assertIn("harness", agent.READ_ONLY_MODES)

    def test_control_negativo_shell_no_es_de_solo_lectura(self) -> None:
        self.assertNotIn("shell", agent.READ_ONLY_MODES)

    def test_every_read_only_mode_is_a_mode_the_agent_can_serve(self) -> None:
        """Un modo de solo lectura que no existe seria una promesa sobre nada."""
        for mode in agent.READ_ONLY_MODES:
            self.assertIn(mode, agent.MODES)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
