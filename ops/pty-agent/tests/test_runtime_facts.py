#!/usr/bin/env python3
"""Runtime profile paths come from the live alias adapter, never from HOME guesses."""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER = AGENT_DIR / "cauce-pty-launcher.sh"
REPO = AGENT_DIR.parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402


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
adapter_generation=$TEST_GENERATION
state_directory=$TEST_STATE
container_home=$TEST_HOME
harness=$TEST_HARNESS
runtime_uid=$(id -u)
runtime_gid=$(id -g)
container_id=local-test-container
TMUX_PANE_CWD_FOUND=${TEST_TMUX_CWD:-}
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
        self.workspace = pathlib.Path(self.temporary.name) / "workspace"
        self.workspace.mkdir()
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

    def _spawn_adapter(
        self,
        facts: dict[str, str],
        *,
        cwd: pathlib.Path | None = None,
        alias: str | None = None,
        generation: str | None = None,
        home: pathlib.Path | None = None,
    ) -> None:
        effective_home = home or self.home
        environment = {
            "PATH": "/usr/bin:/bin",
            "CAUCE_ALIAS": alias or self.alias,
            "CAUCE_CONTAINER_GENERATION": generation or self.generation,
            "CAUCE_STATE_DIR": self.state,
            "HOME": str(effective_home),
            **facts,
        }
        self.processes.append(subprocess.Popen(
            ["/bin/sleep", "30"], env=environment, cwd=cwd or self.workspace,
        ))

    def _measure(self, harness: str, *, tmux_cwd: pathlib.Path | None = None) -> str:
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
                **({} if tmux_cwd is None else {"TEST_TMUX_CWD": str(tmux_cwd)}),
            },
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout.strip()

    def _measured(self, harness: str, *, tmux_cwd: pathlib.Path | None = None) -> dict[str, object] | None:
        output = self._measure(harness, tmux_cwd=tmux_cwd)
        if output == "FAIL":
            return None
        self.assertTrue(output.startswith("OK "), output)
        return json.loads(output.removeprefix("OK "))

    def test_codex_home_is_measured_from_the_matching_live_adapter(self) -> None:
        codex_home = self.home / ".cauce" / self.alias / ".codex"
        codex_home.mkdir(parents=True)
        self._spawn_adapter({"CODEX_HOME": str(codex_home)})
        self.assertEqual(self._measured("codex"), {
            "codex_home": str(codex_home),
            "project_doc_max_bytes": 32768,
            "project_doc_fallback_filenames": [],
            "cwd": str(self.workspace),
            "project_root": str(self.workspace),
        })

    def test_codex_instruction_knobs_are_projected_from_the_measured_profile_only(self) -> None:
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text(
            'project_doc_max_bytes = 65536\nproject_doc_fallback_filenames = ["TEAM.md", "LOCAL.md"]\n',
            encoding="utf-8",
        )
        self._spawn_adapter({"CODEX_HOME": str(codex_home)})
        measured = self._measured("codex")
        self.assertIsNotNone(measured)
        assert measured is not None
        self.assertEqual(measured["project_doc_max_bytes"], 65536)
        self.assertEqual(measured["project_doc_fallback_filenames"], ["TEAM.md", "LOCAL.md"])

    def test_unsafe_codex_instruction_knobs_are_omitted_without_losing_path_facts(self) -> None:
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text(
            'project_doc_max_bytes = 65536\nproject_doc_fallback_filenames = ["SECRET.PEM"]\n',
            encoding="utf-8",
        )
        self._spawn_adapter({"CODEX_HOME": str(codex_home)})
        measured = self._measured("codex")
        self.assertIsNotNone(measured)
        assert measured is not None
        self.assertEqual(measured["codex_home"], str(codex_home))
        self.assertNotIn("project_doc_max_bytes", measured)
        self.assertNotIn("project_doc_fallback_filenames", measured)

    def test_required_profile_path_missing_degrades_to_empty_facts(self) -> None:
        self._spawn_adapter({})
        self.assertEqual(self._measured("claude"), {})

    def test_ambiguous_live_adapter_profiles_degrade_to_empty_facts(self) -> None:
        first = self.home / ".cauce" / self.alias / "codex-one"
        second = self.home / ".cauce" / self.alias / "codex-two"
        first.mkdir(parents=True)
        second.mkdir(parents=True)
        self._spawn_adapter({"CODEX_HOME": str(first)})
        self._spawn_adapter({"CODEX_HOME": str(second)})
        self.assertEqual(self._measured("codex"), {})

    def test_symlinked_profile_root_degrades_to_empty_facts(self) -> None:
        real = self.home / ".cauce" / self.alias / "real-codex"
        link = self.home / ".cauce" / self.alias / "linked-codex"
        real.mkdir(parents=True)
        link.symlink_to(real, target_is_directory=True)
        self._spawn_adapter({"CODEX_HOME": str(link)})
        self.assertEqual(self._measured("codex"), {})

    def test_zero_matching_adapter_processes_degrade_to_empty_facts(self) -> None:
        self.assertEqual(self._measured("codex"), {})

    def test_publish_never_promotes_unmeasured_optional_facts_to_a_permanent_exit(self) -> None:
        text = LAUNCHER.read_text(encoding="utf-8")
        publish = text[text.index("publish_bundle() {"):text.index("start_agent() {")]
        assignment = publish.index("runtime_facts=$(measure_adapter_runtime_facts)")
        self.assertNotIn("|| die", publish[assignment:assignment + 120])

    def test_hermes_has_no_invented_profile_fact(self) -> None:
        self._spawn_adapter({})
        self.assertEqual(self._measured("hermes"), {
            "cwd": str(self.workspace), "project_root": str(self.workspace),
        })

    def test_shared_workspace_and_live_pane_override_the_adapter_cwd(self) -> None:
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        mount = self.workspace / "mount"
        project = mount / "repo"
        pane = project / "packages" / "api"
        pane.mkdir(parents=True)
        (project / ".git").mkdir()
        adapter_cwd = self.workspace / "adapter-parent"
        adapter_cwd.mkdir()
        self._spawn_adapter({
            "CODEX_HOME": str(codex_home),
            "CAUCE_SHARED_SESSION_WORKSPACE": str(mount),
        }, cwd=adapter_cwd)

        self.assertEqual(self._measured("codex", tmux_cwd=pane), {
            "codex_home": str(codex_home),
            "project_doc_max_bytes": 32768,
            "project_doc_fallback_filenames": [],
            "cwd": str(pane),
            "workspace_root": str(mount),
            "project_root": str(project),
        })

    def test_shared_workspace_without_marker_uses_exact_pane_as_project_root(self) -> None:
        claude = self.home / ".claude"
        claude.mkdir()
        pane = self.workspace / "mount" / "nested"
        pane.mkdir(parents=True)
        self._spawn_adapter({
            "CLAUDE_CONFIG_DIR": str(claude),
            "CAUCE_SHARED_SESSION_WORKSPACE": str(self.workspace / "mount"),
        }, cwd=self.workspace)
        measured = self._measured("claude", tmux_cwd=pane)
        self.assertEqual(measured and measured["project_root"], str(pane))

    def test_shared_workspace_without_a_pane_preserves_a_compatible_process_cwd(self) -> None:
        """Also covers explicit HARNESS_COMMAND, which deliberately skips the tmux probe."""
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        root = self.workspace / "shared"
        process_cwd = root / "repo" / "packages"
        process_cwd.mkdir(parents=True)
        (root / "repo" / ".git").mkdir()
        self._spawn_adapter({
            "CODEX_HOME": str(codex_home), "CAUCE_SHARED_SESSION_WORKSPACE": str(root),
        }, cwd=process_cwd)

        self.assertEqual(self._measured("codex"), {
            "codex_home": str(codex_home),
            "project_doc_max_bytes": 32768,
            "project_doc_fallback_filenames": [],
            "cwd": str(process_cwd),
            "workspace_root": str(root),
            "project_root": str(root / "repo"),
        })

    def test_shared_workspace_without_a_pane_never_fabricates_workspace_as_cwd(self) -> None:
        claude = self.home / ".claude"
        claude.mkdir()
        root = self.workspace / "shared"
        root.mkdir()
        process_cwd = self.workspace / "adapter-outside"
        process_cwd.mkdir()
        self._spawn_adapter({
            "CLAUDE_CONFIG_DIR": str(claude), "CAUCE_SHARED_SESSION_WORKSPACE": str(root),
        }, cwd=process_cwd)

        self.assertEqual(self._measured("claude"), {"claude_config_dir": str(claude)})

    def test_shared_pane_outside_the_accredited_workspace_fails_closed(self) -> None:
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        root = self.workspace / "root"
        root.mkdir()
        outside = self.workspace / "sibling"
        outside.mkdir()
        self._spawn_adapter({
            "CODEX_HOME": str(codex_home), "CAUCE_SHARED_SESSION_WORKSPACE": str(root),
        })
        self.assertEqual(self._measured("codex", tmux_cwd=outside), {})

    def test_symlinked_or_root_workspace_fails_closed(self) -> None:
        claude = self.home / ".claude"
        claude.mkdir()
        real = self.workspace / "real"
        real.mkdir()
        link = self.workspace / "linked"
        link.symlink_to(real, target_is_directory=True)
        self._spawn_adapter({
            "CLAUDE_CONFIG_DIR": str(claude), "CAUCE_SHARED_SESSION_WORKSPACE": str(link),
        })
        self.assertEqual(self._measured("claude"), {})

    def test_other_alias_and_generation_with_the_same_home_do_not_supply_cwd(self) -> None:
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        target = self.workspace / "target"
        sibling = self.workspace / "sibling"
        target.mkdir()
        sibling.mkdir()
        self._spawn_adapter({"CODEX_HOME": str(codex_home)}, cwd=sibling, alias="other-alias")
        self._spawn_adapter({"CODEX_HOME": str(codex_home)}, cwd=sibling, generation="other-generation")
        self._spawn_adapter({"CODEX_HOME": str(codex_home)}, cwd=target)
        measured = self._measured("codex")
        self.assertEqual(measured and measured["cwd"], str(target))

    def test_two_matching_one_shot_processes_with_different_cwd_fail_closed(self) -> None:
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        first = self.workspace / "first"
        second = self.workspace / "second"
        first.mkdir()
        second.mkdir()
        self._spawn_adapter({"CODEX_HOME": str(codex_home)}, cwd=first)
        self._spawn_adapter({"CODEX_HOME": str(codex_home)}, cwd=second)
        self.assertEqual(self._measured("codex"), {})


class AdapterGenerationParityTest(unittest.TestCase):
    """Measurement matches the adapter by the generation the SUPERVISOR stamps, not the ticket one.

    The launcher's own generation is a 32-char prefix over three `|`-joined fields; the supervisor's
    is the full digest over four NUL-joined fields. Comparing them never matched, so every
    measurement was empty and profile writes answered 503 for every alias.
    """

    def test_launcher_recomputes_the_supervisor_generation_formula(self) -> None:
        launcher = LAUNCHER.read_text(encoding="utf-8")
        supervisor = (REPO / "ops/scripts/container-adapter-supervisor.sh").read_text(encoding="utf-8")
        # The supervisor's formula, verbatim, is the one the launcher must reproduce.
        formula = """printf '%s\\0%s\\0%s\\0%s'"""
        self.assertIn(formula, supervisor, "supervisor generation formula moved")
        self.assertIn(formula, launcher, "launcher must recompute the supervisor generation formula")
        # And the measurement must pass THAT value, never the launcher's own ticket generation.
        self.assertIn('CAUCE_PTY_MEASURE_GENERATION=$adapter_generation', launcher)
        self.assertNotIn('CAUCE_PTY_MEASURE_GENERATION=$container_generation', launcher)

    def test_supervisor_stamps_the_launcher_ticket_generation_for_the_adapter(self) -> None:
        """The reverse direction of the same parity, and the one that kept aliases silent.

        The console only ever observes the presence the relay reports, so the expectation row --
        and every contract sealed into a delivery -- carries the launcher's 32-char ticket
        generation. An adapter that only knew the supervisor's NUL-joined digest rejected all of
        them with "belongs to another runtime generation". The supervisor therefore recomputes the
        launcher's formula and exports it, so the adapter knows both names of its own incarnation.
        """
        launcher = LAUNCHER.read_text(encoding="utf-8")
        supervisor = (REPO / "ops/scripts/container-adapter-supervisor.sh").read_text(encoding="utf-8")
        ticket_formula = """printf '%s|%s|%s'"""
        self.assertIn(ticket_formula, launcher, "launcher ticket generation formula moved")
        self.assertIn(ticket_formula, supervisor, "supervisor must recompute the ticket formula")
        self.assertIn("container_generation=${digest:0:32}", launcher)
        self.assertIn(
            "container_presence_generation=${container_presence_generation:0:32}", supervisor
        )
        self.assertIn(
            "CAUCE_CONTAINER_PRESENCE_GENERATION=$container_presence_generation", supervisor
        )

    def test_the_two_generations_are_computed_from_the_same_container_facts(self) -> None:
        launcher = LAUNCHER.read_text(encoding="utf-8")
        # Both digests read id/started/restart from the same inspect; only the adapter form adds the
        # init start time. A launcher that stopped tracking either field could not rebuild the match.
        self.assertIn('container_started=$started', launcher)
        self.assertIn('container_restart=$restart', launcher)
        self.assertIn('/proc/1/stat', launcher)


class RuntimeFactsBundleValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temporary.name)
        self.home = root / "home"
        self.codex_home = self.home / ".codex"
        self.cwd = root / "workspace"
        self.home.mkdir()
        self.codex_home.mkdir()
        self.cwd.mkdir()
        self.paths: dict[str, object] = {
            "codex_home": str(self.codex_home),
            "cwd": str(self.cwd),
            "project_root": str(self.cwd),
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _validate(self, extra: dict[str, object], harness: str = "codex") -> dict[str, object]:
        return agent._runtime_facts_config(
            {**self.paths, **extra}, harness, str(self.home),
        )

    def test_valid_codex_instruction_pair_crosses_the_bundle(self) -> None:
        result = self._validate({
            "project_doc_max_bytes": 16777216,
            "project_doc_fallback_filenames": ["TEAM.md", "LOCAL.md"],
        })
        self.assertEqual(result["project_doc_max_bytes"], 16777216)
        self.assertEqual(result["project_doc_fallback_filenames"], ["TEAM.md", "LOCAL.md"])

    def test_partial_or_badly_typed_instruction_pair_is_omitted_but_paths_survive(self) -> None:
        cases = (
            {"project_doc_max_bytes": 32768},
            {"project_doc_fallback_filenames": []},
            {"project_doc_max_bytes": True, "project_doc_fallback_filenames": []},
            {"project_doc_max_bytes": 0, "project_doc_fallback_filenames": []},
            {"project_doc_max_bytes": 16777217, "project_doc_fallback_filenames": []},
            {"project_doc_max_bytes": 32768, "project_doc_fallback_filenames": "TEAM.md"},
            {"project_doc_max_bytes": 32768, "project_doc_fallback_filenames": ["x"] * 17},
        )
        for raw in cases:
            with self.subTest(raw=raw):
                result = self._validate(raw)
                self.assertEqual(result["codex_home"], str(self.codex_home))
                self.assertNotIn("project_doc_max_bytes", result)
                self.assertNotIn("project_doc_fallback_filenames", result)

    def test_unsafe_or_duplicate_fallback_basename_omits_the_whole_pair(self) -> None:
        unsafe = (
            "", ".", "..", "../TEAM.md", "nested/TEAM.md", "nested\\TEAM.md", "bad\0name",
            "bad\x1fname", "bad\x7fname", "AGENTS.md", "AGENTS.override.md", ".env",
            ".credentials.json", "secret.pem", "SECRET.PEM", "private.key", "private.KEY",
            "AUTH.JSON", "Agents.MD",
        )
        for name in unsafe:
            with self.subTest(name=repr(name)):
                result = self._validate({
                    "project_doc_max_bytes": 32768,
                    "project_doc_fallback_filenames": [name],
                })
                self.assertNotIn("project_doc_max_bytes", result)
                self.assertNotIn("project_doc_fallback_filenames", result)
        duplicate = self._validate({
            "project_doc_max_bytes": 32768,
            "project_doc_fallback_filenames": ["TEAM.md", "TEAM.md"],
        })
        self.assertNotIn("project_doc_fallback_filenames", duplicate)

    def test_codex_knobs_on_another_harness_are_omitted(self) -> None:
        result = self._validate({
            "project_doc_max_bytes": 32768,
            "project_doc_fallback_filenames": ["TEAM.md"],
        }, harness="claude")
        self.assertNotIn("project_doc_max_bytes", result)
        self.assertNotIn("project_doc_fallback_filenames", result)

    def test_disappeared_optional_path_facts_do_not_raise_a_permanent_error(self) -> None:
        missing = pathlib.Path(self.temporary.name) / "gone"
        self.assertEqual(agent._runtime_facts_config({"cwd": str(missing)}, "codex", str(self.home)), {})

    def test_codex_fallbacks_are_exact_read_only_project_candidates_after_standard_names(self) -> None:
        instance = object.__new__(agent.PtyAgent)
        instance.bundle = {
            "home": str(self.home),
            "harness": "codex",
            "runtime_facts": self._validate({
                "project_doc_max_bytes": 32768,
                "project_doc_fallback_filenames": ["TEAM.md", "LOCAL.md"],
            }),
        }
        self.assertEqual(instance._project_manual_paths(), (
            f"{self.cwd}/AGENTS.override.md", f"{self.cwd}/AGENTS.md",
            f"{self.cwd}/TEAM.md", f"{self.cwd}/LOCAL.md",
        ))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
