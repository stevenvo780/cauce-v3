from __future__ import annotations

import json
import unittest
import uuid
from pathlib import Path
from unittest import mock

import test_praxis_supervision as fixtures

# cauce:requiere none

SUP, NOW, HEAD, NEXT_HEAD = fixtures.SUP, fixtures.NOW, fixtures.HEAD, fixtures.NEXT_HEAD


def proof_fixture(fixture, head=HEAD, accepted=False, version=2):
    workspace = fixture.workspace
    (workspace / "apps/web/test_app.js").write_text("synthetic executable test module")
    sources = {str(path.relative_to(workspace)): SUP.digest(path.read_bytes()) for path in (workspace / "apps/web").iterdir()}
    gates = []
    for identifier, command in (("tests", "node apps/web/test_app.js"), ("snapshot", "sha256sum " + " ".join(sorted(sources))),
                                ("qa", "python3 -B scripts/qa_professional.py")):
        report = {"schema_version": 2, "gate_id": identifier, "status": "passed", "exit_code": 0,
                  "command": command, "source_commit": head, "source_files": sources, "actual_results": {"count": 3}}
        if identifier == "tests":
            report["results"] = [{"command": command, "argv": ["node", "apps/web/test_app.js"], "exit_code": 0,
                                  "stdout": "test_app.js OK: synthetic assertions", "stderr": ""}]
        if identifier == "snapshot":
            report["source_unchanged"] = True
        if identifier == "qa":
            image = workspace / "screen.png"
            image.write_bytes(b"synthetic screenshot bytes")
            report.update(runs=[{"viewport": 1440, "status": "passed"}, {"viewport": 390, "status": "passed"}],
                          author="synthetic executor", review={"independent": True, "reviewer": "synthetic reviewer"},
                          inspected_images=[{"path": "screen.png", "sha256": SUP.digest(image.read_bytes())}])
        path = identifier + "-proof.json"
        fixture.write_json(path, report)
        artifact = {"path": path, "sha256": SUP.digest((workspace / path).read_bytes())}
        gate = {"id": identifier, "outcome": "validated", "exit_code": 0, "command": command,
                "source_commit": head, "source_files": sources}
        gate.update({"artifacts": [artifact]} if version == 2 else {"artifact": artifact})
        gates.append(gate)
    gates.extend({"id": identifier, "outcome": "not-applicable", "reason": "Static Python and JavaScript without configured checker/build",
                  "artifact": None} for identifier in ("typecheck", "build"))
    verification = {"schema_version": version, "goal_sha256": fixture.config["goal_sha256"], "status": "verified-preview",
                    "source_commit": head, "integration_commit": head, "source_files": sources,
                    "accepted_issues": ["PRAX001", "PRAX002"] if accepted else [], "gates": gates}
    fixture.write_json("verification.json", verification)
    if accepted:
        fixture.write_issues("accepted")
        records = {}
        for issue, identifiers in (("PRAX001", ("C1", "C2")), ("PRAX002", ("C1",))):
            fixture.write_json(issue + "-acceptance.json", {"status": "accepted", "acceptance_by": "synthetic owner",
                "issue_id": issue, "goal_sha256": fixture.config["goal_sha256"]})
            criteria = []
            for identifier in identifiers:
                report = json.loads((workspace / "tests-proof.json").read_text())
                report.update(issue_id=issue, criterion_id=identifier, goal_sha256=fixture.config["goal_sha256"])
                path = issue + "-" + identifier + "-proof.json"
                fixture.write_json(path, report)
                criteria.append({"id": identifier, "outcome": "passed", "artifact": {"path": path, "sha256": SUP.digest((workspace / path).read_bytes())},
                                 "qa_artifact": gates[2].get("artifact", gates[2].get("artifacts", [None])[0])})
            records[issue] = {"source_commit": head, "validation_status": "accepted", "acceptance_by": "synthetic owner",
                "acceptance_artifact": {"path": issue + "-acceptance.json", "sha256": SUP.digest((workspace / (issue + "-acceptance.json")).read_bytes())},
                "criteria": criteria}
        fixture.write_json("evidence.json", {"schema_version": version, "goal_sha256": fixture.config["goal_sha256"], "records": records})
    return verification


def protected_receipt_fixture(fixture):
    control = fixture.directory / "acceptance-control"
    control.mkdir(mode=0o700, exist_ok=True)
    path = control / "receipts.json"
    path.unlink(missing_ok=True)
    ledger = json.loads((fixture.workspace / "evidence.json").read_text())
    rows = [{"receipt_id": str(uuid.uuid4()), "goal_sha256": fixture.config["goal_sha256"],
             "source_commit": record["source_commit"], "issue_id": issue, "criterion_id": criterion["id"],
             "artifact_sha256": criterion["artifact"]["sha256"],
             "provenance": {"kind": "authenticated-owner", "channel": "cauce.trusted-origin", "conversation_id": "6979524541"}}
            for issue, record in ledger["records"].items() for criterion in record["criteria"]]
    value = {"schema_version": 1, "goal_sha256": fixture.config["goal_sha256"], "receipts": rows}
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    fixture.config["acceptance_receipts_file"] = str(path)
    return path, value


class EvidenceContractTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()
        SUP.STATE.trusted_file.side_effect = self.synthetic_trust

    def synthetic_trust(self, path, directory=False):
        if directory and path in self.fixture.directory.parents:
            return
        self.fixture.fixture_trust(path, directory)

    def tearDown(self):
        self.fixture.tearDown()

    def test_real_shaped_003_singular_artifacts_and_na_preserve_partial_goal(self):
        proof_fixture(self.fixture, version=1)
        snapshot = self.fixture.snapshot()
        self.assertEqual(snapshot["valid_gates"], ["qa", "snapshot", "tests"])
        self.assertEqual(set(snapshot["not_applicable_gates"]), {"typecheck", "build"})
        self.assertTrue(snapshot["verified_engineering"])
        self.assertFalse(snapshot["verification_current"])
        self.assertEqual(snapshot["accepted_issues"], [])
        self.assertEqual(snapshot["accepted_roadmap"], [])
        self.assertFalse(snapshot["completion_candidate"])

    def test_generic_test_artifact_copied_to_sibling_criteria_cannot_accredit_any_criterion(self):
        manifest = proof_fixture(self.fixture, accepted=True)
        ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
        for record in ledger["records"].values():
            for criterion in record["criteria"]:
                criterion["artifact"] = manifest["gates"][0]["artifacts"][0]
        self.fixture.write_json("evidence.json", ledger)
        snapshot = self.fixture.snapshot()
        self.assertEqual(snapshot["validated_roadmap"], [])
        self.assertEqual(snapshot["accepted_roadmap"], [])
        self.assertEqual(snapshot["accepted_issues"], [])
        self.assertFalse(snapshot["completion_candidate"])

    def test_specific_criterion_proof_cannot_be_reused_for_another_criterion(self):
        proof_fixture(self.fixture, accepted=True)
        ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
        criteria = ledger["records"]["PRAX001"]["criteria"]
        criteria[1]["artifact"] = criteria[0]["artifact"]
        self.fixture.write_json("evidence.json", ledger)
        snapshot = self.fixture.snapshot()
        self.assertEqual(snapshot["validated_roadmap"], ["PRAX001:C1", "PRAX002:C1"])
        self.assertFalse(snapshot["technical_milestone_candidate"])

    def test_goal_and_readme_only_criterion_report_does_not_accredit_or_earn_continuation(self):
        proof_fixture(self.fixture, accepted=True)
        previous = self.fixture.snapshot()
        (self.fixture.workspace / "README.md").write_text("synthetic public documentation")
        ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
        for record in ledger["records"].values():
            for criterion in record["criteria"]:
                artifact = criterion["artifact"]
                report = json.loads((self.fixture.workspace / artifact["path"]).read_text())
                report["source_files"] = {name: SUP.digest((self.fixture.workspace / name).read_bytes()) for name in ("GOAL.md", "README.md")}
                self.fixture.write_json(artifact["path"], report)
                artifact["sha256"] = SUP.digest((self.fixture.workspace / artifact["path"]).read_bytes())
        self.fixture.write_json("evidence.json", ledger)
        snapshot = self.fixture.snapshot()
        self.assertEqual(snapshot["validated_roadmap"], [])
        self.assertEqual(snapshot["accepted_roadmap"], [])
        self.assertFalse(SUP.made_progress(previous, snapshot))
        forged_counts = dict(previous, accepted_issues=["PRAX001"], accepted_roadmap=["PRAX001:C1"], validated_roadmap=["PRAX001:C1"])
        self.assertFalse(SUP.made_progress(previous, forged_counts))

    def test_web_criterion_requires_actual_independent_qa_and_matching_goal_commit_and_scope(self):
        for defect in ("no_qa", "no_review", "goal", "commit", "issue"):
            with self.subTest(defect=defect):
                proof_fixture(self.fixture, accepted=True)
                ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
                criterion = ledger["records"]["PRAX001"]["criteria"][0]
                if defect == "no_qa":
                    criterion.pop("qa_artifact")
                elif defect == "no_review":
                    qa = json.loads((self.fixture.workspace / "qa-proof.json").read_text())
                    qa["review"]["independent"] = False
                    self.fixture.write_json("qa-proof.json", qa)
                    criterion["qa_artifact"]["sha256"] = SUP.digest((self.fixture.workspace / "qa-proof.json").read_bytes())
                else:
                    report = json.loads((self.fixture.workspace / criterion["artifact"]["path"]).read_text())
                    report[{"goal": "goal_sha256", "commit": "source_commit", "issue": "issue_id"}[defect]] = {"goal": "f" * 64, "commit": NEXT_HEAD, "issue": "PRAX002"}[defect]
                    self.fixture.write_json(criterion["artifact"]["path"], report)
                    criterion["artifact"]["sha256"] = SUP.digest((self.fixture.workspace / criterion["artifact"]["path"]).read_bytes())
                self.fixture.write_json("evidence.json", ledger)
                self.assertNotIn("PRAX001:C1", self.fixture.snapshot()["validated_roadmap"])

    def test_repo_owner_name_and_acceptance_json_are_not_authenticated_human_approval(self):
        proof_fixture(self.fixture, accepted=True)
        ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
        ledger["records"]["PRAX001"]["acceptance_by"] = "Steven"
        self.fixture.write_json("evidence.json", ledger)
        snapshot = self.fixture.snapshot()
        self.assertEqual(len(snapshot["validated_roadmap"]), 3)
        self.assertEqual(snapshot["accepted_roadmap"], [])
        self.assertTrue(snapshot["acceptance_receipt_required"])
        self.assertFalse(snapshot["completion_candidate"])

    def test_protected_scoped_receipts_allow_full_goal_only_with_current_criterion_and_gate_proof(self):
        proof_fixture(self.fixture, accepted=True)
        path, _ = protected_receipt_fixture(self.fixture)
        with mock.patch.object(SUP.EVIDENCE, "ACCEPTANCE_ROOT", path.parent):
            snapshot = self.fixture.snapshot()
        self.assertEqual(snapshot["accepted_issues"], ["PRAX001", "PRAX002"])
        self.assertEqual(len(snapshot["accepted_roadmap"]), 3)
        self.assertFalse(snapshot["acceptance_receipt_required"])
        self.assertTrue(snapshot["completion_candidate"])

    def test_receipt_wrong_goal_source_artifact_uuid_or_owner_does_not_accredit(self):
        for defect in ("top_goal", "row_goal", "commit", "artifact", "uuid", "owner", "subject"):
            with self.subTest(defect=defect):
                proof_fixture(self.fixture, accepted=True)
                path, value = protected_receipt_fixture(self.fixture)
                row = value["receipts"][0]
                if defect == "top_goal":
                    value["goal_sha256"] = "f" * 64
                if defect == "row_goal":
                    row["goal_sha256"] = "f" * 64
                if defect == "commit":
                    row["source_commit"] = NEXT_HEAD
                if defect == "artifact":
                    row["artifact_sha256"] = "f" * 64
                if defect == "uuid":
                    row["receipt_id"] = "invented owner name"
                if defect == "owner":
                    row["provenance"] = {"name": "Steven"}
                if defect == "subject":
                    row["provenance"]["conversation_id"] = "0000000000"
                path.write_text(json.dumps(value))
                with mock.patch.object(SUP.EVIDENCE, "ACCEPTANCE_ROOT", path.parent):
                    if defect in {"top_goal", "uuid"}:
                        with self.assertRaisesRegex(SUP.SupervisionError, "invalid_acceptance_receipts"):
                            self.fixture.snapshot()
                    else:
                        snapshot = self.fixture.snapshot()
                        self.assertNotIn("PRAX001:C1", snapshot["accepted_roadmap"])
                        self.assertFalse(snapshot["completion_candidate"])

    def test_receipt_control_rejects_unprotected_path_permissions_symlink_and_wrong_owner(self):
        proof_fixture(self.fixture, accepted=True)
        path, value = protected_receipt_fixture(self.fixture)
        with mock.patch.object(SUP.EVIDENCE, "ACCEPTANCE_ROOT", path.parent):
            for mode in (0o644, 0o620):
                path.chmod(mode)
                with self.assertRaises(SUP.SupervisionError):
                    self.fixture.snapshot()
            path.chmod(0o600)
            self.fixture.state_trust_patch.stop()
            try:
                with self.assertRaisesRegex(SUP.SupervisionError, "untrusted_control_file"):
                    self.fixture.snapshot()
            finally:
                self.fixture.state_trust_patch.start()
            path.unlink()
            target = self.fixture.workspace / "repo-receipts.json"
            target.write_text(json.dumps(value))
            path.symlink_to(target)
            with self.assertRaises(SUP.SupervisionError):
                self.fixture.snapshot()
            path.unlink()
            for bad in (str(target), str(path.parent / "credentials" / "receipts.json"), str(path.parent / "auth.json")):
                self.fixture.config["acceptance_receipts_file"] = bad
                with self.assertRaisesRegex(SUP.SupervisionError, "invalid_acceptance_receipts_path"):
                    self.fixture.snapshot()

    def test_optional_receipt_configuration_accepts_protected_namespace_and_rejects_repo_path(self):
        config = {**self.fixture.config, "issue_count": 37, "roadmap_count": 216}
        path = self.fixture.workspace / "config.json"
        config["acceptance_receipts_file"] = "/var/lib/praxis-supervision/acceptance-receipts.json"
        path.write_text(json.dumps(config))
        self.assertEqual(SUP.load_config(path)["acceptance_receipts_file"], config["acceptance_receipts_file"])
        config["acceptance_receipts_file"] = str(self.fixture.workspace / "fake-acceptance.json")
        path.write_text(json.dumps(config))
        with self.assertRaisesRegex(SUP.SupervisionError, "invalid_acceptance_receipts_path"):
            SUP.load_config(path)

    def test_receipts_check_every_parent_and_reject_unsafe_ancestor_outside_acceptance_namespace(self):
        proof_fixture(self.fixture, accepted=True)
        path, _ = protected_receipt_fixture(self.fixture)
        with mock.patch.object(SUP.EVIDENCE, "ACCEPTANCE_ROOT", path.parent), \
                mock.patch.object(SUP.STATE, "trusted_file", side_effect=self.synthetic_trust) as checked:
            self.assertTrue(self.fixture.snapshot()["completion_candidate"])
            for ancestor in path.parent.parents:
                self.assertIn(mock.call(ancestor, directory=True), checked.call_args_list)
            self.assertIn(mock.call(Path("/"), directory=True), checked.call_args_list)
            self.fixture.directory.chmod(0o777)
            try:
                with self.assertRaisesRegex(SUP.SupervisionError, "untrusted_control_file"):
                    self.fixture.snapshot()
            finally:
                self.fixture.directory.chmod(0o700)

    def test_003_legacy_test_log_without_embedded_source_binding_cannot_earn_progress(self):
        manifest = proof_fixture(self.fixture, version=1)
        raw = self.fixture.workspace / "api.txt"
        raw.write_text("Ran 249 tests in 160.375s\n\nOK\n")
        manifest["gates"][0]["artifact"] = {"path": "api.txt", "sha256": SUP.digest(raw.read_bytes())}
        self.fixture.write_json("verification.json", manifest)
        snapshot = self.fixture.snapshot()
        self.assertNotIn("tests", snapshot["valid_gates"])
        self.assertFalse(snapshot["verified_engineering"])

    def test_bad_artifact_hash_and_stale_api_report_fail_even_with_current_manifest(self):
        for defect in ("hash", "api"):
            with self.subTest(defect=defect):
                manifest = proof_fixture(self.fixture)
                if defect == "hash":
                    manifest["gates"][0]["artifacts"][0]["sha256"] = "f" * 64
                else:
                    (self.fixture.workspace / "apps/api").mkdir(exist_ok=True)
                    (self.fixture.workspace / "apps/api/server.py").write_text("current API code")
                    manifest["source_files"]["apps/api/server.py"] = SUP.digest((self.fixture.workspace / "apps/api/server.py").read_bytes())
                    report = json.loads((self.fixture.workspace / "qa-proof.json").read_text())
                    report["source_files"]["apps/api/server.py"] = "a" * 64
                    self.fixture.write_json("qa-proof.json", report)
                    manifest["gates"][2]["artifacts"][0]["sha256"] = SUP.digest((self.fixture.workspace / "qa-proof.json").read_bytes())
                self.fixture.write_json("verification.json", manifest)
                snapshot = self.fixture.snapshot()
                self.assertTrue(snapshot["verification_source_current"])
                self.assertNotIn("tests" if defect == "hash" else "qa", snapshot["valid_gates"])
                self.assertFalse(snapshot["completion_candidate"])

    def test_current_qa_wrapper_cannot_hide_stale_sources_in_raw_browser_report(self):
        manifest = proof_fixture(self.fixture)
        report = json.loads((self.fixture.workspace / "qa-proof.json").read_text())
        report["browser_report"] = {"status": "passed", "source_sha256": {"apps/web/app.js": "a" * 64}}
        self.fixture.write_json("qa-proof.json", report)
        manifest["gates"][2]["artifacts"][0]["sha256"] = SUP.digest((self.fixture.workspace / "qa-proof.json").read_bytes())
        self.fixture.write_json("verification.json", manifest)
        snapshot = self.fixture.snapshot()
        self.assertFalse(snapshot["qa_executed"])
        self.assertNotIn("qa", snapshot["valid_gates"])
        self.assertTrue(snapshot["verified_engineering"])

    def test_visual_execution_without_independent_image_review_is_not_qa_acceptance(self):
        manifest = proof_fixture(self.fixture)
        report = json.loads((self.fixture.workspace / "qa-proof.json").read_text())
        report["inspected_images"] = []
        self.fixture.write_json("qa-proof.json", report)
        manifest["gates"][2]["artifacts"][0]["sha256"] = SUP.digest((self.fixture.workspace / "qa-proof.json").read_bytes())
        self.fixture.write_json("verification.json", manifest)
        snapshot = self.fixture.snapshot()
        self.assertTrue(snapshot["qa_executed"])
        self.assertNotIn("qa", snapshot["valid_gates"])
        self.assertTrue(snapshot["verified_engineering"])

    def test_na_requires_explicit_reason_and_absence_of_configured_tool(self):
        for defect in ("reason", "fake_pass", "config", "unknown_gate"):
            with self.subTest(defect=defect):
                manifest = proof_fixture(self.fixture)
                gate = manifest["gates"][3]
                if defect == "reason":
                    gate["reason"] = ""
                if defect == "fake_pass":
                    gate["exit_code"] = 0
                if defect == "config":
                    (self.fixture.workspace / "pyrightconfig.json").write_text("{}")
                if defect == "unknown_gate":
                    gate["id"] = "tests"
                self.fixture.write_json("verification.json", manifest)
                snapshot = self.fixture.snapshot()
                self.assertNotIn("typecheck", snapshot["not_applicable_gates"])
                (self.fixture.workspace / "pyrightconfig.json").unlink(missing_ok=True)

    def test_unknown_schema_and_gate_outcome_fail_closed(self):
        for key, value in (("schema_version", 99), ("outcome", "almost-good")):
            with self.subTest(key=key):
                manifest = proof_fixture(self.fixture)
                if key == "schema_version":
                    manifest[key] = value
                else:
                    manifest["gates"][0][key] = value
                self.fixture.write_json("verification.json", manifest)
                snapshot = self.fixture.snapshot()
                self.assertFalse(snapshot["verified_engineering"])
                self.assertNotIn("tests", snapshot["valid_gates"])

    def test_source_contract_cannot_read_private_database_or_unknown_source_type(self):
        for path in ("data/patients.sqlite", "runtime/private.json", "apps/api/.env", "sessions/history.py"):
            with self.subTest(path=path):
                manifest = proof_fixture(self.fixture)
                manifest["source_files"][path] = "f" * 64
                self.fixture.write_json("verification.json", manifest)
                with self.assertRaisesRegex(SUP.SupervisionError, "artifact_(source_)?scope"):
                    self.fixture.snapshot()

    def test_technical_spanish_status_and_passed_do_not_invent_hito_acceptance(self):
        proof_fixture(self.fixture, accepted=True)
        ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
        ledger["records"]["PRAX001"].update(validation_status="validada tecnicamente", acceptance_by=None, acceptance_artifact=None)
        self.fixture.write_json("evidence.json", ledger)
        snapshot = self.fixture.snapshot()
        self.assertEqual(len(snapshot["validated_roadmap"]), 3)
        self.assertEqual(snapshot["accepted_issues"], [])
        self.assertEqual(snapshot["accepted_roadmap"], [])
        self.assertFalse(snapshot["completion_candidate"])
        ledger["records"]["PRAX001"]["validation_status"] = "aceptada para el hito"
        self.fixture.write_json("evidence.json", ledger)
        self.assertFalse(self.fixture.snapshot()["completion_candidate"])

    def test_unknown_or_partial_ledger_status_does_not_accredit_criteria(self):
        for status in ("partial-evidence", "partial synthetic evidence; independent GO; acceptance pending", "looks accepted"):
            with self.subTest(status=status):
                proof_fixture(self.fixture, accepted=True)
                ledger = json.loads((self.fixture.workspace / "evidence.json").read_text())
                ledger["records"]["PRAX001"]["validation_status"] = status
                self.fixture.write_json("evidence.json", ledger)
                snapshot = self.fixture.snapshot()
                self.assertEqual(snapshot["validated_roadmap"], ["PRAX002:C1"])

    def test_only_scoped_executed_test_hashes_cover_code_progress(self):
        previous = self.fixture.snapshot()
        (self.fixture.workspace / "apps/web/app.js").write_text("new real shaped source")
        proof_fixture(self.fixture, NEXT_HEAD)
        current = self.fixture.snapshot(NEXT_HEAD)
        self.assertTrue(SUP.made_progress(previous, current))
        wrong_command = json.loads((self.fixture.workspace / "verification.json").read_text())
        wrong_command["gates"][0]["command"] = "echo tests passed"
        self.fixture.write_json("verification.json", wrong_command)
        self.assertFalse(SUP.made_progress(previous, self.fixture.snapshot(NEXT_HEAD)))
        current["source_hashes"]["apps/api/server.py"] = "f" * 64
        self.assertFalse(SUP.made_progress(previous, current))

    def test_same_source_with_new_artifact_timestamp_does_not_earn_repeated_continuations(self):
        manifest = proof_fixture(self.fixture)
        previous = self.fixture.snapshot()
        report = json.loads((self.fixture.workspace / "tests-proof.json").read_text())
        report["started_at"] = "new execution time; same implementation"
        self.fixture.write_json("tests-proof.json", report)
        manifest["gates"][0]["artifacts"][0]["sha256"] = SUP.digest((self.fixture.workspace / "tests-proof.json").read_bytes())
        self.fixture.write_json("verification.json", manifest)
        current = self.fixture.snapshot()
        self.assertTrue(current["verified_engineering"])
        self.assertFalse(SUP.made_progress(previous, current))

    def test_missing_actual_execution_and_boolean_exit_status_cannot_accredit_tests(self):
        for defect in ("empty_results", "boolean_exit", "echo_command"):
            with self.subTest(defect=defect):
                manifest = proof_fixture(self.fixture)
                report = json.loads((self.fixture.workspace / "tests-proof.json").read_text())
                if defect == "empty_results":
                    report["results"] = []
                if defect == "boolean_exit":
                    report["exit_code"] = False
                if defect == "echo_command":
                    command = "echo node apps/web/test_app.js"
                    manifest["gates"][0]["command"] = report["command"] = report["results"][0]["command"] = command
                self.fixture.write_json("tests-proof.json", report)
                manifest["gates"][0]["artifacts"][0]["sha256"] = SUP.digest((self.fixture.workspace / "tests-proof.json").read_bytes())
                self.fixture.write_json("verification.json", manifest)
                self.assertNotIn("tests", self.fixture.snapshot()["valid_gates"])

    def test_unittest_exit_zero_with_zero_discovered_tests_is_not_a_passed_test_gate(self):
        reader = SUP.EVIDENCE.EvidenceReader(self.fixture.workspace, SUP.STATE)
        command = "python3 -B -m unittest discover -s apps/api -p test_*.py"
        for count, expected in ((0, False), (249, True)):
            report = {"results": [{"command": command, "exit_code": 0, "stdout": "",
                                  "stderr": f"Ran {count} tests in 158.096s\n\nOK\n"}]}
            self.assertEqual(reader.executed_tests(report, command), expected)

    def test_next_work_persists_full_sdd_criterion_and_blocked_reason(self):
        self.fixture.write_json("roadmap.json", {"goal_sha256": self.fixture.config["goal_sha256"], "issues": [
            {"id": "PRAX001", "criteria": [{"id": "C1", "text": "Entire clinically blocked criterion", "blocked_reason": "owner clinical content pending"},
                {"id": "C2", "text": "Implement full synthetic flow, isolation and persistence"}]},
            {"id": "PRAX002", "criteria": [{"id": "C1", "text": "Later full criterion"}]}]})
        self.fixture.write_json("evidence.json", {"schema_version": 1, "goal_sha256": self.fixture.config["goal_sha256"],
            "records": {"PRAX001": {"remaining": "All documented behaviors and actual synthetic E2E"}}})
        self.fixture.run_pass()
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["next_work"]["issue_id"], "PRAX002")
        self.assertEqual(state["next_work"]["criterion_id"], "C1")
        self.assertEqual(state["next_work"]["authority"], "existing_owner_goal")
        body = self.fixture.engineering_posts()[0]["body"]
        self.assertEqual(body["supervision"]["next_work"], state["next_work"])
        self.assertIn("criterio íntegro", body["text"])
        self.assertTrue(body["supervision"]["next_work"]["advisory"])

    def test_product_consent_engineering_precedes_governance_without_granting_doc_progress(self):
        document = {"issues": [
            {"id": "PRAX-001", "criteria": [{"id": "AC01", "text": "Register the 83 P0 decisions"}]},
            {"id": "PRAX-013", "criteria": [{"id": "AC01", "text": "Implement synthetic consent persistence and isolation"}]},
            {"id": "PRAX-037", "criteria": [{"id": "AC01", "text": "Record final milestone acceptance"}]}]}
        work = SUP.EVIDENCE.next_work(document, {}, set(), SUP.STATE.PROFILE.DEFAULT["deferred_issues"])
        self.assertEqual(work["issue_id"], "PRAX-013")
        self.assertTrue(work["advisory"])
        self.assertIn("next_work orienta", SUP.STATE.PROFILE.DEFAULT["root_text"])
        self.assertIn("--install-evidence", SUP.STATE.PROFILE.DEFAULT["root_text"])
        self.assertIn("/opt/praxis-qa-venv/bin/python", SUP.STATE.PROFILE.DEFAULT["root_text"])
        previous = self.fixture.snapshot()
        current = {**previous, "next_work": work, "validated_roadmap": ["PRAX-001:AC01"]}
        self.assertFalse(SUP.made_progress(previous, current))

    def paused_progress(self, reason="no_measured_progress"):
        supervisor = self.fixture.supervisor()
        baseline = self.fixture.snapshot()
        supervisor.state.update(phase="circuit_paused", pause_reason=reason,
                                last_finished={"root": "causally-closed-root", "engineering": baseline})
        supervisor.save()
        return supervisor, baseline

    def test_fresh_code_and_gates_recover_progress_circuit_once_preserving_fuel(self):
        supervisor, _ = self.paused_progress()
        supervisor.state["roots"] = {SUP.STATE.utc_day(NOW): 9}
        supervisor.save()
        self.fixture.config["root_limit"] = 12
        (self.fixture.workspace / "apps/web/app.js").write_text("new complete criterion code")
        proof_fixture(self.fixture, NEXT_HEAD)
        snapshot = self.fixture.snapshot(NEXT_HEAD)
        self.assertEqual(self.fixture.run_pass(snapshot=snapshot)["action"], "root_published")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["roots"], {SUP.STATE.utc_day(NOW): 10})
        self.assertEqual(len(state["progress_recoveries"]), 1)
        self.assertEqual(state["last_finished"]["root"], "causally-closed-root")
        self.assertFalse(state["continuation_earned"])
        self.assertEqual(self.fixture.run_pass(NOW + 1500, snapshot)["action"], "root_pending")
        self.assertEqual(len(self.fixture.engineering_posts()), 1)

    def test_recovery_respects_stop_other_pauses_activity_cooldown_and_caps(self):
        for constraint in ("stop", "quota", "active_root", "activity", "cooldown", "fuel", "unchanged", "stale"):
            with self.subTest(constraint=constraint):
                self.fixture.state_path.unlink(missing_ok=True)
                self.fixture.api = fixtures.FakeApi()
                supervisor, _ = self.paused_progress("quota_exhausted" if constraint == "quota" else "no_new_progress")
                if constraint == "unchanged":
                    snapshot = self.fixture.snapshot()
                else:
                    (self.fixture.workspace / "apps/web/app.js").write_text("new source for " + constraint)
                    proof_fixture(self.fixture, NEXT_HEAD)
                    snapshot = self.fixture.snapshot(NEXT_HEAD)
                if constraint == "stale":
                    snapshot["verified_engineering"] = False
                if constraint == "stop":
                    (self.fixture.directory / "STOP").write_text("owner stop")
                if constraint == "fuel":
                    supervisor.state["roots"] = {SUP.STATE.utc_day(NOW): 6}
                if constraint == "cooldown":
                    supervisor.state["cooldown_until"] = NOW + 1200
                if constraint == "active_root":
                    supervisor.state["active_root"] = {"attempts": 0}
                supervisor.save()
                self.fixture.run_pass(snapshot=snapshot, active=1 if constraint == "activity" else 0)
                self.assertEqual(self.fixture.engineering_posts(), [])
                (self.fixture.directory / "STOP").unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
