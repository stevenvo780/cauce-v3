from __future__ import annotations

import argparse
import copy
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
SPEC = importlib.util.spec_from_file_location("praxis_qa_review", ROOT / "ops/instances/hospital/praxis-qa-review.py")
REVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REVIEW)
WORKSPACE_OWNER = REVIEW.workspace_owner
EVIDENCE_SPEC = importlib.util.spec_from_file_location("praxis_qa_review_evidence", ROOT / "ops/instances/hospital/praxis-supervision-evidence.py")
EVIDENCE = importlib.util.module_from_spec(EVIDENCE_SPEC)
EVIDENCE_SPEC.loader.exec_module(EVIDENCE)
STATE_SPEC = importlib.util.spec_from_file_location("praxis_qa_review_state", ROOT / "ops/instances/hospital/praxis-supervision-state.py")
STATE = importlib.util.module_from_spec(STATE_SPEC)
STATE_SPEC.loader.exec_module(STATE)


class PraxisQAReviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        if os.geteuid() == 0:
            actor = mock.patch.object(REVIEW, "workspace_owner", return_value=os.geteuid())
            actor.start()
            self.addCleanup(actor.stop)
        self.prefix = "docs/evidence/synthetic-review"
        self.qa_name = self.prefix + "/qa.json"
        self.proof_name = self.prefix + "/proof.json"
        self.verification_name = "verification.json"
        self.files = {"GOAL.md": "Synthetic review goal\n", "apps/web/app.js": "value = 1\n"}
        for name, value in self.files.items():
            self.write(name, value.encode())
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Synthetic Fixture")
        self.git("add", *self.files)
        self.git("commit", "-qm", "Synthetic source")
        self.commit = self.git("rev-parse", "HEAD").strip()
        self.sources = {name: REVIEW.sha256(value.encode()) for name, value in self.files.items()}
        self.captures = []
        for screen in ("desktop", "mobile"):
            name = self.prefix + "/qa/" + screen + ".png"
            value = b"\x89PNG\r\n\x1a\nsynthetic " + screen.encode()
            self.write(name, value)
            self.captures.append({"path": name, "sha256": REVIEW.sha256(value)})
        self.qa = {"schema_version": 2, "gate_id": "qa", "status": "passed", "exit_code": 0,
                   "command": "synthetic executed QA", "source_commit": self.commit, "source_files": self.sources,
                   "source_sha256": self.sources, "author": "synthetic-developer", "author_metadata": {"preserve": True},
                   "runs": [{"status": "passed", "screenshots": self.captures}], "inspected_images": [],
                   "review": {"independent": False, "reviewer": None, "prior_metadata": "retained"}}
        self.write_json(self.qa_name, self.qa)
        qa_hash = REVIEW.sha256(self.path(self.qa_name).read_bytes())
        self.gate = {"id": "qa", "outcome": "passed", "exit_code": 0, "command": self.qa["command"],
                     "source_files": self.sources, "source_commit": self.commit,
                     "artifacts": [{"path": self.qa_name, "sha256": qa_hash}]}
        self.proof = {"schema_version": 2, "status": "technical-progress", "source_commit": self.commit,
                      "source_files": self.sources, "goal_sha256": self.sources["GOAL.md"],
                      "independent_review_pending": True, "gates": [self.gate], "limits": ["Synthetic fixtures only"]}
        self.write_json(self.proof_name, self.proof)
        self.verification = {**copy.deepcopy(self.proof), "accepted_issues": ["SYNTHETIC-001"],
                             "production_clinical_accepted": True, "clinical_accepted": {"receipt": "fixture-only"},
                             "irrelevant_metadata": {"keep": "original"},
                             "supporting_artifacts": [{"path": self.proof_name, "sha256": REVIEW.sha256(self.path(self.proof_name).read_bytes())}]}
        self.verification["gates"].append({"id": "unrelated", "outcome": "pending", "metadata": "preserved"})
        self.write_json(self.verification_name, self.verification)
        self.manifest = {"schema_version": 1, "reviewer": "synthetic-independent-reviewer", "source_commit": self.commit,
                         "qa_sha256": qa_hash, "goal_sha256": self.sources["GOAL.md"], "outcome": "passed",
                         "notes": "Inspected synthetic desktop and mobile layouts with the image tool; controls remain visible.",
                         "inspected": [{**capture, "observations": "Synthetic controls and labels are visible without clipping on this capture."} for capture in self.captures]}
        self.manifest_path = self.root / "review-manifest.json"
        self.manifest_path.write_bytes(REVIEW.encoded(self.manifest))
        self.args = argparse.Namespace(workspace=self.workspace, artifact_prefix=self.prefix,
                                       review_manifest=self.manifest_path, verification_file=self.verification_name)
        self.originals = {name: self.path(name).read_bytes() for name in (self.qa_name, self.proof_name, self.verification_name)}

    def path(self, name):
        return self.workspace / name

    def write(self, name, value):
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)

    def write_json(self, name, value):
        self.write(name, REVIEW.encoded(value))

    def read(self, name):
        return json.loads(self.path(name).read_bytes())

    def git(self, *arguments):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(self.workspace), *arguments],
                              check=True, capture_output=True, text=True).stdout

    def record(self, manifest=None):
        if manifest is not None:
            self.manifest_path.write_bytes(REVIEW.encoded(manifest))
        return REVIEW.record(self.args)

    def unchanged(self):
        for name, value in self.originals.items():
            self.assertEqual(self.path(name).read_bytes(), value, name)
        self.assertEqual(list(self.workspace.glob("**/.praxis-review-*")), [])

    def recovery_required(self, error, written=None):
        self.assertEqual(str(error), "partial_review_update_recovery_required")
        recovery = error.recovery
        self.assertEqual(recovery["written"], written or [self.qa_name])
        self.assertEqual(recovery["verification"], self.verification_name)
        self.assertEqual({entry["path"] for entry in recovery["backups"]}, set(self.originals))
        for entry in recovery["backups"]:
            backup = self.path(entry["backup"])
            self.assertEqual(backup.read_bytes(), self.originals[entry["path"]])
            self.assertEqual(entry["sha256"], REVIEW.sha256(backup.read_bytes()))
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.workspace.glob("**/.praxis-review-stage-*")), [])
        reader = EVIDENCE.EvidenceReader(self.workspace, STATE, lambda commit: commit == self.commit)
        self.assertNotIn("qa", reader.gates(self.read(self.verification_name), source_current=True)["valid"])
        return recovery

    def test_native_producer_contract_reaches_recorded_failed_and_passed_consumer_verdicts(self):
        original_qa_hash = self.gate["artifacts"][0]["sha256"]
        native = REVIEW.PROOF.gate_report("qa", self.qa["command"], self.commit, self.sources,
            [{"exit_code": 0}], runs=copy.deepcopy(self.qa["runs"]),
            review={"independent": False, "reviewer": None}, inspected_images=[])
        self.assertEqual(native["author"], "praxis-proof.py")
        self.assertEqual(native["producer_kind"], "automation")
        self.write_json(self.qa_name, native)
        qa_hash = REVIEW.sha256(self.path(self.qa_name).read_bytes())
        proof, verification = copy.deepcopy(self.proof), copy.deepcopy(self.verification)
        REVIEW.replace_references(proof, self.qa_name, original_qa_hash, qa_hash)
        REVIEW.replace_references(verification, self.qa_name, original_qa_hash, qa_hash)
        old_proof_hash = REVIEW.sha256(self.path(self.proof_name).read_bytes())
        self.write_json(self.proof_name, proof)
        REVIEW.replace_references(verification, self.proof_name, old_proof_hash,
                                 REVIEW.sha256(self.path(self.proof_name).read_bytes()))
        self.write_json(self.verification_name, verification)
        manifest = {**self.manifest, "qa_sha256": qa_hash, "outcome": "failed"}
        self.assertEqual(self.record(manifest)["exit_code"], 1)
        reader = EVIDENCE.EvidenceReader(self.workspace, STATE, lambda commit: commit == self.commit)
        observed = reader.gates(self.read(self.verification_name), source_current=True)
        self.assertNotIn("qa", observed["valid"])
        self.assertEqual(observed["qa_review"]["verdict"]["author"], "praxis-proof.py")
        self.assertEqual(observed["rejections"]["qa"], "independent_visual_review_failed")
        current_hash = REVIEW.sha256(self.path(self.qa_name).read_bytes())
        self.assertEqual(self.record({**manifest, "qa_sha256": current_hash, "outcome": "passed"})["exit_code"], 0)
        observed = reader.gates(self.read(self.verification_name), source_current=True)
        self.assertIn("qa", observed["valid"])
        self.assertNotIn("verdict", observed["qa_review"])

    def test_manifest_requires_explicit_notes_identity_and_all_hash_bound_inspections(self):
        invalid = [{**self.manifest, "notes": "approve all"}, {**self.manifest, "reviewer": ""},
                   {**self.manifest, "inspected": []}, {**self.manifest, "inspected": self.manifest["inspected"][:1]},
                   {**self.manifest, "inspected": [self.manifest["inspected"][0]] * 2},
                   {**self.manifest, "inspected": [{"path": capture["path"], "observations": "Approved"} for capture in self.captures]}]
        for manifest in invalid:
            with self.subTest(manifest=manifest), self.assertRaises(REVIEW.ReviewError):
                self.record(manifest)
            self.unchanged()

    def test_author_cannot_review_their_own_qa(self):
        with self.assertRaisesRegex(REVIEW.ReviewError, "independence_mismatch"):
            self.record({**self.manifest, "reviewer": self.qa["author"]})
        self.unchanged()

    def test_symlink_hardlink_and_writable_paths_are_rejected(self):
        capture = self.path(self.captures[0]["path"])
        original = capture.read_bytes()
        outside = self.root / "outside.png"
        outside.write_bytes(original)
        capture.unlink()
        capture.symlink_to(outside)
        with self.assertRaisesRegex(REVIEW.PROOF.ProofError, "unsafe_metadata_path"):
            self.record()
        capture.unlink()
        os.link(outside, capture)
        with self.assertRaisesRegex(REVIEW.ReviewError, "unsafe_file_metadata"):
            self.record()
        capture.unlink()
        capture.write_bytes(original)
        capture.chmod(0o666)
        with self.assertRaisesRegex(REVIEW.ReviewError, "unsafe_file_metadata"):
            self.record()
        self.unchanged()

    def test_partial_write_failure_preserves_private_original_backups_and_rejects_qa(self):
        replace = REVIEW.os.replace
        failed = False

        def fail_proof(source, destination):
            nonlocal failed
            if Path(destination) == self.path(self.proof_name) and not failed:
                failed = True
                raise OSError("synthetic replacement failure")
            return replace(source, destination)

        with mock.patch.object(REVIEW.os, "replace", side_effect=fail_proof), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        recovery = self.recovery_required(failure.exception)
        self.assertEqual(recovery["cause"], "synthetic replacement failure")
        self.assertNotEqual(self.path(self.qa_name).read_bytes(), self.originals[self.qa_name])
        self.assertEqual(self.path(self.proof_name).read_bytes(), self.originals[self.proof_name])
        self.assertEqual(self.path(self.verification_name).read_bytes(), self.originals[self.verification_name])

if __name__ == "__main__":
    unittest.main()
