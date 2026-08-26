"""Derivacion segura del modo harness desde la tmux viva del alias.

El test extrae la funcion del launcher real y modela sus sondas Docker. Una TUI anunciada debe
acreditar el id estable de tmux, los marcadores alias+harness, la ventana exacta y un panel vivo.
El nombre cauce-<alias> por si solo nunca acredita identidad porque puede reutilizarse.
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
harness=claude
container_id=deadbeef
runtime_uid=1000
runtime_gid=1000
TMUX_SOCKET=${CAUCE_PTY_TMUX_SOCKET:-cauce}
"""

EPILOGUE = r"""
TMUX_PATH_FOUND=''
TMUX_SESSION_FOUND=''
TMUX_TARGET_FOUND=''
TMUX_PANE_CWD_FOUND=''
TMUX_MEASUREMENT_CONFLICT=0
if derive_harness_command; then
  printf 'DERIVED %s %s %s %s\n' "$TMUX_PATH_FOUND" "$TMUX_SESSION_FOUND" "$TMUX_TARGET_FOUND" "$TMUX_PANE_CWD_FOUND"
else
  printf 'NO_TUI conflict=%s path=%s\n' "$TMUX_MEASUREMENT_CONFLICT" "$TMUX_PATH_FOUND"
fi
"""


def _function_source() -> str:
    """La funcion tal como esta hoy en el launcher desplegable."""
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index("derive_harness_command() {")
    end = text.index("\n}\n", start) + len("\n}\n")
    return text[start:end]


def _fake_docker(
    tmp: pathlib.Path,
    *,
    tmux_path: str | None,
    session_live: bool,
    session_id: str = "$7",
    marker_alias: str = "zeus",
    marker_harness: str = "claude",
    tui_live: bool = True,
    pane_alive: bool = True,
    pane_cwd: str = "/workspace/repo",
    window_panes: int = 1,
    duplicate_tui: bool = False,
) -> pathlib.Path:
    """Docker falso para las sondas de identidad, ventana y panel de tmux."""
    script = tmp / "docker"
    body = [
        "#!/usr/bin/env bash",
        'args="$*"',
        f"expected_id='{session_id}'",
        'if [[ $args == *"command -v tmux"* ]]; then',
    ]
    if tmux_path is None:
        body += ["  exit 1"]
    else:
        body += [f"  printf '%s\\n' '{tmux_path}'", "  exit 0"]
    body += [
        "fi",
        'if [[ $args == *list-windows* ]]; then',
        '  [[ $args == *"-t cauce-zeus"* ]] || exit 88',
        "  [[ $args == *$'#{session_name}\\t#{session_id}\\t#{window_name}\\t#{window_panes}\\t#{@cauce_alias}\\t#{@cauce_harness}\\t#{pane_pid}\\t#{pane_dead}\\t#{pane_current_path}'* ]] || exit 89",
        "  exit 1" if not session_live else
        f"  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t4321\\t%s\\t%s\\n' 'cauce-zeus' '{session_id}' '{'tui' if tui_live else 'legacy'}' '{window_panes}' '{marker_alias}' '{marker_harness}' '{'0' if pane_alive else '1'}' '{pane_cwd}'",
        f"  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t4322\\t0\\t%s\\n' 'cauce-zeus' '{session_id}' 'tui' '1' '{marker_alias}' '{marker_harness}' '{pane_cwd}'"
        if session_live and duplicate_tui else "  :",
        "  exit 0",
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
            done = subprocess.run(
                ["bash", "-c", PRELUDE + _function_source() + EPILOGUE],
                capture_output=True,
                text=True,
                env={"PATH": "/usr/bin:/bin", "FAKE_DOCKER": str(fake)},
                check=False,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            return done.stdout.strip()

    def test_a_verified_live_tmux_yields_its_stable_id_and_exact_window(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True),
            "DERIVED /usr/bin/tmux $7 $7:tui /workspace/repo",
        )

    def test_control_negativo_no_session_no_harness(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=False),
            "NO_TUI conflict=0 path=/usr/bin/tmux",
        )

    def test_control_negativo_no_tmux_binary_no_harness(self) -> None:
        self.assertEqual(self._run(tmux_path=None, session_live=True), "NO_TUI conflict=0 path=")

    def test_control_negativo_a_relative_tmux_path_is_refused(self) -> None:
        self.assertEqual(self._run(tmux_path="tmux", session_live=True), "NO_TUI conflict=0 path=")

    def test_control_negativo_rejects_a_mutable_name_instead_of_session_id(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, session_id="cauce-zeus"),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_an_alias_marker_mismatch(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, marker_alias="kant"),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_a_harness_marker_mismatch(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, marker_harness="codex"),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_missing_identity_markers(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, marker_alias=""),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_requires_the_exact_tui_window(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, tui_live=False),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_a_dead_tui_pane(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, pane_alive=False),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_a_multi_pane_tui_window(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, window_panes=2),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_duplicate_tui_windows_from_one_observation(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, duplicate_tui=True),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )

    def test_control_negativo_rejects_a_noncanonical_pane_cwd(self) -> None:
        self.assertEqual(
            self._run(tmux_path="/usr/bin/tmux", session_live=True, pane_cwd="/workspace/../etc"),
            "NO_TUI conflict=1 path=/usr/bin/tmux",
        )


class DynamicDescriptorTest(unittest.TestCase):
    """El launcher publica capacidad; la identidad se resuelve de nuevo en cada OPEN."""

    def test_the_launcher_builds_only_a_path_and_socket_descriptor(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        start = text.index("tmux_tui=$(CAUCE_TMUX_PATH=")
        snippet = text[start:text.index("|| die", start)]
        self.assertNotIn("attach-session", snippet)
        self.assertNotIn("CAUCE_TMUX_TARGET", snippet)

        one_liner = snippet[snippet.index("import json"):]
        one_liner = one_liner[:one_liner.index(")))") + len(")))")]
        done = subprocess.run(
            ["python3", "-c", one_liner],
            capture_output=True,
            text=True,
            env={
                "CAUCE_TMUX_PATH": "/usr/bin/tmux",
                "CAUCE_TMUX_SOCKET": "cauce",
                "PATH": "/usr/bin:/bin",
            },
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), {"path": "/usr/bin/tmux", "socket": "cauce"})

    def test_the_bundle_contains_the_dynamic_tmux_descriptor(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        self.assertIn('"tmux_tui": commands(os.environ["CAUCE_PTY_BUNDLE_TMUX_TUI"]', text)

    def test_a_discovered_binary_is_published_even_before_the_session_exists(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        publish = text[text.index("publish_bundle() {"):text.index("start_agent() {")]
        derive_at = publish.index("derive_harness_command")
        descriptor_guard_at = publish.index('if [[ -n $TMUX_PATH_FOUND ]]')
        descriptor_at = publish.index("tmux_tui=$(CAUCE_TMUX_PATH=")
        self.assertLess(derive_at, descriptor_guard_at)
        self.assertLess(descriptor_guard_at, descriptor_at)
        self.assertNotIn("TMUX_SESSION_FOUND ]]", publish[descriptor_guard_at:descriptor_at])

    def test_explicit_harness_command_skips_dynamic_tmux_and_pane_measurement(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        publish = text[text.index("publish_bundle() {"):text.index("start_agent() {")]
        explicit_guard = publish.index('if [[ -z $harness_command ]]')
        derive = publish.index("derive_harness_command", explicit_guard)
        facts = publish.index("runtime_facts=$(measure_adapter_runtime_facts)", derive)
        self.assertIn("TMUX_PANE_CWD_FOUND=''", publish[:explicit_guard])
        self.assertLess(explicit_guard, derive)
        self.assertLess(derive, facts)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
