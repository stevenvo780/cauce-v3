from __future__ import annotations

import argparse
import contextlib
import copy
import fcntl
import importlib.util
import io
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

    def test_performed_manifest_records_every_image_and_preserves_approval_fields(self):
        result = self.record()
        qa, proof, verification = (self.read(name) for name in (self.qa_name, self.proof_name, self.verification_name))
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse(result["current_validity"]["independent_review_pending"])
        self.assertEqual(qa["review"]["reviewer"], self.manifest["reviewer"])
        self.assertTrue(qa["review"]["independent"])
        self.assertTrue(qa["review"]["performed"])
        self.assertEqual(qa["review"]["qa_sha256"], self.manifest["qa_sha256"])
        self.assertEqual(qa["review"]["prior_metadata"], "retained")
        self.assertEqual({image["path"] for image in qa["inspected_images"]}, {image["path"] for image in self.captures})
        for name in ("accepted_issues", "production_clinical_accepted", "clinical_accepted", "irrelevant_metadata"):
            self.assertEqual(verification[name], self.verification[name])
        self.assertEqual(verification["gates"][1], self.verification["gates"][1])
        self.assertEqual(verification["status"], "technical-progress")
        self.assertFalse(proof["independent_review_pending"])
        for document in (proof, verification):
            self.assertEqual(document["gates"][0]["artifacts"][0]["sha256"], result["hashes"][self.qa_name])
        self.assertEqual(verification["supporting_artifacts"][0]["sha256"], result["hashes"][self.proof_name])
        self.assertEqual(list(self.workspace.glob("**/.praxis-review-*")), [])

    def test_failed_actual_review_is_recorded_and_remains_pending(self):
        manifest = {**self.manifest, "outcome": "failed", "notes": "Synthetic mobile capture clips the save control; inspected with the image tool."}
        result = self.record(manifest)
        self.assertEqual(result["exit_code"], 1)
        self.assertTrue(result["current_validity"]["independent_review_pending"])
        self.assertEqual(self.read(self.qa_name)["review"]["outcome"], "failed")
        self.assertFalse(self.read(self.qa_name)["review"]["independent"])
        self.assertTrue(self.read(self.qa_name)["review"]["performed"])
        self.assertEqual(self.read(self.qa_name)["status"], "passed")
        self.assertTrue(self.read(self.verification_name)["production_clinical_accepted"])

    def test_passed_record_is_accepted_by_official_evidence_reader(self):
        self.record()
        reader = EVIDENCE.EvidenceReader(self.workspace, STATE, lambda commit: commit == self.commit)
        observed = reader.gates(self.read(self.verification_name), source_current=True)
        self.assertTrue(observed["qa_executed"])
        self.assertIn("qa", observed["valid"])
        self.assertNotIn("qa", observed["rejections"])

    def test_failed_record_can_never_approve_qa_in_official_evidence_reader(self):
        result = self.record({**self.manifest, "outcome": "failed"})
        reader = EVIDENCE.EvidenceReader(self.workspace, STATE, lambda commit: commit == self.commit)
        observed = reader.gates(self.read(self.verification_name), source_current=True)
        self.assertEqual(result["exit_code"], 1)
        self.assertTrue(observed["qa_executed"])
        self.assertIsNotNone(observed["qa_review"])
        self.assertNotIn("qa", observed["valid"])
        self.assertEqual(observed["rejections"]["qa"], "independent_visual_review_pending")

    def test_metadata_only_head_advance_is_allowed(self):
        self.write("notes.md", b"Synthetic metadata\n")
        self.git("add", "notes.md")
        self.git("commit", "-qm", "Metadata only")
        self.assertNotEqual(self.git("rev-parse", "HEAD").strip(), self.commit)
        self.assertEqual(self.record()["exit_code"], 0)

    def test_actor_guard_rejects_root_and_foreign_workspace_owner(self):
        for owner in (0, self.workspace.stat().st_uid + 1):
            with self.subTest(owner=owner), mock.patch.object(REVIEW.os, "geteuid", return_value=owner):
                with self.assertRaisesRegex(REVIEW.ReviewError, "normal_workspace_owner_required"):
                    WORKSPACE_OWNER(self.workspace)

    def test_no_proof_file_and_default_verification_path_are_supported(self):
        self.path(self.proof_name).unlink()
        self.verification.pop("supporting_artifacts")
        self.write_json(REVIEW.PROOF.VERIFICATION, self.verification)
        self.args.verification_file = REVIEW.PROOF.VERIFICATION
        result = self.record()
        self.assertEqual(set(result["hashes"]), {self.qa_name, REVIEW.PROOF.VERIFICATION})
        self.assertFalse(self.path(self.proof_name).exists())

    def test_manifest_requires_explicit_notes_identity_and_all_hash_bound_inspections(self):
        invalid = [{**self.manifest, "notes": "approve all"}, {**self.manifest, "reviewer": ""},
                   {**self.manifest, "inspected": []}, {**self.manifest, "inspected": self.manifest["inspected"][:1]},
                   {**self.manifest, "inspected": [self.manifest["inspected"][0]] * 2},
                   {**self.manifest, "inspected": [{"path": capture["path"], "observations": "Approved"} for capture in self.captures]}]
        for manifest in invalid:
            with self.subTest(manifest=manifest), self.assertRaises(REVIEW.ReviewError):
                self.record(manifest)
            self.unchanged()

    def test_manifest_cannot_carry_acceptance_or_clinical_flags(self):
        for key in ("accepted_issues", "production_clinical_accepted", "accepted", "independent"):
            with self.subTest(key=key), self.assertRaisesRegex(REVIEW.ReviewError, "invalid_review_manifest"):
                self.record({**self.manifest, key: True})
            self.unchanged()

    def test_author_cannot_review_their_own_qa(self):
        with self.assertRaisesRegex(REVIEW.ReviewError, "independence_mismatch"):
            self.record({**self.manifest, "reviewer": self.qa["author"]})
        self.unchanged()

    def test_expected_qa_goal_and_source_bindings_are_required(self):
        for key, value in (("qa_sha256", "a" * 64), ("goal_sha256", "b" * 64), ("source_commit", "c" * 40)):
            with self.subTest(key=key), self.assertRaisesRegex(REVIEW.ReviewError, "binding_or_independence_mismatch"):
                self.record({**self.manifest, key: value})
            self.unchanged()

    def test_capture_bytes_hash_and_existence_are_validated(self):
        path = self.path(self.captures[0]["path"])
        value = path.read_bytes()
        path.write_bytes(b"altered synthetic capture")
        with self.assertRaisesRegex(REVIEW.ReviewError, "capture_hash_mismatch"):
            self.record()
        self.unchanged()
        path.write_bytes(value)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.record()
        self.unchanged()

    def test_foreign_capture_and_unbound_assertion_are_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["inspected"][0]["path"] = "docs/evidence/foreign/screen.png"
        with self.assertRaisesRegex(REVIEW.ReviewError, "invalid_inspected_capture"):
            self.record(manifest)
        self.unchanged()

    def test_uncommitted_source_and_goal_changes_are_rejected(self):
        for name in self.files:
            original = self.path(name).read_bytes()
            self.path(name).write_bytes(original + b"changed\n")
            with self.subTest(name=name), self.assertRaisesRegex(REVIEW.ReviewError, "source_hash_mismatch"):
                self.record()
            self.unchanged()
            self.path(name).write_bytes(original)

    def test_committed_code_advance_makes_old_qa_stale(self):
        self.write("apps/web/app.js", b"value = 2\n")
        self.git("add", "apps/web/app.js")
        self.git("commit", "-qm", "Changed code")
        with self.assertRaisesRegex(REVIEW.ReviewError, "source_hash_mismatch"):
            self.record()
        self.unchanged()

    def test_hashes_cannot_claim_uncommitted_or_foreign_commit_bytes(self):
        self.write("apps/web/app.js", b"value = 2\n")
        changed = REVIEW.sha256(self.path("apps/web/app.js").read_bytes())
        self.qa["source_files"]["apps/web/app.js"] = changed
        self.write_json(self.qa_name, self.qa)
        with self.assertRaisesRegex(REVIEW.ReviewError, "commit_source_mismatch"):
            self.record()
        self.path("apps/web/app.js").write_bytes(self.files["apps/web/app.js"].encode())
        self.qa["source_commit"] = "d" * 40
        self.write_json(self.qa_name, self.qa)
        with self.assertRaisesRegex(REVIEW.ReviewError, "foreign_source_commit"):
            self.record()

    def test_failed_qa_cannot_be_reviewed_into_passed_evidence(self):
        self.qa.update(status="failed", exit_code=1)
        self.write_json(self.qa_name, self.qa)
        with self.assertRaisesRegex(REVIEW.ReviewError, "qa_not_passed_or_bound"):
            self.record()

    def test_source_dirty_in_index_is_rejected_even_if_working_bytes_match(self):
        original = self.path("apps/web/app.js").read_bytes()
        self.write("apps/web/app.js", b"value = 3\n")
        self.git("add", "apps/web/app.js")
        self.write("apps/web/app.js", original)
        with self.assertRaisesRegex(REVIEW.ReviewError, "uncommitted_source"):
            self.record()
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

    def test_persistent_proof_lock_blocks_concurrent_installation(self):
        with tempfile.TemporaryDirectory() as home:
            descriptor = REVIEW.PROOF.installation_lock(self.workspace, REVIEW.PROOF.child_environment(Path(home)))
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(REVIEW.ReviewError, "evidence_installation_in_progress"):
                    self.record()
            finally:
                os.close(descriptor)
        self.assertTrue((self.workspace / ".git/praxis-proof.lock").exists())
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

    def test_source_change_between_writes_preserves_recovery_evidence(self):
        replace = REVIEW.os.replace

        def change_source(source, destination):
            result = replace(source, destination)
            if Path(destination) == self.path(self.qa_name):
                self.write("apps/web/app.js", b"value = 4\n")
            return result

        with mock.patch.object(REVIEW.os, "replace", side_effect=change_source), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        self.assertEqual(self.recovery_required(failure.exception)["cause"], "evidence_changed")
        self.assertEqual(self.path(self.verification_name).read_bytes(), self.originals[self.verification_name])
        self.assertEqual(self.path("apps/web/app.js").read_bytes(), b"value = 4\n")

    def test_concurrent_foreign_verification_update_is_preserved_on_partial_failure(self):
        replace = REVIEW.os.replace
        concurrent = b'{"synthetic_concurrent_writer":true}\n'

        def change_verification(source, destination):
            result = replace(source, destination)
            if Path(destination) == self.path(self.qa_name):
                self.write(self.verification_name, concurrent)
            return result

        with mock.patch.object(REVIEW.os, "replace", side_effect=change_verification), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        self.assertEqual(self.recovery_required(failure.exception)["cause"], "evidence_changed")
        self.assertEqual(self.path(self.verification_name).read_bytes(), concurrent)
        self.assertNotEqual(self.path(self.qa_name).read_bytes(), self.originals[self.qa_name])
        self.assertEqual(self.path(self.proof_name).read_bytes(), self.originals[self.proof_name])

    def test_concurrent_change_to_own_replaced_file_is_never_overwritten(self):
        replace = REVIEW.os.replace
        concurrent = b'{"synthetic_concurrent_qa":true}\n'

        def mutate_written(source, destination):
            result = replace(source, destination)
            if Path(destination) == self.path(self.qa_name):
                self.write(self.qa_name, concurrent)
            return result

        with mock.patch.object(REVIEW.os, "replace", side_effect=mutate_written), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        self.assertEqual(self.recovery_required(failure.exception)["cause"], "evidence_changed_after_replace")
        self.assertEqual(self.path(self.qa_name).read_bytes(), concurrent)
        self.assertEqual(self.path(self.verification_name).read_bytes(), self.originals[self.verification_name])

    def test_manifest_mutation_between_writes_is_rejected(self):
        replace = REVIEW.os.replace

        def mutate_manifest(source, destination):
            result = replace(source, destination)
            if Path(destination) == self.path(self.qa_name):
                self.manifest_path.write_bytes(b"{}\n")
            return result

        with mock.patch.object(REVIEW.os, "replace", side_effect=mutate_manifest), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        self.assertEqual(self.recovery_required(failure.exception)["cause"], "review_manifest_changed")
        self.assertEqual(self.path(self.verification_name).read_bytes(), self.originals[self.verification_name])

    def test_late_foreign_write_on_failure_can_never_be_replaced_by_a_backup(self):
        replace = REVIEW.os.replace
        concurrent = b'{"synthetic_late_foreign_qa":true}\n'
        destinations = []
        fixture = self

        class LateWriteFailure(OSError):
            def __str__(self):
                fixture.write(fixture.qa_name, concurrent)
                return "synthetic late writer after the last QA check"

        def fail_proof(source, destination):
            destinations.append(Path(destination))
            if Path(destination) == self.path(self.proof_name):
                raise LateWriteFailure()
            return replace(source, destination)

        with mock.patch.object(REVIEW.os, "replace", side_effect=fail_proof), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        self.recovery_required(failure.exception)
        self.assertEqual(destinations, [self.path(self.qa_name), self.path(self.proof_name)])
        self.assertEqual(self.path(self.qa_name).read_bytes(), concurrent)
        self.assertEqual(self.path(self.verification_name).read_bytes(), self.originals[self.verification_name])

    def test_verification_publish_failure_preserves_all_originals_for_recovery(self):
        replace = REVIEW.os.replace

        def fail_verification(source, destination):
            if Path(destination) == self.path(self.verification_name):
                raise OSError("synthetic verification publication failure")
            return replace(source, destination)

        with mock.patch.object(REVIEW.os, "replace", side_effect=fail_verification), self.assertRaises(REVIEW.ReviewError) as failure:
            self.record()
        self.recovery_required(failure.exception, [self.qa_name, self.proof_name])
        self.assertEqual(self.path(self.verification_name).read_bytes(), self.originals[self.verification_name])

    def test_cli_reports_hashes_without_printing_inspection_notes(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        arguments = ["--workspace", str(self.workspace), "--artifact-prefix", self.prefix,
                     "--review-manifest", str(self.manifest_path), "--verification-file", self.verification_name]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(REVIEW.main(arguments), 0)
        self.assertEqual(stderr.getvalue(), "")
        result = json.loads(stdout.getvalue())
        self.assertEqual(set(result["hashes"]), set(self.originals))
        self.assertNotIn(self.manifest["notes"], stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
