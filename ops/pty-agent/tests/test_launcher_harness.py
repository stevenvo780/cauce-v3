"""La derivacion del modo `harness` desde la tmux viva del alias.

El lanzador es bash y habla con docker, asi que el test no lo ejecuta entero: extrae la funcion
`derive_harness_command` del fichero REAL (no una copia pegada aca, que se desincroniza sin que
nadie se entere) y la corre contra un `docker` de mentira que puede responder las tres cosas que
importan: hay tmux y hay sesion, hay tmux y NO hay sesion, y no hay tmux.

Cada caso positivo va con su CONTROL NEGATIVO: sin sesion viva la funcion tiene que fallar, y el
lanzador tiene que dejar `harness_command` en null. Un agente que anuncia una TUI que no existe
es peor que uno que anuncia solo `shell`: manda al operador a una pantalla vacia.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import unittest

LAUNCHER = pathlib.Path(__file__).resolve().parent.parent / "cauce-pty-launcher.sh"

PRELUDE = r"""
set -uo pipefail
die() { printf '%s\n' "$1" >&2; exit "${2:-2}"; }
valid_absolute_path() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ $1 != *'//'* && $1 != */../* && $1 != */./* && $1 != */.. && $1 != */. ]]
}
docker_control() { "$FAKE_DOCKER" "$@"; }
alias_name=zeus
container_id=deadbeef
runtime_uid=1000
runtime_gid=1000
TMUX_SOCKET=${CAUCE_PTY_TMUX_SOCKET:-cauce}
"""

EPILOGUE = r"""
TMUX_PATH_FOUND=''
TMUX_SESSION_FOUND=''
if derive_harness_command; then
  printf 'DERIVED %s %s\n' "$TMUX_PATH_FOUND" "$TMUX_SESSION_FOUND"
else
  printf 'NO_TUI\n'
fi
"""


def _function_source() -> str:
    """La funcion tal como esta HOY en el lanzador desplegable."""
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index("derive_harness_command() {")
    end = text.index("\n}\n", start) + len("\n}\n")
    return text[start:end]


def _fake_docker(tmp: pathlib.Path, *, tmux_path: str | None, session_live: bool) -> pathlib.Path:
    """Un `docker` que solo sabe responder los dos `exec` que hace la derivacion."""
    script = tmp / "docker"
    body = [
        "#!/usr/bin/env bash",
        'args="$*"',
        'if [[ $args == *"command -v tmux"* ]]; then',
    ]
    if tmux_path is None:
        body += ["  exit 1"]
    else:
        body += [f"  printf '{tmux_path}\\n'", "  exit 0"]
    body += [
        "fi",
        'if [[ $args == *has-session* ]]; then',
        "  exit 0" if session_live else "  printf 'no server running\\n' >&2; exit 1",
        "fi",
        "exit 97",
    ]
    script.write_text("\n".join(body) + "\n", encoding="utf-8")
    script.chmod(0o755)
    return script


class DeriveHarnessCommandTest(unittest.TestCase):
    def _run(self, **kwargs: object) -> str:
        import tempfile

        with tempfile.TemporaryDirectory() as raw:
            tmp = pathlib.Path(raw)
            fake = _fake_docker(tmp, **kwargs)  # type: ignore[arg-type]
            script = PRELUDE + _function_source() + EPILOGUE
            done = subprocess.run(
                ["bash", "-c", script],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin", "FAKE_DOCKER": str(fake)},
                check=False,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            return done.stdout.strip()

    def test_a_live_tmux_session_yields_the_alias_session(self) -> None:
        self.assertEqual(self._run(tmux_path="/usr/bin/tmux", session_live=True), "DERIVED /usr/bin/tmux cauce-zeus")

    def test_control_negativo_no_session_no_harness(self) -> None:
        # Mismo contenedor, mismo tmux instalado: lo unico que cambia es que no hay sesion viva.
        self.assertEqual(self._run(tmux_path="/usr/bin/tmux", session_live=False), "NO_TUI")

    def test_control_negativo_no_tmux_binary_no_harness(self) -> None:
        self.assertEqual(self._run(tmux_path=None, session_live=True), "NO_TUI")

    def test_control_negativo_a_relative_tmux_path_is_refused(self) -> None:
        # Un `command -v` que devuelve algo que no es una ruta absoluta no se ejecuta jamas.
        self.assertEqual(self._run(tmux_path="tmux", session_live=True), "NO_TUI")


class DerivedArgvTest(unittest.TestCase):
    """El argv derivado tiene que ser JSON valido y de SOLO LECTURA."""

    def test_the_launcher_builds_a_read_only_attach(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        start = text.index("harness_command=$(CAUCE_TMUX_PATH=")
        snippet = text[start:text.index("|| die", start)]
        self.assertIn("attach-session", snippet)
        # `-r` es el candado real: sin el, mirar la TUI seria poder teclear en ella.
        self.assertIn('"-r"', snippet)
        # `-f ignore-size` evita que el navegador le encoja el panel al humano que trabaja ahi.
        self.assertIn('"ignore-size"', snippet)

        one_liner = snippet[snippet.index("import json"):]
        one_liner = one_liner[:one_liner.index("]))") + len("]))")]
        done = subprocess.run(
            ["python3", "-c", one_liner],
            capture_output=True,
            text=True,
            env={
                "CAUCE_TMUX_PATH": "/usr/bin/tmux",
                "CAUCE_TMUX_SOCKET": "cauce",
                "CAUCE_TMUX_SESSION": "cauce-zeus",
                "PATH": "/usr/bin:/bin",
            },
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(
            json.loads(done.stdout),
            ["/usr/bin/tmux", "-L", "cauce", "attach-session", "-r", "-f", "ignore-size", "-t", "cauce-zeus"],
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
