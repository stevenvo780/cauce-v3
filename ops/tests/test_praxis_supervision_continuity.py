from __future__ import annotations

import copy
import json
import unittest
from unittest import mock

import test_praxis_supervision as fixtures
import test_praxis_visual_review as visual_fixtures
from test_praxis_supervision_evidence import proof_fixture

# cauce:requiere none

SUP, NOW, NEXT_HEAD = fixtures.SUP, fixtures.NOW, fixtures.NEXT_HEAD


class SupervisionContinuityTests(unittest.TestCase):
    def setUp(self):
        self.visual = visual_fixtures.VisualReviewTests()
        self.visual.setUp()
        self.fixture = self.visual.fixture

    def tearDown(self):
        self.visual.tearDown()

    def state(self):
        return json.loads(self.fixture.state_path.read_text())

    def awaiting_review(self):
        baseline, root, pending = self.visual.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        self.assertEqual(self.fixture.run_pass(NOW + 2100, pending)["action"], "review_contract_incomplete")
        return baseline, root, pending

    def current_review(self, implementation=None, independent=True):
        if implementation is not None:
            (self.fixture.workspace / "apps/web/app.js").write_text(implementation)
        verification = proof_fixture(self.fixture, NEXT_HEAD)
        image = self.fixture.workspace / "screen.png"
        image.write_bytes(b"different independently inspected synthetic capture")
        capture = {"path": "screen.png", "sha256": SUP.digest(image.read_bytes())}
        path = self.fixture.workspace / "qa-proof.json"
        qa = json.loads(path.read_text())
        qa["runs"][0]["screenshots"] = [capture]
        qa["inspected_images"] = [capture] if independent else []
        qa["review"]["independent"] = independent
        path.write_text(json.dumps(qa))
        verification["gates"][2]["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
        self.fixture.write_json("verification.json", verification)
        return self.fixture.snapshot(NEXT_HEAD)

    def failed_review(self):
        baseline, original, pending = self.visual.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        review_root = self.state()["active_root"]
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "failed", "reply": None}]}
        self.assertEqual(self.fixture.run_pass(NOW + 2100, pending)["action"], "visual_review_failed")
        return baseline, original, pending, review_root

    def test_failed_review_recovers_once_after_real_current_approved_qa(self):
        baseline, original, pending, review_root = self.failed_review()
        before, payloads = self.state(), copy.deepcopy(self.fixture.engineering_posts())
        self.assertEqual(self.fixture.run_pass(NOW + 90000, pending)["action"], "circuit_paused")
        self.assertNotIn("visual_review_failure_recoveries", self.state())
        approved = self.visual.approved()
        self.assertTrue(SUP.made_progress(baseline, approved))
        self.assertEqual(self.fixture.run_pass(NOW + 91000, approved)["action"], "visual_review_failed_recovered")
        recovered = self.state()
        self.assertEqual(recovered["phase"], "observing")
        self.assertTrue(recovered["continuation_earned"])
        self.assertEqual(recovered["progress_pause_baseline"], baseline)
        self.assertEqual(recovered["progress_pause_binding"], before["progress_pause_binding"])
        self.assertEqual(recovered["roots"], before["roots"])
        self.assertEqual(recovered["visual_review_roots"], before["visual_review_roots"])
        self.assertEqual(recovered["visual_review_requests"], before["visual_review_requests"])
        self.assertEqual(self.fixture.engineering_posts(), payloads)
        record = recovered["visual_review_failure_recoveries"][0]
        self.assertEqual(record["reason"], "visual_review_failed")
        self.assertEqual(record["root"], original["message_id"])
        self.assertEqual(record["failed_review_root"], review_root["message_id"])
        self.assertEqual(record["binding"], before["progress_pause_binding"])
        self.assertEqual(len(recovered["progress_recoveries"]), 1)
        self.assertEqual(self.fixture.run_pass(NOW + 91500, approved)["action"], "cooldown")
        self.assertEqual(self.fixture.run_pass(NOW + 92201, approved)["action"], "root_published")
        self.fixture.api.receipt = {"chain_open": True, "deliveries": [{"status": "started"}]}
        self.fixture.run_pass(NOW + 94000, approved)
        self.assertEqual(len(self.fixture.engineering_posts()), 3)
        self.assertEqual(len(self.state()["visual_review_failure_recoveries"]), 1)
        replay = copy.deepcopy(before)
        replay["visual_review_failure_recoveries"] = recovered["visual_review_failure_recoveries"]
        SUP.atomic_save(self.fixture.state_path, replay)
        self.assertEqual(self.fixture.run_pass(NOW + 96000, approved)["action"], "circuit_paused")
        self.assertFalse(self.state()["continuation_earned"])

    def test_failed_review_can_reconcile_approved_new_cohort_without_rewriting_request(self):
        baseline, _, pending, _ = self.failed_review()
        before = self.state()
        current = self.current_review("corrected and freshly tested implementation")
        self.assertNotEqual(current["qa_review"]["cohort_sha256"], pending["qa_review"]["cohort_sha256"])
        self.assertTrue(SUP.made_progress(baseline, current))
        self.assertEqual(self.fixture.run_pass(NOW + 3000, current)["action"], "visual_review_failed_recovered")
        recovered = self.state()
        self.assertTrue(recovered["continuation_earned"])
        self.assertEqual(recovered["progress_pause_baseline"], baseline)
        self.assertEqual(recovered["progress_pause_binding"], before["progress_pause_binding"])
        self.assertEqual(recovered["visual_review_requests"], before["visual_review_requests"])
        self.assertEqual(recovered["roots"], before["roots"])
        self.assertEqual(recovered["visual_review_reconciliations"][0]["old_cohort_sha256"], pending["qa_review"]["cohort_sha256"])

    def test_failed_review_recovery_requires_fresh_idle_proof_and_causal_original_binding(self):
        _, _, _, review_root = self.failed_review()
        original = self.state()
        approved = self.visual.approved()
        for constraint in ("active", "readiness", "stale_runtime", "idle", "recent_finish", "recent_activity", "foreign_goal", "stale_proof", "tests", "snapshot",
                           "qa", "sources", "baseline", "binding", "baseline_hash", "wrong_cohort", "open_review", "metadata",
                           "live_root", "unknown_root", "stop", "unauthorized", "foreign_receipt", "causal_receipt_mismatch",
                           "untrusted_control_file", "quota_exhausted", "preview_rollback_unknown", "certificate"):
            with self.subTest(constraint=constraint):
                state, evidence = copy.deepcopy(original), copy.deepcopy(approved)
                runtime = {**self.fixture.runtime(), "observed_at": NOW + 3000}
                if constraint == "active":
                    runtime["active"] = 1
                if constraint == "readiness":
                    runtime["ready"] = False
                if constraint == "stale_runtime":
                    runtime["observed_at"] = NOW
                if constraint == "idle":
                    state["idle_since"] = NOW + 2999
                if constraint == "recent_finish":
                    state["last_review_finished"]["at"] = NOW + 2999
                if constraint == "recent_activity":
                    runtime["last_activity_at"] = NOW + 2999
                if constraint == "foreign_goal":
                    evidence["goal_sha256"] = "f" * 64
                if constraint == "stale_proof":
                    evidence["verification_source_current"] = False
                if constraint in {"tests", "snapshot", "qa"}:
                    evidence["valid_gates"].remove(constraint)
                if constraint == "sources":
                    evidence["source_files_match"] = False
                if constraint == "baseline":
                    state.pop("progress_pause_baseline")
                if constraint == "binding":
                    state["progress_pause_binding"]["trace_id"] = "foreign-trace"
                if constraint == "baseline_hash":
                    state["progress_pause_binding"]["baseline_sha256"] = "f" * 64
                if constraint == "wrong_cohort":
                    state["last_review_finished"]["cohort_sha256"] = "f" * 64
                if constraint == "open_review":
                    state["visual_review_requests"][state["pending_visual_review"]["cohort_sha256"]]["status"] = "reserved"
                if constraint == "metadata":
                    state["progress_pause_baseline"] = copy.deepcopy(evidence)
                    state["progress_pause_binding"]["baseline_sha256"] = SUP.digest(SUP.canonical(evidence))
                if constraint in {"live_root", "unknown_root"}:
                    state["active_root"] = copy.deepcopy(review_root)
                    if constraint == "live_root":
                        self.fixture.api.receipt = {"chain_open": True, "deliveries": [{"status": "started"}]}
                    else:
                        state["active_root"].pop("message_id")
                        state["active_root"]["error"] = "transport_unknown"
                if constraint == "stop":
                    (self.fixture.directory / "STOP").write_text("owner stop")
                if constraint in {"unauthorized", "foreign_receipt", "causal_receipt_mismatch", "untrusted_control_file",
                                   "quota_exhausted", "preview_rollback_unknown"}:
                    state["pause_reason"] = constraint
                if constraint == "certificate":
                    self.fixture.config["certificate_not_after"] = NOW + 1
                SUP.atomic_save(self.fixture.state_path, state)
                supervisor = self.fixture.supervisor(NOW + 3000)
                supervisor.pass_once(runtime, evidence)
                self.assertFalse(self.state().get("continuation_earned"))
                self.assertNotIn("visual_review_failure_recoveries", self.state())
                self.assertEqual(self.state()["roots"], original["roots"])
                if constraint == "stop":
                    (self.fixture.directory / "STOP").unlink()
                if constraint == "certificate":
                    self.fixture.config.pop("certificate_not_after")

    def test_failed_or_unknown_inspected_qa_verdict_never_recovers_failed_delivery(self):
        _, _, _, _ = self.failed_review()
        before = self.state()
        self.visual.approved()
        verification = json.loads((self.fixture.workspace / "verification.json").read_text())
        original = json.loads((self.fixture.workspace / "qa-proof.json").read_text())
        for outcome in ("failed", "unknown", None):
            with self.subTest(outcome=outcome):
                report = copy.deepcopy(original)
                report["review"].update(independent=True, performed=True, outcome=outcome)
                path = self.fixture.workspace / "qa-proof.json"
                path.write_text(json.dumps(report))
                verification["gates"][2]["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
                self.fixture.write_json("verification.json", verification)
                current = self.fixture.snapshot(NEXT_HEAD)
                self.assertNotIn("qa", current["valid_gates"])
                SUP.atomic_save(self.fixture.state_path, before)
                self.assertEqual(self.fixture.run_pass(NOW + 3000, current)["action"], "circuit_paused")
                self.assertFalse(self.state()["continuation_earned"])
                self.assertNotIn("visual_review_failure_recoveries", self.state())

    def test_official_qa_consumer_rejects_failed_review_even_with_approval_flag(self):
        baseline = self.current_review()
        original = json.loads((self.fixture.workspace / "qa-proof.json").read_text())
        verification = json.loads((self.fixture.workspace / "verification.json").read_text())
        for outcome, approved in (("legacy", True), ("passed", True), ("failed", False), (None, False), ("unknown", False)):
            with self.subTest(outcome=outcome):
                report = copy.deepcopy(original)
                report["review"].update(independent=True, performed=True)
                if outcome != "legacy":
                    report["review"]["outcome"] = outcome
                self.assertEqual(report["status"], "passed")
                self.assertEqual(report["exit_code"], 0)
                path = self.fixture.workspace / "qa-proof.json"
                path.write_text(json.dumps(report))
                verification["gates"][2]["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
                self.fixture.write_json("verification.json", verification)
                current = self.fixture.snapshot(NEXT_HEAD)
                self.assertEqual("qa" in current["valid_gates"], approved)
                self.assertTrue(current["qa_executed"])
                self.assertTrue(current["verified_engineering"])
                self.assertEqual(current["qa_review"]["cohort_sha256"], baseline["qa_review"]["cohort_sha256"])
                self.assertFalse(SUP.made_progress(baseline, current))

    def test_new_approved_cohort_recovers_original_baseline_and_history_once(self):
        baseline, root, pending = self.awaiting_review()
        before, payloads = self.state(), copy.deepcopy(self.fixture.engineering_posts())
        current = self.current_review("new tested implementation in the current cohort")
        self.assertNotEqual(current["qa_review"]["cohort_sha256"], pending["qa_review"]["cohort_sha256"])
        self.assertEqual(self.fixture.run_pass(NOW + 3000, current)["action"], "idle_observation")
        after = self.state()
        self.assertTrue(after["continuation_earned"])
        self.assertEqual(after["progress_pause_baseline"], baseline)
        self.assertEqual(after["progress_pause_binding"], before["progress_pause_binding"])
        self.assertEqual(after["visual_review_requests"], before["visual_review_requests"])
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["visual_review_roots"], before["visual_review_roots"])
        self.assertEqual(self.fixture.engineering_posts(), payloads)
        record = after["visual_review_reconciliations"][0]
        self.assertEqual(record["root"], root["message_id"])
        self.assertEqual(record["old_cohort_sha256"], pending["qa_review"]["cohort_sha256"])
        self.fixture.run_pass(NOW + 3500, current)
        self.assertEqual(len(self.state()["visual_review_reconciliations"]), 1)
        self.fixture.run_pass(NOW + 4201, current)
        self.fixture.api.receipt["chain_open"] = True
        self.fixture.run_pass(NOW + 5500, current)
        self.assertEqual(len(self.fixture.engineering_posts()), 3)

    def test_changed_captures_restore_held_causal_credit_without_new_code_credit(self):
        pending = self.visual.legacy_earned()
        self.fixture.run_pass(NOW + 1800, pending)
        self.fixture.run_pass(NOW + 2100, pending)
        before = self.state()
        current = self.current_review()
        self.assertFalse(SUP.made_progress(pending, current))
        self.fixture.run_pass(NOW + 3000, current)
        after = self.state()
        held = after["review_held_continuation"]
        self.assertEqual(held["status"], "restored")
        self.assertEqual(held["credit_id"], before["review_held_continuation"]["credit_id"])
        self.assertEqual(held["cohort_sha256"], pending["qa_review"]["cohort_sha256"])
        self.assertEqual(after["roots"], before["roots"])
        self.fixture.run_pass(NOW + 4201, current)
        self.assertEqual(self.state()["review_held_continuation"]["status"], "consumed")
        self.fixture.api.receipt["chain_open"] = True
        self.fixture.run_pass(NOW + 6000, current)
        self.assertEqual(len(self.fixture.engineering_posts()), 3)

    def test_new_cohort_requires_fresh_idle_and_causal_engineering(self):
        _, _, pending = self.awaiting_review()
        original = self.state()
        current = self.current_review()
        for constraint in ("active", "stale_runtime", "idle", "stale_proof", "foreign_goal", "baseline", "binding", "metadata"):
            with self.subTest(constraint=constraint):
                state, evidence = copy.deepcopy(original), copy.deepcopy(current)
                runtime = {**self.fixture.runtime(), "observed_at": NOW + 3000}
                if constraint == "active":
                    runtime["active"] = 1
                if constraint == "stale_runtime":
                    runtime["observed_at"] = NOW
                if constraint == "idle":
                    state["idle_since"] = NOW + 2999
                if constraint == "stale_proof":
                    evidence["verified_engineering"] = False
                if constraint == "foreign_goal":
                    evidence["goal_sha256"] = "f" * 64
                if constraint == "baseline":
                    state.pop("progress_pause_baseline")
                if constraint == "binding":
                    state["progress_pause_binding"]["trace_id"] = "foreign-trace"
                if constraint == "metadata":
                    state["progress_pause_baseline"] = copy.deepcopy(evidence)
                    state["progress_pause_binding"]["baseline_sha256"] = SUP.digest(SUP.canonical(evidence))
                SUP.atomic_save(self.fixture.state_path, state)
                supervisor = self.fixture.supervisor(NOW + 3000)
                supervisor.pass_once(runtime, evidence)
                self.assertFalse(self.state().get("continuation_earned"))
                self.assertNotIn("visual_review_reconciliations", self.state())
                self.assertEqual(self.state()["pending_visual_review"], pending["qa_review"])

    def test_live_review_root_and_stop_prevent_cohort_reconciliation(self):
        _, _, pending = self.visual.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        self.fixture.api.receipt["chain_open"] = True
        before = self.state()
        current = self.current_review()
        self.assertEqual(self.fixture.run_pass(NOW + 3000, current)["action"], "root_pending")
        self.assertEqual(self.state()["active_root"], before["active_root"])
        self.assertNotIn("visual_review_reconciliations", self.state())
        (self.fixture.directory / "STOP").write_text("owner stop")
        self.assertEqual(self.fixture.run_pass(NOW + 4000, current)["action"], "owner_stopped")
        self.assertEqual(self.state()["roots"], before["roots"])
        self.assertNotIn("visual_review_reconciliations", self.state())

    def progressed(self):
        (self.fixture.workspace / "apps/web/app.js").write_text("fresh tested implementation")
        proof_fixture(self.fixture, NEXT_HEAD)
        return self.fixture.snapshot(NEXT_HEAD)

    def test_observation_failures_preserve_known_root_then_close_it_once(self):
        self.fixture.run_pass()
        before = self.state()
        for reason in SUP.TRANSIENT_OBSERVATION_CODES:
            with self.subTest(reason=reason):
                SUP.atomic_save(self.fixture.state_path, before)
                supervisor = self.fixture.supervisor(NOW + 300)
                supervisor.observation_failure(reason)
                self.assertEqual(self.state()["active_root"], before["active_root"])
                self.assertEqual(self.state()["phase"], "root_reserved")
                self.assertEqual(self.state()["roots"], before["roots"])
                self.assertEqual(self.fixture.run_pass(NOW + 600)["action"], "root_pending")
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        current = self.progressed()
        self.assertEqual(self.fixture.run_pass(NOW + 900, current)["action"], "root_finished_progress")
        self.assertTrue(self.state()["continuation_earned"])
        self.assertEqual(self.state()["roots"], before["roots"])
        self.fixture.run_pass(NOW + 1000, current)
        self.assertEqual(len(self.fixture.engineering_posts()), 1)

    def test_main_transient_exception_preserves_durable_phase_and_root(self):
        self.fixture.run_pass()
        before = self.state()
        config = dict(self.fixture.config, pass_seconds=55)
        snapshot = self.fixture.snapshot()
        for reason in SUP.TRANSIENT_OBSERVATION_CODES:
            with self.subTest(reason=reason):
                SUP.atomic_save(self.fixture.state_path, before)
                with mock.patch.object(SUP, "load_config", return_value=config), \
                        mock.patch.object(SUP, "Api", return_value=self.fixture.api), \
                        mock.patch.object(SUP, "engineering_snapshot", return_value=snapshot), \
                        mock.patch.object(SUP, "runtime_snapshot", return_value=self.fixture.runtime()), \
                        mock.patch.object(SUP, "certificate_expiry", return_value=NOW + 1000000), \
                        mock.patch.object(SUP.time, "time", return_value=NOW), \
                        mock.patch.object(SUP.PREVIEW, "publish", side_effect=SUP.SupervisionError(reason)), \
                        mock.patch.object(SUP.signal, "signal"), mock.patch.object(SUP.signal, "alarm"), \
                        mock.patch("sys.argv", ["praxis-supervision.py", "--state", str(self.fixture.state_path)]), \
                        mock.patch("builtins.print"):
                    self.assertEqual(SUP.main(), 0)
                self.assertEqual(self.state()["active_root"], before["active_root"])
                self.assertEqual(self.state()["phase"], "root_reserved")
                self.assertEqual(self.state()["roots"], before["roots"])
                self.assertEqual(self.state()["observation_failure"]["code"], reason)
        self.assertEqual(len(self.fixture.engineering_posts()), 1)

    def test_timeout_with_unknown_post_retries_only_same_reservation_three_times(self):
        self.fixture.api.post_errors = ["transport_unknown"] * 3
        self.fixture.run_pass()
        before = self.state()
        self.fixture.supervisor(NOW + 300).observation_failure("pass_timeout")
        self.fixture.run_pass(NOW + 1201)
        self.assertEqual(self.fixture.run_pass(NOW + 2402)["action"], "transport_reconciliation_required")
        self.assertEqual(self.fixture.run_pass(NOW + 3603)["action"], "circuit_paused")
        after = self.state()
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["active_root"]["baseline"], before["active_root"]["baseline"])
        self.assertEqual(after["active_root"]["payload"], before["active_root"]["payload"])
        self.assertEqual(after["active_root"]["attempts"], 3)
        self.assertNotIn("message_id", after["active_root"])
        posts = self.fixture.engineering_posts()
        self.assertEqual(len(posts), 3)
        self.assertTrue(all(post == posts[0] for post in posts))

    def test_already_paused_transient_root_requires_same_closed_causal_chain(self):
        self.fixture.run_pass()
        before = self.state()
        current = self.progressed()
        for reason in SUP.TRANSIENT_OBSERVATION_CODES:
            with self.subTest(reason=reason):
                state = copy.deepcopy(before)
                state.update(phase="circuit_paused", pause_reason=reason)
                SUP.atomic_save(self.fixture.state_path, state)
                self.fixture.api.receipt = {"chain_open": True, "deliveries": [{"status": "started"}]}
                self.assertEqual(self.fixture.run_pass(NOW + 300, current)["action"], "root_pending")
                self.assertEqual(self.state()["phase"], "circuit_paused")
                self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
                supervisor = self.fixture.supervisor(NOW + 600)
                supervisor.failure_reader = mock.Mock(side_effect=SUP.SupervisionError("observation_unavailable"))
                self.assertEqual(supervisor.pass_once(self.fixture.runtime(), current)["action"], "chain_receipt_unavailable")
                self.assertEqual(self.state()["active_root"], before["active_root"])
                self.assertEqual(self.fixture.run_pass(NOW + 900, current)["action"], "root_finished_progress")
                self.assertEqual(self.state()["observation_recoveries"][0]["root"], before["active_root"]["message_id"])
                self.assertTrue(self.state()["continuation_earned"])
                self.assertEqual(self.state()["roots"], before["roots"])
        self.assertEqual(len(self.fixture.engineering_posts()), 1)

    def test_hard_pauses_are_not_reopened_by_healthy_receipt_or_ready_actors(self):
        self.fixture.run_pass()
        before = self.state()
        current = self.progressed()
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        for reason in ("foreign_receipt", "causal_receipt_mismatch", "unauthorized", "supervisor_certificate_expired",
                       "preview_rollback_unknown", "foreign_goal", "untrusted_control_file", "quota_exhausted"):
            with self.subTest(reason=reason):
                state = copy.deepcopy(before)
                state.update(phase="circuit_paused", pause_reason=reason)
                SUP.atomic_save(self.fixture.state_path, state)
                self.assertEqual(self.fixture.run_pass(NOW + 30000, current)["action"], "circuit_paused")
                self.assertEqual(self.state()["active_root"], before["active_root"])
                self.assertFalse(self.state().get("continuation_earned"))
                self.assertNotIn("observation_recoveries", self.state())

    def test_transient_pause_still_rejects_foreign_causal_receipt(self):
        self.fixture.run_pass()
        supervisor = self.fixture.supervisor(NOW + 300)
        supervisor.state.update(phase="circuit_paused", pause_reason="pass_timeout")
        supervisor.save()
        before = self.state()
        message_id = before["active_root"]["message_id"]
        self.fixture.api.bindings[message_id]["trace_id"] = "foreign-trace"
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done"}]}
        self.assertEqual(self.fixture.run_pass(NOW + 600, self.progressed())["action"], "causal_receipt_mismatch")
        self.assertEqual(self.state()["active_root"], before["active_root"])
        self.assertFalse(self.state().get("continuation_earned"))

    def test_readiness_recovers_once_with_fresh_idle_preserving_fuel_and_cooldown(self):
        self.assertEqual(self.fixture.run_pass(ready=False)["action"], "actors_unavailable")
        state = self.state()
        state["cooldown_until"] = NOW + 2000
        state["roots"] = {SUP.STATE.utc_day(NOW): 4}
        SUP.atomic_save(self.fixture.state_path, state)
        self.assertEqual(self.fixture.run_pass(NOW + 479)["action"], "actors_readiness_pending")
        supervisor = self.fixture.supervisor(NOW + 600)
        self.assertEqual(supervisor.pass_once(self.fixture.runtime(), self.fixture.snapshot())["action"], "actors_readiness_pending")
        self.assertEqual(self.fixture.run_pass(NOW + 601)["action"], "cooldown")
        recovered = self.state()
        self.assertEqual(recovered["roots"], state["roots"])
        self.assertEqual(recovered["cooldown_until"], state["cooldown_until"])
        self.fixture.run_pass(NOW + 800)
        self.assertEqual(len(self.state()["readiness_recoveries"]), 1)
        self.assertEqual(self.fixture.engineering_posts(), [])

    def test_readiness_does_not_override_capacity_auth_expiry_or_stop(self):
        for reason in ("unauthorized", "quota_exhausted", "supervisor_certificate_expired"):
            with self.subTest(reason=reason):
                supervisor = self.fixture.supervisor()
                supervisor.state.update(phase="circuit_paused", pause_reason=reason, backoff_until=NOW - 1)
                supervisor.save()
                self.assertEqual(self.fixture.run_pass(NOW + 600, ready=False)["action"], "circuit_paused")
                self.assertEqual(self.state()["pause_reason"], reason)
                self.assertEqual(self.fixture.run_pass(NOW + 30000)["action"], "circuit_paused")
                self.assertNotIn("readiness_recoveries", self.state())
        (self.fixture.directory / "STOP").write_text("owner stop")
        self.assertEqual(self.fixture.run_pass(NOW + 40000)["action"], "owner_stopped")
        self.assertEqual(self.fixture.engineering_posts(), [])

    def test_review_incomplete_notice_is_causal_unique_and_real_qa_can_finish_it(self):
        _, _, pending = self.awaiting_review()
        before = self.state()
        for elapsed in (3000, 90000, 180000):
            self.assertEqual(self.fixture.run_pass(NOW + elapsed, pending)["action"], "review_contract_incomplete")
        self.assertEqual(len(self.fixture.engineering_posts()), 2)
        self.assertEqual(len(self.fixture.api.posts), 3)
        self.assertEqual(self.state()["roots"], before["roots"])
        approved = self.visual.approved()
        self.assertEqual(self.fixture.run_pass(NOW + 181000, approved)["action"], "idle_observation")
        self.assertTrue(self.state()["continuation_earned"])
        self.assertEqual(len(self.fixture.api.posts), 3)

    def test_review_notice_waits_for_notice_fuel_without_reposting_review(self):
        _, _, pending = self.visual.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        state = self.state()
        state["notice_post_attempts"] = {SUP.STATE.utc_day(NOW + 2100): self.fixture.config["notice_limit"]}
        SUP.atomic_save(self.fixture.state_path, state)
        self.assertEqual(self.fixture.run_pass(NOW + 2100, pending)["action"], "review_contract_incomplete")
        self.assertEqual(len(self.fixture.api.posts), 2)
        self.fixture.run_pass(NOW + 90000, pending)
        self.assertEqual(len(self.fixture.api.posts), 3)
        self.fixture.run_pass(NOW + 180000, pending)
        self.assertEqual(len(self.fixture.api.posts), 3)
        self.assertEqual(len(self.fixture.engineering_posts()), 2)
        self.assertEqual(self.state()["roots"], state["roots"])

    def bind_docs(self, verification, names):
        sources = dict(verification["source_files"])
        sources.update({name: SUP.digest((self.fixture.workspace / name).read_bytes()) for name in names})
        verification["source_files"] = sources
        for gate in verification["gates"]:
            if gate.get("id") not in {"tests", "qa", "snapshot"}:
                continue
            gate["source_files"] = sources
            artifact = gate["artifacts"][0]
            path = self.fixture.workspace / artifact["path"]
            report = json.loads(path.read_text())
            report["source_files"] = sources
            path.write_text(json.dumps(report))
            artifact["sha256"] = SUP.digest(path.read_bytes())
        self.fixture.write_json("verification.json", verification)

    def test_tested_runtime_plus_documentation_counts_but_all_sources_must_be_current(self):
        for name in ("README.md", "AGENTS.md"):
            (self.fixture.workspace / name).write_text("old documentation")
        verification = proof_fixture(self.fixture)
        self.bind_docs(verification, ("README.md", "AGENTS.md"))
        previous = self.fixture.snapshot()
        (self.fixture.workspace / "apps/web/app.js").write_text("tested runtime correction")
        for name in ("README.md", "AGENTS.md"):
            (self.fixture.workspace / name).write_text("fresh documentation matching the correction")
        verification = proof_fixture(self.fixture, NEXT_HEAD)
        self.bind_docs(verification, ("README.md", "AGENTS.md"))
        current = self.fixture.snapshot(NEXT_HEAD)
        self.assertTrue(SUP.made_progress(previous, current))
        for name in ("README.md", "AGENTS.md"):
            path = self.fixture.workspace / name
            original = path.read_text()
            path.write_text("stale unbound documentation")
            self.assertFalse(SUP.made_progress(previous, self.fixture.snapshot(NEXT_HEAD)))
            path.write_text(original)

    def test_documentation_only_and_unexecuted_scripts_do_not_earn_progress(self):
        path = self.fixture.workspace / "README.md"
        path.write_text("old docs")
        verification = proof_fixture(self.fixture)
        self.bind_docs(verification, ("README.md",))
        previous = self.fixture.snapshot()
        path.write_text("new docs")
        verification = proof_fixture(self.fixture, NEXT_HEAD)
        self.bind_docs(verification, ("README.md",))
        current = self.fixture.snapshot(NEXT_HEAD)
        self.assertFalse(SUP.made_progress(previous, current))
        current["source_hashes"]["apps/web/app.js"] = "f" * 64
        current["tested_source_hashes"]["apps/web/app.js"] = "f" * 64
        previous["source_hashes"]["scripts/qa_professional.py"] = "a" * 64
        current["source_hashes"]["scripts/qa_professional.py"] = "b" * 64
        self.assertFalse(SUP.made_progress(previous, current))
        current["tested_source_hashes"]["scripts/qa_professional.py"] = "b" * 64
        self.assertTrue(SUP.made_progress(previous, current))

    def test_executed_regression_test_delta_counts_without_production_logic_change(self):
        proof_fixture(self.fixture)
        previous = self.fixture.snapshot()
        (self.fixture.workspace / "apps/web/test_app.js").write_text("new regression asserting a previously uncovered behavior")
        sources = {str(path.relative_to(self.fixture.workspace)): SUP.digest(path.read_bytes())
                   for path in (self.fixture.workspace / "apps/web").iterdir()}
        verification = json.loads((self.fixture.workspace / "verification.json").read_text())
        verification["source_commit"] = verification["integration_commit"] = NEXT_HEAD
        for gate in verification["gates"]:
            if gate.get("id") in {"tests", "qa", "snapshot"}:
                gate["source_commit"] = NEXT_HEAD
                path = self.fixture.workspace / gate["artifacts"][0]["path"]
                report = json.loads(path.read_text())
                report["source_commit"] = NEXT_HEAD
                path.write_text(json.dumps(report))
                gate["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
        self.bind_docs(verification, sources)
        current = self.fixture.snapshot(NEXT_HEAD)
        self.assertEqual(previous["source_hashes"]["apps/web/app.js"], current["source_hashes"]["apps/web/app.js"])
        self.assertTrue(SUP.made_progress(previous, current))
        current["tested_source_hashes"].pop("apps/web/test_app.js")
        self.assertFalse(SUP.made_progress(previous, current))


if __name__ == "__main__":
    unittest.main()
