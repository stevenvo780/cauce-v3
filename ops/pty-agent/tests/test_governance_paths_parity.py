"""Parity between the agent path table and the generated governance contract.

The pty-agent cannot import TypeScript, so it keeps its own copy of the harness table. What is
proved here is that the copy still says the same thing as
`ops/schemas/contexto-de-gobierno.json`, which
`ops/scripts/generar-contexto-de-gobierno.mjs` emits from `@cauce/protocol`. A rename of a runtime
fact, a document added to a harness, or a harness added to the protocol lands as a red here
instead of as a document the console offers and the agent refuses.
"""
from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402  (sys.path.insert deliberado arriba)

CONTRACT_PATH = AGENT_DIR.parent / "schemas" / "contexto-de-gobierno.json"
CODEX_READ_ONLY_DOCUMENT = "AGENTS.override.md"


def _contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


class GovernancePathsParityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = self.temp_dir.name
        self.contract = _contract()
        self.harnesses = self.contract["arneses"]

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _bundle_for(self, harness: str) -> tuple[dict, str]:
        """Build the bundle from the contract, so a renamed fact fails instead of degrading."""
        fact = self.harnesses[harness]["raiz"]["hecho"]
        root = f"{self.home}/raiz-{harness}"
        if fact == "home":
            return {"home": root, "harness": harness, "runtime_facts": {"cwd": root}}, root
        return {"home": self.home, "harness": harness, "runtime_facts": {fact: root}}, root

    def _instance_for(self, harness: str) -> tuple[agent.PtyAgent, str]:
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle, root = self._bundle_for(harness)
        return instance, root

    def test_contract_declares_the_four_harnesses_with_their_documents(self) -> None:
        self.assertEqual(sorted(self.harnesses), ["claude", "codex", "hermes", "openclaw"])
        self.assertEqual(
            sorted(self.harnesses["openclaw"]["documentos"]),
            ["AGENTS.md", "HEARTBEAT.md", "IDENTITY.md", "MEMORY.md", "SOUL.md", "TOOLS.md",
             "USER.md"],
        )

    def test_writable_profile_paths_match_the_contract_harness_by_harness(self) -> None:
        for harness, declared in sorted(self.harnesses.items()):
            with self.subTest(harness=harness):
                instance, root = self._instance_for(harness)
                expected = frozenset(f"{root}/{name}" for name in declared["documentos"])
                self.assertEqual(instance._profile_governance_file_paths(), expected)
                self.assertTrue(expected, "an empty declared table would prove nothing")

    def test_openclaw_writes_the_seven_declared_files(self) -> None:
        instance, root = self._instance_for("openclaw")
        paths = instance._profile_governance_file_paths()
        self.assertEqual(len(paths), 7)
        self.assertEqual(
            paths,
            frozenset(f"{root}/{name}" for name in self.harnesses["openclaw"]["documentos"]),
        )

    def test_codex_override_is_readable_and_never_writable(self) -> None:
        instance, root = self._instance_for("codex")
        override = f"{root}/{CODEX_READ_ONLY_DOCUMENT}"
        self.assertNotIn(CODEX_READ_ONLY_DOCUMENT, self.harnesses["codex"]["documentos"])
        self.assertNotIn(override, instance._profile_governance_file_paths())
        self.assertFalse(instance._is_writable_governance_file_path(override))
        self.assertIn(override, instance._readable_global_governance_file_paths())

    def test_readable_paths_add_nothing_beyond_the_codex_override(self) -> None:
        for harness in sorted(self.harnesses):
            with self.subTest(harness=harness):
                instance, root = self._instance_for(harness)
                writable = instance._profile_governance_file_paths()
                extra = instance._readable_global_governance_file_paths() - writable
                self.assertEqual(
                    extra,
                    {f"{root}/{CODEX_READ_ONLY_DOCUMENT}"} if harness == "codex" else set(),
                )

    def test_control_negativo_a_harness_outside_the_contract_has_no_paths(self) -> None:
        """Without this, a table that returned every path for every name would look green."""
        for harness in ("", "otro", "gpt", "claude-code", "openclaw2"):
            with self.subTest(harness=harness):
                instance = agent.PtyAgent.__new__(agent.PtyAgent)
                instance.bundle = {
                    "home": self.home, "harness": harness,
                    "runtime_facts": {"claude_config_dir": f"{self.home}/.claude"},
                }
                self.assertEqual(instance._profile_governance_file_paths(), frozenset())
                self.assertEqual(instance._readable_global_governance_file_paths(), frozenset())

    def test_control_negativo_facts_are_required_for_every_declared_harness(self) -> None:
        """Recovery shells publish `{}` facts: no profile path may be inferred from a default."""
        for harness in sorted(self.harnesses):
            with self.subTest(harness=harness):
                instance = agent.PtyAgent.__new__(agent.PtyAgent)
                instance.bundle = {"home": self.home, "harness": harness, "runtime_facts": {}}
                self.assertEqual(instance._profile_governance_file_paths(), frozenset())


if __name__ == "__main__":
    unittest.main()
