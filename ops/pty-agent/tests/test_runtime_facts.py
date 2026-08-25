#!/usr/bin/env python3
"""Runtime profile paths come from the live alias adapter, never from HOME guesses."""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid


LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / "cauce-pty-launcher.sh"


def _function_source(name: str) -> str:
    text = LAUNCHER.read_text(encoding="utf-8")
    start = text.index(f"{name}() {{")
    # This function embeds Python dictionaries in a heredoc, so the first textual `}\n` is not
    # the Bash function terminator. Its next top-level function is a stable extraction boundary.
    boundary = "\n}\n\npublish_bundle() {"
    end = text.index(boundary, start) + len("\n}\n")
    return text[start:end]


PRELUDE = r"""
set -uo pipefail
docker_control() {
  local -a measured_env=()
  [[ $1 == exec ]] || return 90
  shift
  while (( $# > 0 )); do
    case $1 in
      -i) shift ;;
      --user) shift 2 ;;
      --env) measured_env+=("$2"); shift 2 ;;
      *) break ;;
    esac
  done
  [[ $# -ge 3 ]] || return 91
  shift
  env "${measured_env[@]}" "$@"
}
alias_name=$TEST_ALIAS
container_generation=$TEST_GENERATION
state_directory=$TEST_STATE
container_home=$TEST_HOME
harness=$TEST_HARNESS
runtime_uid=$(id -u)
runtime_gid=$(id -g)
container_id=local-test-container
"""

EPILOGUE = r"""
if measured=$(measure_adapter_runtime_facts); then
  printf 'OK %s\n' "$measured"
else
  printf 'FAIL\n'
fi
"""


class RuntimeFactsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temporary.name) / "home"
        self.home.mkdir()
        unique = uuid.uuid4().hex
        self.alias = f"runtime-facts-{unique}"
        self.generation = unique
        self.state = str(self.home / ".cauce" / self.alias)
        self.processes: list[subprocess.Popen[bytes]] = []

    def tearDown(self) -> None:
        for process in self.processes:
            process.terminate()
        for process in self.processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        self.temporary.cleanup()

    def _spawn_adapter(self, facts: dict[str, str]) -> None:
        environment = {
            "PATH": "/usr/bin:/bin",
            "CAUCE_ALIAS": self.alias,
            "CAUCE_CONTAINER_GENERATION": self.generation,
            "CAUCE_STATE_DIR": self.state,
            "HOME": str(self.home),
            **facts,
        }
        self.processes.append(subprocess.Popen(["/bin/sleep", "30"], env=environment))

    def _measure(self, harness: str) -> str:
        script = PRELUDE + _function_source("measure_adapter_runtime_facts") + EPILOGUE
        completed = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            env={
                "PATH": "/usr/bin:/bin",
                "TEST_ALIAS": self.alias,
                "TEST_GENERATION": self.generation,
                "TEST_STATE": self.state,
                "TEST_HOME": str(self.home),
                "TEST_HARNESS": harness,
            },
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout.strip()

    def test_codex_home_is_measured_from_the_matching_live_adapter(self) -> None:
        codex_home = self.home / ".cauce" / self.alias / ".codex"
        codex_home.mkdir(parents=True)
        self._spawn_adapter({"CODEX_HOME": str(codex_home)})
        self.assertEqual(self._measure("codex"), f'OK {{"codex_home":"{codex_home}"}}')

    def test_required_profile_path_missing_fails_closed(self) -> None:
        self._spawn_adapter({})
        self.assertEqual(self._measure("claude"), "FAIL")

    def test_ambiguous_live_adapter_profiles_fail_closed(self) -> None:
        first = self.home / ".cauce" / self.alias / "codex-one"
        second = self.home / ".cauce" / self.alias / "codex-two"
        first.mkdir(parents=True)
        second.mkdir(parents=True)
        self._spawn_adapter({"CODEX_HOME": str(first)})
        self._spawn_adapter({"CODEX_HOME": str(second)})
        self.assertEqual(self._measure("codex"), "FAIL")

    def test_symlinked_profile_root_fails_closed(self) -> None:
        real = self.home / ".cauce" / self.alias / "real-codex"
        link = self.home / ".cauce" / self.alias / "linked-codex"
        real.mkdir(parents=True)
        link.symlink_to(real, target_is_directory=True)
        self._spawn_adapter({"CODEX_HOME": str(link)})
        self.assertEqual(self._measure("codex"), "FAIL")

    def test_hermes_has_no_invented_profile_fact(self) -> None:
        self._spawn_adapter({})
        self.assertEqual(self._measure("hermes"), "OK {}")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
