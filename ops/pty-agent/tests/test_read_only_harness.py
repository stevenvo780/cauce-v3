#!/usr/bin/env python3
"""El modo `harness` MIRA. Nunca teclea. Y eso se mide en el pty, no en un contador.

POR QUE EL CANDADO SE MUEVE AL AGENTE
-------------------------------------
Hasta ahora lo unico que impedia teclear en la TUI ajena era el `-r` del `tmux attach` que el
lanzador arma. Eso tiene dos agujeros:

1. `HARNESS_COMMAND` se puede escribir a mano en `~/.config/cauce-v3/pty/<alias>.env`. Un fichero
   sin `-r` convierte la consola en un teclado sobre la sesion del humano que esta trabajando ahi,
   y nada en todo el camino lo impide ni lo dice.
2. La TUI nativa de OpenClaw —la unica que pueden emitir los alias openclaw, porque en sus
   imagenes no hay `tmux` y el proceso es un demonio, no una pantalla— **no tiene `-r`**. No hay
   ningun argumento que la vuelva de solo lectura.

Y el dano no es hipotetico. Con la sesion compartida encendida hay UNA sola caja de entrada por
alias (`sessionKey: shared:<alias>` en engine.ts), asi que un segundo escritor no abre una
conversacion nueva: pisa el turno en curso. Medido el 2026-07-31 en kratos, cuatro degradaciones
`input_busy` seguidas por exactamente eso.

Por eso el candado deja de ser un argumento del argv y pasa a ser una propiedad del agente: un
modo de VISOR no escribe en su pty, venga la trama que venga. El `-r` del tmux se queda igual
(defensa en profundidad), pero ya no es lo unico que sostiene la promesa.

COMO SE MIDE
------------
Con un pty de verdad (`os.openpty`) y leyendo el lado esclavo: lo que importa es si los bytes
LLEGAN al proceso, no si una variable interna quedo vacia. Cada caso va con su control negativo
en el mismo pty y con la misma trama, cambiando solo el modo.
"""
from __future__ import annotations

import os
import pathlib
import sys
import unittest

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
