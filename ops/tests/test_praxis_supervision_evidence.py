from __future__ import annotations

import json
import os
import unittest
import uuid
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
             "provenance": {"kind": "authenticated-owner", "channel": "cauce.trusted-origin", "conversation_id": "1000000001"}}
            for issue, record in ledger["records"].items() for criterion in record["criteria"]]
    value = {"schema_version": 1, "goal_sha256": fixture.config["goal_sha256"], "receipts": rows}
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    fixture.config["acceptance_receipts_file"] = str(path)
    return path, value


class EvidenceContractTests(unittest.TestCase):
    def setUp(self):
        self.chat = mock.patch.dict(os.environ, {"CAUCE_OWNER_TELEGRAM_CHAT_ID": "1000000001"})
        self.chat.start()
        self.addCleanup(self.chat.stop)
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()
        SUP.STATE.trusted_file.side_effect = self.synthetic_trust

    def synthetic_trust(self, path, directory=False):
        if directory and path in self.fixture.directory.parents:
            return
        self.fixture.fixture_trust(path, directory)

    def tearDown(self):
        self.fixture.tearDown()

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

    def test_source_contract_cannot_read_private_database_or_unknown_source_type(self):
        for path in ("data/patients.sqlite", "runtime/private.json", "apps/api/.env", "sessions/history.py"):
            with self.subTest(path=path):
                manifest = proof_fixture(self.fixture)
                manifest["source_files"][path] = "f" * 64
                self.fixture.write_json("verification.json", manifest)
                with self.assertRaisesRegex(SUP.SupervisionError, "artifact_(source_)?scope"):
                    self.fixture.snapshot()

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

    def test_unittest_exit_zero_with_zero_discovered_tests_is_not_a_passed_test_gate(self):
        reader = SUP.EVIDENCE.EvidenceReader(self.fixture.workspace, SUP.STATE)
        command = "python3 -B -m unittest discover -s apps/api -p test_*.py"
        for count, expected in ((0, False), (249, True)):
            report = {"results": [{"command": command, "exit_code": 0, "stdout": "",
                                  "stderr": f"Ran {count} tests in 158.096s\n\nOK\n"}]}
            self.assertEqual(reader.executed_tests(report, command), expected)


if __name__ == "__main__":
    unittest.main()
