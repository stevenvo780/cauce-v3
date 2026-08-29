#!/usr/bin/env python3
"""OpenClaw's native TUI, derived INSIDE the container and only if it actually is.

WHY ANOTHER DERIVATION IS NEEDED
--------------------------------
The TUI emitted today by 7 aliases is the tmux panel of the SHARED SESSION, and the shared session
only exists for `claude` and `codex` (`SharedSessionHarness = Extract<HarnessId, "claude" |
"codex">`). The `openclaw` and `hermes` aliases do not have it; they do not start `cauce-<alias>`
in tmux, and that is why `derive_harness_command` always returns empty and the console says "No TUI
to emit". It is not a missing configuration line: it is structural.

OpenClaw does ship its own TUI (`openclaw tui --session <key>`), and it is a CLIENT of the gateway
that this alias already runs. So there is no need for tmux, a new image, or another supervised
process: it is launched in the agent's pty like any other `harness_command`.

WHAT THIS TEST REQUIRES, AND WHY EACH THING
------------------------------------------
Everything is measured INSIDE the container, as the alias user, and any doubt leaves the alias
without a `harness` mode (as it is today). Specifically:

  * `node` with an ABSOLUTE path. The `openclaw` wrapper re-executes and leaves its argv as just
    "openclaw" —that is why the gateway supervisor does not use it either—, so the real entry is invoked.
  * The openclaw entry MUST EXIST.
  * The installed version MUST have the `tui` subcommand and accept `--session`. The binary is
    asked, not memory: openclaw self-updates, and the day the flag changes, this stops advertising
    the TUI instead of advertising an empty screen.
  * The session is NOT chosen at start: the bundle carries the trusted state directory and the
    agent resolves its durable pointer on every OPEN.

Each positive case is paired with a NEGATIVE CONTROL, because the costly failure here is not
losing the TUI: it is ADVERTISING one that opens black. That sends the operator to look at an
empty screen and believe the agent is stuck.
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
docker_control() {
  if [[ $* == *"/usr/bin/python3 -"* ]]; then
    CAUCE_PTY_OPENCLAW_POINTER_ALIAS=$alias_name \
      CAUCE_PTY_OPENCLAW_POINTER_STATE=$state_directory /usr/bin/python3 -
  else
    "$FAKE_DOCKER" "$@"
  fi
}
alias_name=jarvis
container_id=deadbeef
container_home=/home/claw
state_directory=$TEST_STATE
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
    """The function as it stands TODAY in the deployable launcher, not a copy pasted here."""
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
    """A `docker` that knows how to answer exactly the three capability probes."""
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
    def _run(self, *, pointer: str = "valid", **kwargs: object) -> str:
        with tempfile.TemporaryDirectory() as raw:
            tmp = pathlib.Path(raw)
            state = tmp / "state"
            state.mkdir(mode=0o700)
            canonical = "openclaw:jarvis:shared:jarvis"
            if pointer == "valid":
                body = json.dumps({
                    "version": 1,
                    "sessions": {canonical: {"native_id": "conversation-safe", "initialized": True}},
                })
            elif pointer == "corrupt":
                body = '{not-json'
            elif pointer == "ambiguous":
                value = '{"native_id":"one","initialized":true}'
                body = f'{{"version":1,"sessions":{{"{canonical}":{value},"{canonical}":{value}}}}}'
            elif pointer == "uninitialized":
                body = json.dumps({
                    "version": 1,
                    "sessions": {canonical: {"native_id": "conversation-safe", "initialized": False}},
                })
            elif pointer == "missing":
                body = ""
            else:  # pragma: no cover - helper misuse
                raise AssertionError(pointer)
            if pointer != "missing":
                store = state / "sessions.json"
                store.write_text(body, encoding="utf-8")
                store.chmod(0o600)
            fake = _fake_docker(tmp, **kwargs)  # type: ignore[arg-type]
            script = (
                PRELUDE
                + _function_source("validate_openclaw_tui_pointer")
                + _function_source("derive_openclaw_tui_command")
                + EPILOGUE
            )
            done = subprocess.run(
                ["bash", "-c", script],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin", "FAKE_DOCKER": str(fake), "TEST_STATE": str(state)},
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
        # `command -v` that does not return an absolute path MUST NOT be executed.
        self.assertEqual(self._run(node_path="node"), "NO_TUI")

    def test_control_negativo_sin_la_entrada_de_openclaw_no_hay_tui(self) -> None:
        self.assertEqual(self._run(entry_present=False), "NO_TUI")

    def test_control_negativo_una_version_sin_subcomando_tui_no_se_anuncia(self) -> None:
        # `tui --help` fails: this version has no TUI. Advertising it would open a black screen.
        self.assertEqual(self._run(tui_help=None), "NO_TUI")

    def test_control_negativo_una_tui_que_no_acepta_session_no_se_anuncia(self) -> None:
        # The subcommand exists but the flag renamed: ask the installed binary,
        # because openclaw self-updates and nobody's memory is the source.
        self.assertEqual(
            self._run(tui_help="Usage: openclaw tui [--conversation <key>]"),
            "NO_TUI",
        )

    def test_missing_corrupt_uninitialized_or_ambiguous_pointer_is_not_advertised(self) -> None:
        for pointer in ("missing", "corrupt", "uninitialized", "ambiguous"):
            with self.subTest(pointer=pointer):
                self.assertEqual(self._run(pointer=pointer), "NO_TUI")

    def test_pointer_validator_never_emits_the_native_session_id(self) -> None:
        source = _function_source("validate_openclaw_tui_pointer")
        self.assertNotIn("print(", source)
        self.assertNotIn("printf", source)

class DerivedOpenClawArgvTest(unittest.TestCase):
    """The bundle carries a resolver, never the frozen native id."""

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
    """The 7 aliases that emit their tmux panel today cannot change paths.

    The openclaw derivation is a BACKUP: it only runs when there is no tmux session. If the order
    were inverted, an alias with a shared session would stop emitting the panel the human is
    watching and start emitting something else.
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
