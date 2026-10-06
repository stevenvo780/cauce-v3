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

    def test_source_mutation_during_gate_invalidates_snapshot(self):
        mutation = "from pathlib import Path; Path(" + repr(str(self.workspace / "apps/api/store.py")) + ").write_text('value = 99\\n')"
        self.assertEqual(self.run_proof([["/usr/bin/python3", "-c", mutation]]), 1)
        snapshot = self.read("snapshot.json")
        self.assertFalse(snapshot["source_unchanged"])
        self.assertEqual(snapshot["status"], "failed")
        self.assertEqual(self.read("proof.json")["status"], "failed")

    def test_untracked_credentials_never_enter_isolated_clone_or_environment(self):
        (self.workspace / ".env").write_text("SYNTHETIC_SECRET=private-test-only\n")
        code = "import os; from pathlib import Path; assert not Path('.env').exists(); assert 'SYNTHETIC_SECRET' not in os.environ; print('isolated')"
        with mock.patch.dict(os.environ, {"SYNTHETIC_SECRET": "private-test-only"}):
            self.assertEqual(self.run_proof([["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "apps/api", "-p", "test_*.py"],
                                            ["/usr/bin/python3", "-c", code]]), 0)
        self.assertNotIn("private-test-only", (self.args.output / "tests.json").read_text())

    def test_tracked_credentials_are_rejected_before_clone(self):
        (self.workspace / ".env").write_text("synthetic private fixture\n")
        self.git("add", ".env")
        self.git("commit", "-qm", "Synthetic forbidden fixture")
        self.args.commit = self.git("rev-parse", "HEAD").strip()
        with self.assertRaisesRegex(PROOF.ProofError, "non_public_tracked_path"):
            self.run_proof()
        self.assertFalse(self.args.output.exists())

    def test_dirty_sources_and_wrong_commit_are_rejected(self):
        self.args.commit = "b" * 40
        with self.assertRaisesRegex(PROOF.ProofError, "source_commit_mismatch"):
            self.run_proof()
        self.args.commit = self.commit
        (self.workspace / "apps/api/store.py").write_text("value = 99\n")
        with self.assertRaisesRegex(PROOF.ProofError, "tracked_tree_dirty"):
            self.run_proof()

    def test_stale_output_cannot_be_reused(self):
        self.args.output.mkdir()
        (self.args.output / "tests.json").write_text('{"status":"passed"}')
        with self.assertRaisesRegex(PROOF.ProofError, "output_must_be_new"):
            self.run_proof()

    def test_symlink_source_and_escaping_artifact_prefix_are_rejected(self):
        source = self.workspace / "apps/api/store.py"
        source.unlink()
        source.symlink_to(self.root / "private.txt")
        with self.assertRaisesRegex(PROOF.ProofError, "unsafe_source_path"):
            PROOF.source_hashes(self.workspace, ["apps/api/store.py"])
        self.args.artifact_prefix = "../private"
        with self.assertRaisesRegex(PROOF.ProofError, "invalid_artifact_prefix"):
            self.run_proof()

    def test_timeout_is_a_failed_result(self):
        result = PROOF.execute(["/usr/bin/python3", "-c", "import time; time.sleep(3)"], self.workspace,
                               PROOF.child_environment(self.root), 0.05)
        self.assertEqual(result["exit_code"], 124)
        self.assertIn("command_timeout", result["stderr"])

    def test_zero_exit_without_fresh_qa_report_is_not_passed(self):
        self.args.qa = True
        self.assertEqual(self.run_proof(), 1)
        report = self.read("qa.json")
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["exit_code"], 1)
        self.assertIn("qa_report_missing_or_invalid", report["results"][0]["stderr"])
        self.assertEqual(report["inspected_images"], [])
        self.assertFalse(report["review"]["independent"])
        self.assertEqual(self.read("proof.json")["status"], "technical-progress")

    def test_discover_zero_tests_is_not_passed(self):
        selected = [["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "apps/api", "-p", "missing_*.py"]]
        self.assertEqual(self.run_proof(selected), 1)
        report = self.read("tests.json")
        self.assertEqual(report["actual_results"]["count"], 0)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["error"], "no_api_tests_executed")

    def install_output(self):
        return PROOF.install_evidence(self.workspace, self.args.output, self.args.artifact_prefix,
                                      self.read("proof.json"), PROOF.child_environment(self.root))

    def old_qa(self, outcome="passed", stale=False):
        sources = PROOF.source_hashes(self.workspace, list(self.files))
        if stale:
            sources["apps/api/store.py"] = "f" * 64
        path = self.workspace / "docs/evidence/historical/qa.json"
        path.parent.mkdir(parents=True)
        report = {"schema_version": 2, "gate_id": "qa", "status": outcome,
                  "source_commit": self.commit, "source_files": sources, "source_sha256": sources,
                  "command": "synthetic-qa-command", "exit_code": 0 if outcome == "passed" else 1,
                  "runs": [{"status": outcome}], "review": {"independent": False},
                  "error": "synthetic failure" if outcome == "failed" else ""}
        PROOF.write_json(path, report)
        gate = {"id": "qa", "outcome": outcome, "exit_code": report["exit_code"],
                "command": report["command"], "source_commit": self.commit, "source_files": sources,
                "artifacts": [{"path": str(path.relative_to(self.workspace)), "sha256": PROOF.digest(path)}]}
        self.previous["gates"] = [gate]
        PROOF.write_json(self.verification, self.previous)
        return gate

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

    def test_repeated_install_does_not_overwrite_evidence(self):
        self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 0)
        original = self.verification.read_bytes()
        evidence = (self.workspace / self.args.artifact_prefix / "tests.json").read_bytes()
        self.args.output = self.root / "second-output"
        with self.assertRaisesRegex(PROOF.ProofError, "evidence_destination_exists"):
            self.run_proof()
        self.assertEqual(self.verification.read_bytes(), original)
        self.assertEqual((self.workspace / self.args.artifact_prefix / "tests.json").read_bytes(), evidence)

    def test_install_rejects_different_head_without_writing(self):
        self.assertEqual(self.run_proof(), 0)
        self.git("commit", "--allow-empty", "-qm", "Synthetic next head")
        original = self.verification.read_bytes()
        with self.assertRaisesRegex(PROOF.ProofError, "installation_source_mismatch"):
            self.install_output()
        self.assertEqual(self.verification.read_bytes(), original)
        self.assertFalse((self.workspace / self.args.artifact_prefix).exists())

    def test_install_rejects_failed_tests_without_writing(self):
        self.assertEqual(self.run_proof([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]), 1)
        original = self.verification.read_bytes()
        with self.assertRaisesRegex(PROOF.ProofError, "tests_or_snapshot_not_passed"):
            self.install_output()
        self.assertEqual(self.verification.read_bytes(), original)

    def test_uncommitted_new_code_is_rejected(self):
        (self.workspace / "apps/api/new.py").write_text("synthetic = True\n")
        with self.assertRaisesRegex(PROOF.ProofError, "tracked_tree_dirty"):
            self.run_proof()
        self.assertFalse(self.args.output.exists())

    def test_private_prefix_and_symlink_parent_are_rejected(self):
        for prefix in ("docs/evidence/credentials", "docs/evidence/profiles", "docs/evidence/auth.json", "../private"):
            self.args.artifact_prefix = prefix
            with self.assertRaisesRegex(PROOF.ProofError, "invalid_artifact_prefix"):
                self.run_proof()
        self.args.artifact_prefix = "docs/evidence/synthetic-proof"
        self.args.install_evidence = True
        (self.workspace / "docs").symlink_to(self.root / "private")
        with self.assertRaisesRegex(PROOF.ProofError, "unsafe_metadata_path"):
            self.run_proof()

    def test_install_retains_only_current_source_bound_qa(self):
        gate = self.old_qa()
        self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 0)
        installed = json.loads(self.verification.read_text())
        self.assertEqual(next(row for row in installed["gates"] if row["id"] == "qa"), gate)
        self.assertTrue(installed["qa_executed"])
        self.assertTrue(installed["independent_review_pending"])
        self.assertEqual(installed["accepted_issues"], self.previous["accepted_issues"])

    def test_stale_qa_is_pending_with_reason(self):
        self.old_qa(stale=True)
        self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 0)
        installed = json.loads(self.verification.read_text())
        qa = next(row for row in installed["gates"] if row["id"] == "qa")
        self.assertEqual(qa["outcome"], "pending")
        self.assertTrue(qa["reason"])
        self.assertFalse(installed["qa_executed"])

    def test_unbound_transferred_qa_is_not_retained(self):
        gate = self.old_qa()
        gate["transferred_artifacts"] = [{"path": "docs/evidence/missing/qa.json", "sha256": "a" * 64}]
        self.previous["gates"] = [gate]
        PROOF.write_json(self.verification, self.previous)
        self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 0)
        installed = json.loads(self.verification.read_text())
        self.assertEqual(next(row for row in installed["gates"] if row["id"] == "qa")["outcome"], "pending")

    def test_failed_qa_stays_failed(self):
        gate = self.old_qa(outcome="failed")
        self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 0)
        installed = json.loads(self.verification.read_text())
        self.assertEqual(next(row for row in installed["gates"] if row["id"] == "qa"), gate)
        self.assertFalse(installed["qa_executed"])

    def test_fresh_failed_qa_replaces_previous_pass(self):
        self.old_qa()
        self.args.qa = self.args.install_evidence = True
        self.assertEqual(self.run_proof(), 1)
        installed = json.loads(self.verification.read_text())
        qa = next(row for row in installed["gates"] if row["id"] == "qa")
        self.assertEqual(qa["outcome"], "failed")
        self.assertEqual(installed["status"], "technical-progress")
        raw = json.loads((self.workspace / qa["artifacts"][0]["path"]).read_text())
        self.assertIn("qa_report_missing_or_invalid", raw["results"][0]["stderr"])

    def test_output_cannot_shadow_installed_metadata_or_private_directories(self):
        self.args.install_evidence = True
        self.args.output = self.workspace / self.args.artifact_prefix
        with self.assertRaisesRegex(PROOF.ProofError, "output_collides_with_metadata"):
            self.run_proof()
        self.args.output = self.root / "profiles" / "new-output"
        with self.assertRaisesRegex(PROOF.ProofError, "unsafe_output_path"):
            self.run_proof()


if __name__ == "__main__":
    unittest.main()
