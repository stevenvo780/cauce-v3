from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import cauce_pty_agent as agent  # noqa: E402  (sys.path.insert deliberado arriba)
from cauce_pty_agent import governance_paths  # noqa: E402

CONTRACT_PATH = AGENT_DIR.parent / "schemas" / "contexto-de-gobierno.json"
PUBLISHED_CONTRACT_PATH = (
    AGENT_DIR / "cauce_pty_agent" / governance_paths.GOVERNANCE_CONTRACT_FILENAME
)


class GovernanceAllowlistsLiteralTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = self.temp_dir.name

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_never_serve_constants_come_from_the_generated_contract(self) -> None:
        """Python against the generated artifact, not against another Python literal.

        `ops/scripts/generar-contexto-de-gobierno.mjs` emits the contract from
        `packages/protocol/src/governance-documents.ts`, so this compares the agent against the
        TypeScript source. A name that only one of the two legs knows is a credential leak.
        """
        contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))["nunca_servir"]
        self.assertEqual(agent.NEVER_SERVE_BASENAMES, frozenset(contract["basenames"]))
        self.assertEqual(agent.NEVER_SERVE_SUFFIXES, tuple(contract["sufijos"]))
        self.assertTrue(contract["basenames"] and contract["sufijos"])

    def test_the_published_contract_is_byte_identical_to_the_generated_one(self) -> None:
        """The copy that travels inside the package is a distribution artifact, not a source."""
        self.assertEqual(PUBLISHED_CONTRACT_PATH.read_bytes(), CONTRACT_PATH.read_bytes())

    def test_a_missing_contract_fails_closed_instead_of_serving_everything(self) -> None:
        absent = (pathlib.Path(self.home) / "no-existe.json",)
        with mock.patch.object(governance_paths, "_CONTRACT_CANDIDATES", absent):
            with self.assertRaises(governance_paths.GovernanceContractError):
                governance_paths._load_governance_contract()

    def test_a_malformed_or_empty_contract_fails_closed(self) -> None:
        broken = pathlib.Path(self.home) / "roto.json"
        for body in ("", "[]", '{"nunca_servir": {}}', '{"nunca_servir": {"basenames": [],'
                     ' "sufijos": [".pem"]}}', '{"nunca_servir": {"basenames": [1],'
                     ' "sufijos": [".pem"]}}'):
            with self.subTest(body=body):
                broken.write_text(body, encoding="utf-8")
                with mock.patch.object(governance_paths, "_CONTRACT_CANDIDATES", (broken,)):
                    with self.assertRaises(governance_paths.GovernanceContractError):
                        governance_paths._never_serve_names(
                            governance_paths._load_governance_contract(), "basenames",
                        )

    def test_profile_governance_paths_pinned_by_literal_per_harness(self) -> None:
        claude_config = f"{self.home}/.claude"
        codex_home = f"{self.home}/.codex"
        openclaw_workspace = f"{self.home}/workspace"

        instance = agent.PtyAgent.__new__(agent.PtyAgent)

        # 1. Claude -> {"CLAUDE.md"}
        instance.bundle = {
            "home": self.home,
            "harness": "claude",
            "runtime_facts": {"claude_config_dir": claude_config},
        }
        self.assertEqual(
            instance._profile_governance_file_paths(),
            frozenset({f"{claude_config}/CLAUDE.md"}),
        )

        # 2. Codex -> {"AGENTS.md"}
        instance.bundle = {
            "home": self.home,
            "harness": "codex",
            "runtime_facts": {"codex_home": codex_home},
        }
        self.assertEqual(
            instance._profile_governance_file_paths(),
            frozenset({f"{codex_home}/AGENTS.md"}),
        )

        # 3. Hermes -> {"AGENTS.md"}
        instance.bundle = {
            "home": self.home,
            "harness": "hermes",
            "runtime_facts": {"cwd": self.home},
        }
        self.assertEqual(
            instance._profile_governance_file_paths(),
            frozenset({f"{self.home}/AGENTS.md"}),
        )

        # 4. OpenClaw -> {"SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"}
        instance.bundle = {
            "home": self.home,
            "harness": "openclaw",
            "runtime_facts": {"openclaw_workspace": openclaw_workspace},
        }
        openclaw_literals = {
            "SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md",
            "TOOLS.md", "MEMORY.md", "HEARTBEAT.md",
        }
        expected_openclaw = frozenset(f"{openclaw_workspace}/{name}" for name in openclaw_literals)
        self.assertEqual(instance._profile_governance_file_paths(), expected_openclaw)

        # 5. Unsupported harness -> frozenset()
        instance.bundle = {
            "home": self.home,
            "harness": "other",
            "runtime_facts": {"claude_config_dir": claude_config},
        }
        self.assertEqual(instance._profile_governance_file_paths(), frozenset())

    def test_readable_global_governance_paths_pinned_by_literal_per_harness(self) -> None:
        claude_config = f"{self.home}/.claude"
        codex_home = f"{self.home}/.codex"
        openclaw_workspace = f"{self.home}/workspace"

        instance = agent.PtyAgent.__new__(agent.PtyAgent)

        # 1. Claude
        instance.bundle = {
            "home": self.home,
            "harness": "claude",
            "runtime_facts": {"claude_config_dir": claude_config},
        }
        self.assertEqual(
            instance._readable_global_governance_file_paths(),
            frozenset({f"{claude_config}/CLAUDE.md"}),
        )

        # 2. Codex (includes AGENTS.override.md)
        instance.bundle = {
            "home": self.home,
            "harness": "codex",
            "runtime_facts": {"codex_home": codex_home},
        }
        self.assertEqual(
            instance._readable_global_governance_file_paths(),
            frozenset({f"{codex_home}/AGENTS.md", f"{codex_home}/AGENTS.override.md"}),
        )

        # 3. Hermes
        instance.bundle = {
            "home": self.home,
            "harness": "hermes",
            "runtime_facts": {"cwd": self.home},
        }
        self.assertEqual(
            instance._readable_global_governance_file_paths(),
            frozenset({f"{self.home}/AGENTS.md"}),
        )

        # 4. OpenClaw
        instance.bundle = {
            "home": self.home,
            "harness": "openclaw",
            "runtime_facts": {"openclaw_workspace": openclaw_workspace},
        }
        openclaw_literals = {
            "SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md",
            "TOOLS.md", "MEMORY.md", "HEARTBEAT.md",
        }
        expected_openclaw = frozenset(f"{openclaw_workspace}/{name}" for name in openclaw_literals)
        self.assertEqual(instance._readable_global_governance_file_paths(), expected_openclaw)

    def test_non_governance_document_rejected_with_exact_reason(self) -> None:
        claude_config = f"{self.home}/.claude"
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle = {
            "home": self.home,
            "harness": "claude",
            "runtime_facts": {"claude_config_dir": claude_config},
        }

        for name in ("settings.json", "config.yaml", "other.md", "CLAUDE.json"):
            path = f"{claude_config}/{name}"
            write_err = instance._validate_write_shape(path)
            self.assertEqual(write_err, ("permission_denied", f"{name} is not a governance document"))

            read_err = instance._validate_read_path(path, "file")
            self.assertEqual(read_err, ("permission_denied", f"{name} is not a governance document"))

    def test_never_serve_document_rejected_with_exact_reason(self) -> None:
        claude_config = f"{self.home}/.claude"
        instance = agent.PtyAgent.__new__(agent.PtyAgent)
        instance.bundle = {
            "home": self.home,
            "harness": "claude",
            "runtime_facts": {"claude_config_dir": claude_config},
        }

        for basename in agent.NEVER_SERVE_BASENAMES:
            path = f"{claude_config}/{basename}"
            write_err = instance._validate_write_shape(path)
            self.assertEqual(write_err, ("permission_denied", f"{basename} is never served"))

            read_err = instance._validate_read_path(path, "file")
            self.assertEqual(read_err, ("permission_denied", f"{basename} is never served"))

        for suffix in agent.NEVER_SERVE_SUFFIXES:
            path = f"{claude_config}/cert{suffix}"
            write_err = instance._validate_write_shape(path)
            self.assertEqual(write_err, ("permission_denied", "looks like credential material"))

            read_err = instance._validate_read_path(path, "file")
            self.assertEqual(read_err, ("permission_denied", "looks like credential material"))


if __name__ == "__main__":
    unittest.main()
