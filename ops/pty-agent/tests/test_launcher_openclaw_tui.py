#!/usr/bin/env python3
"""La TUI nativa de OpenClaw, derivada DENTRO del contenedor y solo si de verdad esta.

POR QUE HACE FALTA OTRA DERIVACION
----------------------------------
La TUI que hoy emiten 7 alias es el panel tmux de la SESION COMPARTIDA, y la sesion compartida
existe solo para `claude` y `codex` (`SharedSessionHarness = Extract<HarnessId, "claude" |
"codex">`). Los alias `openclaw` y `hermes` no la tienen, no levantan `cauce-<alias>` en tmux, y
por eso `derive_harness_command` devuelve vacio para siempre y la consola dice «Sin TUI que
emitir». No es una linea de configuracion que falte: es estructural.

OpenClaw si trae una TUI propia (`openclaw tui --session <key>`), y es un CLIENTE del gateway que
ese alias ya corre. O sea que no hace falta tmux, ni una imagen nueva, ni un proceso supervisado
mas: se lanza en el pty del agente como cualquier otro `harness_command`.

LO QUE ESTA PRUEBA EXIGE, Y POR QUE CADA COSA
---------------------------------------------
Todo se mide DENTRO del contenedor y como el usuario del alias, y cualquier duda deja al alias
sin modo `harness` (que es como esta hoy). En concreto:

  * `node` con ruta ABSOLUTA. El envoltorio `openclaw` re-ejecuta y deja su argv en «openclaw» a
    secas —por eso el supervisor del gateway tampoco lo usa—, asi que se invoca la entrada real.
  * La entrada de openclaw tiene que EXISTIR.
  * La version instalada tiene que tener el subcomando `tui` y aceptar `--session`. Se le pregunta
    al binario, no a la memoria: openclaw se actualiza solo y el dia que cambie el flag, esto deja
    de anunciar la TUI en vez de anunciar una pantalla vacia.
  * La sesion NO se elige al arrancar: el bundle lleva el state directory confiable y el agente
    resuelve su pointer durable en cada OPEN.

Cada caso positivo va con su CONTROL NEGATIVO, porque el fallo caro aca no es quedarse sin TUI:
es ANUNCIAR una que abre en negro. Eso manda al operador a mirar una pantalla vacia y a creer que
el agente esta colgado.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile
import unittest

LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / "cauce-pty-launcher.sh"

PRELUDE = r"""
set -uo pipefail
die() { printf '%s\n' "$1" >&2; exit "${2:-2}"; }
die_transient() { printf '%s\n' "$1" >&2; exit 75; }
valid_absolute_path() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [[ $1 != *'//'* && $1 != */../* && $1 != */./* && $1 != */.. && $1 != */. ]]
}
docker_control() { "$FAKE_DOCKER" "$@"; }
alias_name=jarvis
container_id=deadbeef
container_home=/home/claw
state_directory=/home/claw/.openclaw/cauce-v3/jarvis
harness=openclaw
runtime_uid=1000
runtime_gid=1000
declare -A CONFIG=()
OPENCLAW_ENTRY=''
OPENCLAW_HISTORY_LIMIT=200
"""

EPILOGUE = r"""
OPENCLAW_NODE_FOUND=''
if derive_openclaw_tui_command; then
  printf 'DERIVED %s\n' "$OPENCLAW_NODE_FOUND"
else
  printf 'NO_TUI\n'
fi
"""


def _function_source(name: str) -> str:
    """La funcion tal como esta HOY en el lanzador desplegable, no una copia pegada aca."""
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index(f"{name}() {{")
    end = text.index("\n}\n", start) + len("\n}\n")
    return text[start:end]


def _fake_docker(
    tmp: pathlib.Path,
    *,
    node_path: str | None = "/usr/bin/node",
    entry_present: bool = True,
    tui_help: str | None = "Usage: openclaw tui [--session <key>] [--history-limit <n>]",
) -> pathlib.Path:
    """Un `docker` que sabe contestar exactamente las tres sondas de capacidad."""
    script = tmp / "docker"
    body = ["#!/usr/bin/env bash", 'args="$*"']

    body += ['if [[ $args == *"command -v node"* ]]; then']
    body += ["  exit 1"] if node_path is None else [f"  printf '{node_path}\\n'", "  exit 0"]
    body += ["fi"]

    body += ['if [[ $args == *"test -f"* ]]; then']
    body += ["  exit 0" if entry_present else "  exit 1"]
    body += ["fi"]

    body += ['if [[ $args == *"tui --help"* ]]; then']
    body += ["  exit 1"] if tui_help is None else [f"  printf '%s\\n' {json.dumps(tui_help)}", "  exit 0"]
    body += ["fi"]

    body += ["exit 97"]
    script.write_text("\n".join(body) + "\n", encoding="utf-8")
    script.chmod(0o755)
    return script


class DeriveOpenClawTuiTest(unittest.TestCase):
    def _run(self, **kwargs: object) -> str:
        with tempfile.TemporaryDirectory() as raw:
            tmp = pathlib.Path(raw)
            fake = _fake_docker(tmp, **kwargs)  # type: ignore[arg-type]
            script = PRELUDE + _function_source("derive_openclaw_tui_command") + EPILOGUE
            done = subprocess.run(
                ["bash", "-c", script],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin", "FAKE_DOCKER": str(fake)},
                check=False,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            return done.stdout.strip()

    def test_a_live_openclaw_yields_capability_without_freezing_a_session(self) -> None:
        self.assertEqual(self._run(), "DERIVED /usr/bin/node")

    def test_the_user_local_installation_is_the_first_bounded_candidate(self) -> None:
        text = _function_source("derive_openclaw_tui_command")
        local_entry = '${container_home%/}/.openclaw/node_modules/openclaw/dist/index.js'
        self.assertIn(local_entry, text)
        self.assertLess(text.index(local_entry), text.index('/usr/lib/node_modules/openclaw/dist/index.js'))

    def test_an_explicit_dist_dir_is_allowlisted_and_wins_over_fallbacks(self) -> None:
        launcher = LAUNCHER.read_text(encoding="utf-8")
        self.assertIn('SHELL_CANDIDATES|OPENCLAW_DIST_DIR)', launcher)
        function = _function_source("derive_openclaw_tui_command")
        self.assertIn('entry_candidates+=("${configured_dist%/}/index.js")', function)

    def test_control_negativo_sin_node_no_hay_tui(self) -> None:
        self.assertEqual(self._run(node_path=None), "NO_TUI")

    def test_control_negativo_un_node_relativo_no_se_ejecuta(self) -> None:
        # `command -v` que no devuelve una ruta absoluta jamas se ejecuta.
        self.assertEqual(self._run(node_path="node"), "NO_TUI")

    def test_control_negativo_sin_la_entrada_de_openclaw_no_hay_tui(self) -> None:
        self.assertEqual(self._run(entry_present=False), "NO_TUI")

    def test_control_negativo_una_version_sin_subcomando_tui_no_se_anuncia(self) -> None:
        # `tui --help` falla: esta version no tiene la TUI. Anunciarla abriria una pantalla en negro.
        self.assertEqual(self._run(tui_help=None), "NO_TUI")

    def test_control_negativo_una_tui_que_no_acepta_session_no_se_anuncia(self) -> None:
        # El subcomando existe pero el flag cambio de nombre: se le pregunta al binario instalado,
        # porque openclaw se actualiza solo y la memoria de nadie es la fuente.
        self.assertEqual(
            self._run(tui_help="Usage: openclaw tui [--conversation <key>]"),
            "NO_TUI",
        )

class DerivedOpenClawArgvTest(unittest.TestCase):
    """El bundle lleva un resolver, nunca el native id congelado."""

    def test_the_launcher_builds_a_dynamic_resolver_without_a_session_key(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        start = text.index("openclaw_tui=$(CAUCE_OPENCLAW_NODE=")
        snippet = text[start:text.index("|| die", start)]
        self.assertIn('"state_directory"', snippet)
        self.assertNotIn("CAUCE_OPENCLAW_SESSION", snippet)
        self.assertNotIn("mtime", snippet)

        one_liner = snippet[snippet.index("import json"):]
        one_liner = one_liner[:one_liner.index("}))") + len("}))")]
        done = subprocess.run(
            ["python3", "-c", one_liner],
            capture_output=True,
            text=True,
            env={
                "CAUCE_OPENCLAW_NODE": "/usr/bin/node",
                "CAUCE_OPENCLAW_ENTRY": "/usr/lib/node_modules/openclaw/dist/index.js",
                "CAUCE_OPENCLAW_STATE": "/home/claw/.openclaw/cauce-v3/jarvis",
                "CAUCE_OPENCLAW_HISTORY": "200",
                "PATH": "/usr/bin:/bin",
            },
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(
            json.loads(done.stdout),
            {
                "node": "/usr/bin/node",
                "entry": "/usr/lib/node_modules/openclaw/dist/index.js",
                "state_directory": "/home/claw/.openclaw/cauce-v3/jarvis",
                "history_limit": 200,
            },
        )

    def test_launcher_logs_never_print_a_native_session_key(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        publish = text[text.index("publish_bundle() {"):text.index("start_agent() {")]
        self.assertNotIn("OPENCLAW_SESSION_FOUND", publish)
        self.assertNotIn("openclaw tui alias=%s session=%s", publish)


class TmuxStillWinsTest(unittest.TestCase):
    """Los 7 alias que hoy emiten su panel tmux no pueden cambiar de camino.

    La derivacion de openclaw es un RESPALDO: solo corre cuando no hay sesion tmux. Si se
    invirtiera el orden, un alias con sesion compartida dejaria de emitir el panel que el humano
    esta mirando y pasaria a emitir otra cosa.
    """

    def test_the_openclaw_probe_runs_only_after_tmux_fails(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        publish = text[text.index("publish_bundle() {"):]
        tmux_at = publish.index("derive_harness_command")
        openclaw_at = publish.index("derive_openclaw_tui_command")
        self.assertLess(
            tmux_at,
            openclaw_at,
            "la sonda de openclaw corre antes que la de tmux: un alias con panel compartido "
            "dejaria de emitir el panel que su dueno esta mirando",
        )

    def test_control_negativo_ambas_sondas_siguen_existiendo(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        self.assertIn("derive_harness_command() {", text)
        self.assertIn("derive_openclaw_tui_command() {", text)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
