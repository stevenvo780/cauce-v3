from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# cauce:requiere none

ROOT = Path(__file__).resolve().parents[2]
PROGRAM = ROOT / "ops/instances/hospital/praxis-proof.py"
SPEC = importlib.util.spec_from_file_location("praxis_proof", PROGRAM)
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)


class PraxisProofTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.files = {"GOAL.md": "Synthetic goal\n", "AGENTS.md": "Synthetic instructions\n",
                      "README.md": "Synthetic README\n", "apps/api/server.py": "value = 1\n",
                      "apps/api/store.py": "value = 2\n", "apps/api/backup_crypto.py": "value = 3\n",
                      "apps/api/test_backup_crypto.py": "import unittest\nclass TestSynthetic(unittest.TestCase):\n def test_synthetic(self): self.assertTrue(True)\n", "apps/web/app.js": "const x = 1;\n",
                      "apps/web/app.css": "body { margin: 0; }\n", "apps/web/index.html": "<p>synthetic</p>\n",
                      "scripts/qa_professional.py": "print('synthetic')\n",
                      "scripts/qa_browser_fixture.py": "print('synthetic')\n"}
        for name, content in self.files.items():
            path = self.workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.verification = self.workspace / PROOF.VERIFICATION
        self.verification.parent.mkdir(parents=True)
        self.previous = {"schema_version": 2, "status": "pending", "accepted_issues": ["PRAX-002"],
                         "human_tracking": {"receipt": "synthetic-human-receipt"}, "gates": []}
        PROOF.write_json(self.verification, self.previous)
        self.git("init", "-q")
        self.git("config", "user.email", "synthetic@example.test")
        self.git("config", "user.name", "Synthetic Fixture")
        self.git("add", *self.files, PROOF.VERIFICATION)
        self.git("commit", "-qm", "Synthetic fixture")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.args = argparse.Namespace(workspace=self.workspace, output=self.root / "output",
                                       artifact_prefix="docs/evidence/synthetic-proof", commit=self.commit,
                                       timeout=30, qa=False, install_evidence=False)

    def git(self, *arguments):
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.workspace), *arguments],
                                capture_output=True, text=True, check=True)
        return result.stdout

    def run_proof(self, commands=None):
        selected = commands or [["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "apps/api", "-p", "test_*.py"],
                                ["/usr/bin/python3", "-c", "print('synthetic actual result')"]]
        with mock.patch.object(PROOF, "test_commands", return_value=selected):
            return PROOF.generate(self.args, "synthetic producer invocation")

    def read(self, name):
        return json.loads((self.args.output / name).read_text())

    def test_success_produces_fresh_source_bound_artifacts(self):
        self.assertEqual(self.run_proof(), 0)
        report = self.read("proof.json")
        self.assertEqual(report["status"], "technical-progress")
        self.assertNotIn("accepted_issues", report)
        self.assertTrue(report["independent_review_pending"])
        self.assertFalse(report["qa_executed"])
        self.assertEqual(report["source_commit"], self.commit)
        self.assertEqual(set(report["source_files"]), set(self.files))
        for gate in report["gates"]:
            if gate["id"] in {"build", "typecheck"}:
                self.assertEqual(gate["outcome"], "not-applicable")
                self.assertTrue(gate["reason"])
                continue
            self.assertEqual(gate["source_files"], report["source_files"])
            for artifact in gate["artifacts"]:
                path = self.args.output / Path(artifact["path"]).name
                self.assertEqual(artifact["sha256"], PROOF.digest(path))
                artifact_report = self.read(path.name)
                self.assertEqual(artifact_report["gate_id"], gate["id"])
                self.assertEqual(artifact_report["source_files"], gate["source_files"])
                self.assertEqual(artifact_report["command"], gate["command"])
        self.assertEqual(self.read("tests.json")["actual_results"]["count"], 1)
        row = self.read("tests.json")["results"][-1]
        self.assertEqual(row["exit_code"], 0)
        self.assertIn("synthetic actual result", row["stdout"])
        self.assertGreaterEqual(row["duration_seconds"], 0)

    def test_failed_command_never_emits_passed_tests(self):
        self.assertEqual(self.run_proof([["/usr/bin/python3", "-c", "import sys; print('synthetic failure'); sys.exit(7)"]]), 1)
        self.assertEqual(self.read("tests.json")["exit_code"], 7)
        self.assertEqual(self.read("tests.json")["status"], "failed")
        self.assertEqual(self.read("proof.json")["status"], "failed")

    def test_untracked_credentials_never_enter_isolated_clone_or_environment(self):
        (self.workspace / ".env").write_text("SYNTHETIC_SECRET=private-test-only\n")
        code = "import os; from pathlib import Path; assert not Path('.env').exists(); assert 'SYNTHETIC_SECRET' not in os.environ; print('isolated')"
        with mock.patch.dict(os.environ, {"SYNTHETIC_SECRET": "private-test-only"}):
            self.assertEqual(self.run_proof([["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "apps/api", "-p", "test_*.py"],
                                            ["/usr/bin/python3", "-c", code]]), 0)
        self.assertNotIn("private-test-only", (self.args.output / "tests.json").read_text())

    def install_output(self):
        return PROOF.install_evidence(self.workspace, self.args.output, self.args.artifact_prefix,
                                      self.read("proof.json"), PROOF.child_environment(self.root))


    def test_install_preserves_acceptance_and_only_writes_metadata(self):
        before = PROOF.source_hashes(self.workspace, list(self.files))
        human_gate = {"id": "clinical-approval", "outcome": "pending", "receipt": "synthetic tracking"}
        self.previous["gates"].append(human_gate)
        PROOF.write_json(self.verification, self.previous)
        self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 0)
        installed = json.loads(self.verification.read_text())
        self.assertEqual(installed["accepted_issues"], self.previous["accepted_issues"])
        self.assertEqual(installed["human_tracking"], self.previous["human_tracking"])
        self.assertIn(human_gate, installed["gates"])
        self.assertEqual(installed["status"], "technical-progress")
        self.assertEqual(installed["source_commit"], self.commit)
        self.assertEqual(PROOF.source_hashes(self.workspace, list(self.files)), before)
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.commit)
        for name in ("tests.json", "snapshot.json"):
            destination = self.workspace / self.args.artifact_prefix / name
            self.assertEqual(destination.read_bytes(), (self.args.output / name).read_bytes())
        qa = next(gate for gate in installed["gates"] if gate["id"] == "qa")
        self.assertEqual(qa["outcome"], "pending")

    def test_install_rejects_failed_tests_without_writing(self):
        self.assertEqual(self.run_proof([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]), 1)
        original = self.verification.read_bytes()
        with self.assertRaisesRegex(PROOF.ProofError, "tests_or_snapshot_not_passed"):
            self.install_output()
        self.assertEqual(self.verification.read_bytes(), original)

if __name__ == "__main__":
    unittest.main()
