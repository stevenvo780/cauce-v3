from __future__ import annotations

import copy
import json
import unittest

import test_praxis_supervision as fixtures
import test_praxis_visual_review as visual_fixtures
from test_praxis_supervision_evidence import proof_fixture

# cauce:requiere none

SUP, NOW, NEXT_HEAD = fixtures.SUP, fixtures.NOW, fixtures.NEXT_HEAD


class QaRemediationTests(unittest.TestCase):
    def setUp(self):
        self.visual = visual_fixtures.VisualReviewTests()
        self.visual.setUp()
        self.fixture = self.visual.fixture

    def tearDown(self):
        self.visual.tearDown()

    def state(self):
        return json.loads(self.fixture.state_path.read_text())

    def remediation_posts(self):
        return [post for post in self.fixture.engineering_posts()
                if post["body"]["supervision"].get("purpose") == "qa_remediation"]

    def closed_review(self):
        baseline, original, pending = self.visual.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        self.fixture.run_pass(NOW + 2100, pending)
        return baseline, original

    def install_review(self, outcome="failed", implementation=None, notes=None):
        if implementation is not None:
            (self.fixture.workspace / "apps/web/app.js").write_text(implementation)
        verification = proof_fixture(self.fixture, NEXT_HEAD)
        sources = dict(verification["source_files"], **{"GOAL.md": self.fixture.config["goal_sha256"]})
        verification["source_files"] = sources
        for gate in verification["gates"]:
            if gate["id"] not in {"tests", "qa", "snapshot"}:
                continue
            gate["source_files"] = sources
            artifact = gate["artifacts"][0]
            path = self.fixture.workspace / artifact["path"]
            report = json.loads(path.read_text())
            report["source_files"] = sources
            if gate["id"] == "qa":
                captures = copy.deepcopy(report["inspected_images"])
                report["runs"][0]["screenshots"] = captures
                report["review"].update(independent=outcome == "passed", outcome=outcome, performed=True,
                    source_commit=NEXT_HEAD, goal_sha256=self.fixture.config["goal_sha256"],
                    notes=notes or "The mobile navigation overlaps the schedule and configuration at 320px.")
                report["inspected_images"] = [dict(capture, observations=
                    "The navigation obscures the mobile schedule and configuration content.") for capture in captures]
            path.write_text(json.dumps(report))
            artifact["sha256"] = SUP.digest(path.read_bytes())
        self.fixture.write_json("verification.json", verification)
        return self.fixture.snapshot(NEXT_HEAD)

    def wide_failed_review(self):
        self.install_review()
        path = self.fixture.workspace / "qa-proof.json"
        report = json.loads(path.read_text())
        captures = []
        for index in range(100):
            image = self.fixture.workspace / f"synthetic-screen-{index}.png"
            image.write_bytes(f"synthetic verified capture {index}".encode())
            captures.append({"path": image.name, "sha256": SUP.digest(image.read_bytes())})
        report["runs"][0]["screenshots"] = captures
        report["review"]["notes"] = "Current independently inspected mobile layout defects. " * 30
        report["inspected_images"] = [dict(capture, observations="Mobile navigation overlaps schedule and configuration. " * 7)
                                      for capture in captures]
        path.write_text(json.dumps(report))
        verification = json.loads((self.fixture.workspace / "verification.json").read_text())
        verification["gates"][2]["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
        self.fixture.write_json("verification.json", verification)
        return self.fixture.snapshot(NEXT_HEAD)

    def test_large_current_evidence_state_reloads_receipt_without_replay(self):
        self.closed_review()
        failed = self.wide_failed_review()
        self.assertEqual(len(failed["qa_review"]["verdict"]["observations"]), 100)
        self.assertEqual(self.fixture.run_pass(NOW + 3000, failed)["action"], "qa_remediation_requested")
        self.assertGreater(self.fixture.state_path.stat().st_size, 128000)
        self.assertLess(self.fixture.state_path.stat().st_size, SUP.STATE.STATE_MAX_BYTES)
        before = self.state()
        self.fixture.api.receipt = {"chain_open": True, "deliveries": [{"status": "started"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 5000, failed)["action"], "root_pending")
        self.assertEqual(self.state()["active_root"], before["active_root"])
        self.assertEqual(self.state()["roots"], before["roots"])
        self.assertEqual(len(self.remediation_posts()), 1)

    def test_oversize_ledger_refuses_atomic_reservation_before_post_and_preserves_disk_state(self):
        self.closed_review()
        failed = self.install_review()
        prior = self.fixture.state_path.read_bytes()
        supervisor = self.fixture.supervisor(NOW + 3000)
        ledger = supervisor.state.setdefault("qa_remediation_requests", {})
        for index in range(4000):
            cohort = SUP.digest(str(index).encode())
            token = SUP.digest(SUP.canonical({"goal_sha256": failed["goal_sha256"], "cohort_sha256": cohort}))
            ledger[token] = {"goal_sha256": failed["goal_sha256"], "cohort_sha256": cohort,
                "key": "praxis-qa-remediation:" + failed["goal_sha256"] + ":" + cohort,
                "at": NOW - 100000, "status": "closed", "outcome": "no_measured_progress"}
        self.assertGreater(len(SUP.canonical(supervisor.state)), SUP.STATE.STATE_MAX_BYTES)
        with self.assertRaisesRegex(SUP.SupervisionError, "state_too_large"):
            supervisor.pass_once({**self.fixture.runtime(), "observed_at": NOW + 3000}, failed)
        self.assertEqual(self.fixture.state_path.read_bytes(), prior)
        self.assertEqual(self.remediation_posts(), [])
        self.assertEqual(len(self.fixture.engineering_posts()), 2)

    def test_oversize_existing_state_is_rejected_with_same_typed_limit(self):
        self.closed_review()
        raw = self.fixture.state_path.read_bytes()
        self.fixture.state_path.write_bytes(raw + b" " * SUP.STATE.STATE_MAX_BYTES)
        with self.assertRaisesRegex(SUP.SupervisionError, "state_too_large"):
            self.fixture.supervisor()
        self.assertEqual(len(self.fixture.engineering_posts()), 2)

    def test_current_independent_failed_review_reserves_one_distinct_repair_without_credit(self):
        baseline, original = self.closed_review()
        failed = self.install_review()
        self.assertNotIn("qa", failed["valid_gates"])
        self.assertTrue(failed["qa_review"]["verdict"]["validated"])
        self.assertTrue(SUP.made_progress(baseline, failed))
        before = self.state()
        self.assertEqual(self.fixture.run_pass(NOW + 3000, failed)["action"], "qa_remediation_requested")
        after = self.state()
        root = after["active_root"]
        self.assertEqual(root["purpose"], "qa_remediation")
        self.assertEqual(root["baseline"], failed)
        self.assertEqual(root["payload"]["recipients"], [{"tenant_id": "Hospital", "alias": "operador"}])
        self.assertEqual(after["progress_pause_baseline"], baseline)
        self.assertEqual(after["progress_pause_binding"], before["progress_pause_binding"])
        self.assertFalse(after["continuation_earned"])
        self.assertEqual(sum(after["roots"].values()), sum(before["roots"].values()) + 1)
        self.assertEqual(after["visual_review_roots"], before["visual_review_roots"])
        self.assertEqual(after["visual_review_requests"], before["visual_review_requests"])
        key = root["payload"]["idempotency_key"]
        self.assertEqual(key, "praxis-qa-remediation:" + failed["goal_sha256"] + ":" + failed["qa_review"]["cohort_sha256"])
        self.assertNotIn(key, [request["key"] for request in before["visual_review_requests"].values()])
        self.assertEqual(root["payload"]["body"]["supervision"]["original_root"], original["message_id"])
        self.fixture.api.receipt = {"chain_open": True, "deliveries": [{"status": "started"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 5000, failed)["action"], "root_pending")
        self.assertEqual(self.state()["active_root"], root)
        self.assertEqual(self.state()["roots"], after["roots"])
        self.assertEqual(len(self.remediation_posts()), 1)

    def test_repair_without_real_change_pauses_and_notes_or_approval_cannot_rebuy_fuel(self):
        baseline, _ = self.closed_review()
        failed = self.install_review()
        self.fixture.run_pass(NOW + 3000, failed)
        before = self.state()
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 3300, failed)["action"], "no_measured_progress")
        paused = self.state()
        self.assertEqual(paused["phase"], "circuit_paused")
        self.assertEqual(paused["progress_pause_baseline"], baseline)
        self.assertEqual(paused["progress_pause_binding"], before["progress_pause_binding"])
        self.assertEqual(paused["progress_pause_measurement_baseline"]["source_hashes"], failed["source_hashes"])
        self.assertEqual(paused["progress_pause_measurement_baseline"]["gate_artifacts"], failed["gate_artifacts"])
        changed_notes = self.install_review(notes="Different notes describing the same current mobile defects and captures.")
        self.assertEqual(changed_notes["qa_review"]["cohort_sha256"], failed["qa_review"]["cohort_sha256"])
        for elapsed in (6000, 90000):
            self.assertEqual(self.fixture.run_pass(NOW + elapsed, changed_notes)["action"], "no_measured_progress")
        approved = self.install_review(outcome="passed")
        self.assertTrue(SUP.made_progress(baseline, approved))
        self.assertFalse(SUP.made_progress(failed, approved))
        self.assertEqual(self.fixture.run_pass(NOW + 100000, approved)["action"], "circuit_paused")
        self.assertFalse(self.state()["continuation_earned"])
        self.assertEqual(self.state()["roots"], before["roots"])
        self.assertEqual(len(self.remediation_posts()), 1)

    def test_real_repair_preserves_original_binding_and_can_request_new_cohort_review(self):
        baseline, _ = self.closed_review()
        failed = self.install_review()
        self.fixture.run_pass(NOW + 3000, failed)
        before = self.state()
        pending = self.install_review(outcome="pending", implementation="real tested mobile layout correction")
        self.assertTrue(SUP.made_progress(failed, pending))
        self.assertNotEqual(pending["qa_review"]["cohort_sha256"], failed["qa_review"]["cohort_sha256"])
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 3300, pending)["action"], "visual_review_pending")
        state = self.state()
        self.assertEqual(state["progress_pause_baseline"], baseline)
        self.assertEqual(state["progress_pause_binding"], before["progress_pause_binding"])
        self.assertTrue(state["last_finished"]["measured"])
        self.assertFalse(state["continuation_earned"])
        self.assertEqual(self.fixture.run_pass(NOW + 4000, pending)["action"], "visual_review_requested")
        approved = self.install_review(outcome="passed")
        self.assertEqual(self.fixture.run_pass(NOW + 4300, approved)["action"], "visual_review_completed")
        self.assertTrue(self.state()["continuation_earned"])
        self.assertEqual(self.state()["progress_pause_binding"], before["progress_pause_binding"])
        self.assertEqual(len(self.remediation_posts()), 1)

    def test_changed_failed_cohort_after_real_repair_can_get_its_own_bounded_repair(self):
        self.closed_review()
        failed = self.install_review()
        self.fixture.run_pass(NOW + 3000, failed)
        corrected_but_failed = self.install_review(implementation="actual tested fix with another inspected mobile defect")
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 3300, corrected_but_failed)["action"], "visual_review_pending")
        self.assertEqual(self.fixture.run_pass(NOW + 4000, corrected_but_failed)["action"], "qa_remediation_requested")
        self.assertEqual(len(self.remediation_posts()), 2)
        self.assertEqual(len(self.state()["qa_remediation_requests"]), 2)
        self.assertNotEqual(self.remediation_posts()[0]["idempotency_key"], self.remediation_posts()[1]["idempotency_key"])

    def test_bad_unknown_stale_or_contradictory_verdict_never_posts_repair(self):
        self.closed_review()
        failed, original = self.install_review(), self.state()
        for defect in ("passed", "unknown", "missing", "unvalidated", "unperformed", "author", "reviewer", "notes", "image_hash",
                       "missing_image", "empty_observations", "sources", "source_commit", "artifact", "goal", "stale", "tests", "snapshot", "approved"):
            with self.subTest(defect=defect):
                evidence = copy.deepcopy(failed)
                review, verdict = evidence["qa_review"], evidence["qa_review"]["verdict"]
                if defect in {"passed", "unknown"}:
                    verdict["outcome"] = defect
                if defect == "missing":
                    review.pop("verdict")
                if defect in {"unvalidated", "unperformed"}:
                    verdict["validated" if defect == "unvalidated" else "performed"] = False
                if defect == "author":
                    verdict["reviewer"] = verdict["author"]
                if defect == "reviewer":
                    verdict["reviewer"] = ""
                if defect == "notes":
                    verdict["notes"] = None
                if defect == "image_hash":
                    verdict["observations"][0]["sha256"] = "f" * 64
                if defect == "missing_image":
                    verdict["observations"] = []
                if defect == "empty_observations":
                    verdict["observations"][0]["observations"] = ""
                if defect == "sources":
                    review["source_files"]["apps/web/app.js"] = "f" * 64
                if defect == "source_commit":
                    review["source_commit"] = "unknown"
                if defect == "artifact":
                    review["artifacts"][0]["sha256"] = "invalid"
                if defect == "goal":
                    review["goal_sha256"] = "f" * 64
                if defect == "stale":
                    evidence["verification_source_current"] = False
                if defect in {"tests", "snapshot"}:
                    evidence["valid_gates"].remove(defect)
                if defect == "approved":
                    evidence["valid_gates"].append("qa")
                SUP.atomic_save(self.fixture.state_path, original)
                self.fixture.run_pass(NOW + 3000, evidence)
                self.assertEqual(self.remediation_posts(), [])
                self.assertEqual(self.state()["roots"], original["roots"])

    def test_runtime_stop_fuel_cooldown_and_hard_capacity_guards_remain_closed(self):
        self.closed_review()
        failed, original = self.install_review(), self.state()
        for constraint in ("active", "readiness", "stale_runtime", "idle", "recent_activity", "cooldown", "fuel", "stop",
                           "unauthorized", "quota_exhausted", "foreign_receipt", "causal_receipt_mismatch", "preview_rollback_unknown", "certificate"):
            with self.subTest(constraint=constraint):
                state = copy.deepcopy(original)
                runtime = {**self.fixture.runtime(), "observed_at": NOW + 3000}
                if constraint == "active":
                    runtime["active"] = 1
                if constraint == "readiness":
                    runtime["ready"] = False
                if constraint == "stale_runtime":
                    runtime["observed_at"] = NOW
                if constraint == "idle":
                    state["idle_since"] = NOW + 2999
                if constraint == "recent_activity":
                    runtime["last_activity_at"] = NOW + 2999
                if constraint == "cooldown":
                    state["cooldown_until"] = NOW + 10000
                if constraint == "fuel":
                    state["roots"][SUP.STATE.utc_day(NOW)] = self.fixture.config["root_limit"]
                if constraint == "stop":
                    (self.fixture.directory / "STOP").write_text("owner stop")
                if constraint in {"unauthorized", "quota_exhausted", "foreign_receipt", "causal_receipt_mismatch", "preview_rollback_unknown"}:
                    state.update(phase="circuit_paused", pause_reason=constraint)
                if constraint == "certificate":
                    self.fixture.config["certificate_not_after"] = NOW
                SUP.atomic_save(self.fixture.state_path, state)
                self.fixture.supervisor(NOW + 3000).pass_once(runtime, failed)
                self.assertEqual(self.remediation_posts(), [])
                self.assertEqual(self.state()["roots"], state["roots"])
                if constraint == "stop":
                    (self.fixture.directory / "STOP").unlink()
                if constraint == "certificate":
                    self.fixture.config.pop("certificate_not_after")

    def test_unknown_post_retries_same_repair_reservation_without_new_ledger_or_fuel(self):
        self.closed_review()
        failed = self.install_review()
        self.fixture.api.post_errors = ["transport_unknown"]
        self.assertEqual(self.fixture.run_pass(NOW + 3000, failed)["action"], "root_transport_unknown")
        before = self.state()
        self.fixture.run_pass(NOW + 3500, failed)
        self.fixture.run_pass(NOW + 4300, failed)
        after = self.state()
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["qa_remediation_requests"], before["qa_remediation_requests"])
        self.assertEqual(after["active_root"]["payload"], before["active_root"]["payload"])
        self.assertEqual(after["active_root"]["attempts"], 2)
        self.assertEqual(self.remediation_posts()[0], self.remediation_posts()[1])

    def test_repair_auth_resume_needs_nonce_and_preserves_same_reservation(self):
        self.closed_review()
        failed = self.install_review()
        self.fixture.api.post_errors = ["unauthorized"]
        self.assertEqual(self.fixture.run_pass(NOW + 3000, failed)["action"], "unauthorized")
        before = self.state()
        event = SUP.STATE.auth_resume_event(self.fixture.config["goal_sha256"], NOW + 4300)
        path = self.fixture.directory / "RESUME.json"
        path.write_text(json.dumps(event))
        path.chmod(0o600)
        self.fixture.run_pass(NOW + 4300, failed)
        after = self.state()
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["active_root"]["payload"], before["active_root"]["payload"])
        self.assertEqual(after["auth_resume_nonces"], [event["nonce"]])
        self.assertIn("message_id", after["active_root"])

    def test_legacy_owner_repair_closes_without_new_token_or_verdict_and_cannot_replay(self):
        baseline, _ = self.closed_review()
        failed = self.install_review()
        legacy = copy.deepcopy(failed)
        legacy["qa_review"].pop("verdict")
        supervisor = self.fixture.supervisor(NOW + 3000)
        key = "praxis-owner-repair:1767:" + failed["goal_sha256"][:16] + ":" + failed["qa_review"]["cohort_sha256"]
        root = {"payload": supervisor.payload(key, SUP.ROOT_TEXT), "baseline": legacy, "purpose": "qa_remediation",
                "review_cohort": failed["qa_review"]["cohort_sha256"], "reserved_at": NOW + 3000, "owner_request_id": 1767}
        supervisor.state["active_root"] = root
        supervisor.state["phase"] = "root_reserved"
        supervisor.state["roots"][SUP.STATE.utc_day(NOW)] += 1
        supervisor.save()
        supervisor.publish(root)
        before = self.state()
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 3300, failed)["action"], "no_measured_progress")
        self.assertEqual(self.state()["roots"], before["roots"])
        self.assertEqual(self.state()["progress_pause_baseline"], baseline)
        self.assertEqual(self.state()["progress_pause_binding"], before["progress_pause_binding"])
        record = next(iter(self.state()["qa_remediation_requests"].values()))
        self.assertEqual(record["key"], key)
        self.assertEqual(record["owner_request_id"], 1767)
        self.assertEqual(record["outcome"], "no_measured_progress")
        self.assertEqual(self.fixture.run_pass(NOW + 10000, failed)["action"], "no_measured_progress")
        self.assertEqual(len(self.fixture.engineering_posts()), 3)


if __name__ == "__main__":
    unittest.main()
