from __future__ import annotations

import copy
import json
import time
import unittest
from unittest import mock

import test_praxis_supervision as fixtures
from test_praxis_supervision_evidence import proof_fixture

# cauce:requiere none

SUP, NOW, HEAD, NEXT_HEAD = fixtures.SUP, fixtures.NOW, fixtures.HEAD, fixtures.NEXT_HEAD


class VisualReviewTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def pending(self, head=NEXT_HEAD):
        (self.fixture.workspace / "apps/web/app.js").write_text("new verified product implementation")
        verification = proof_fixture(self.fixture, head)
        path = self.fixture.workspace / "qa-proof.json"
        qa = json.loads(path.read_text())
        qa["runs"][0]["screenshots"] = copy.deepcopy(qa["inspected_images"])
        qa["review"]["independent"] = False
        qa["inspected_images"] = []
        path.write_text(json.dumps(qa))
        verification["gates"][2]["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
        self.fixture.write_json("verification.json", verification)
        return self.fixture.snapshot(head)

    def approved(self):
        verification = json.loads((self.fixture.workspace / "verification.json").read_text())
        path = self.fixture.workspace / "qa-proof.json"
        qa = json.loads(path.read_text())
        qa["review"]["independent"] = True
        qa["inspected_images"] = qa["runs"][0]["screenshots"]
        path.write_text(json.dumps(qa))
        verification["gates"][2]["artifacts"][0]["sha256"] = SUP.digest(path.read_bytes())
        self.fixture.write_json("verification.json", verification)
        return self.fixture.snapshot(NEXT_HEAD)

    def reserve_engineering(self):
        baseline = self.fixture.snapshot()
        self.fixture.run_pass(snapshot=baseline)
        before = json.loads(self.fixture.state_path.read_text())
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": "completed implementation"}]}
        pending = self.pending()
        self.assertEqual(self.fixture.run_pass(NOW + 300, pending)["action"], "visual_review_pending")
        return baseline, before["active_root"], pending

    def test_engineering_baseline_is_preserved_while_visual_gate_is_pending(self):
        baseline, root, pending = self.reserve_engineering()
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["progress_pause_baseline"], baseline)
        self.assertEqual(state["progress_pause_binding"]["root"], root["message_id"])
        self.assertEqual(state["progress_pause_binding"]["baseline_sha256"], SUP.digest(SUP.canonical(baseline)))
        self.assertEqual(state["phase"], "waiting_visual_review")
        self.assertFalse(state["continuation_earned"])
        self.assertTrue(SUP.made_progress(baseline, pending))
        self.assertEqual(state["last_finished"]["engineering"], pending)

    def test_one_causal_review_root_uses_existing_actor_and_root_budget(self):
        baseline, original, pending = self.reserve_engineering()
        self.fixture.api.receipt = {"chain_open": True, "deliveries": [{"status": "started", "reply": None}]}
        self.assertEqual(self.fixture.run_pass(NOW + 1800, pending)["action"], "visual_review_requested")
        state = json.loads(self.fixture.state_path.read_text())
        review = state["active_root"]
        self.assertEqual(review["purpose"], "visual_review")
        self.assertEqual(review["payload"]["recipients"], [{"tenant_id": "Hospital", "alias": "operador"}])
        self.assertEqual(review["payload"]["body"]["type"], "praxis.supervision.continue")
        self.assertEqual(review["payload"]["body"]["supervision"]["visual_review"], pending["qa_review"])
        self.assertEqual(review["payload"]["body"]["supervision"]["original_root"], original["message_id"])
        self.assertEqual(state["progress_pause_baseline"], baseline)
        self.assertEqual(sum(state["roots"].values()), 2)
        self.assertFalse(state["continuation_earned"])
        self.assertEqual(self.fixture.run_pass(NOW + 3600, pending)["action"], "root_pending")
        self.assertEqual(len(self.fixture.engineering_posts()), 2)

    def test_visual_approval_recovers_only_original_code_and_test_progress(self):
        baseline, _, pending = self.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        approved = self.approved()
        self.assertEqual(approved["qa_review"]["cohort_sha256"], pending["qa_review"]["cohort_sha256"])
        self.assertFalse(SUP.made_progress(pending, approved))
        self.assertTrue(SUP.made_progress(baseline, approved))
        self.assertEqual(self.fixture.run_pass(NOW + 2100, approved)["action"], "visual_review_completed")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertTrue(state["continuation_earned"])
        self.assertEqual(state["progress_pause_baseline"], baseline)
        self.assertEqual(state["last_finished"]["engineering"], pending)
        self.assertEqual(state["progress_recoveries"][-1]["reason"], "visual_review_completed")

    def unauthorized_review(self):
        _, _, pending = self.reserve_engineering()
        self.fixture.api.post_errors = ["unauthorized"]
        self.assertEqual(self.fixture.run_pass(NOW + 1800, pending)["action"], "unauthorized")
        supervisor = self.fixture.supervisor(NOW + 2100)
        event = SUP.STATE.auth_resume_event(self.fixture.config["goal_sha256"], NOW + 2100)
        path = self.fixture.directory / "RESUME.json"
        path.write_text(json.dumps(event))
        path.chmod(0o600)
        return supervisor, path, pending

    def test_visual_auth_resume_retries_same_reservation_without_new_fuel(self):
        supervisor, path, pending = self.unauthorized_review()
        before = copy.deepcopy(supervisor.state)
        key = before["active_root"]["payload"]["idempotency_key"]
        self.assertTrue(SUP.STATE.consume_auth_resume(supervisor.state, path, self.fixture.config["goal_sha256"], NOW + 2100))
        self.assertEqual(supervisor.state["phase"], "root_reserved")
        self.assertEqual(supervisor.state["roots"], before["roots"])
        self.assertEqual(supervisor.state["visual_review_roots"], before["visual_review_roots"])
        self.assertEqual(supervisor.state["progress_pause_baseline"], before["progress_pause_baseline"])
        self.assertEqual(supervisor.state["visual_review_requests"], before["visual_review_requests"])
        self.assertFalse(supervisor.state["continuation_earned"])
        self.assertFalse(supervisor.state.get("auth_retry_earned", False))
        supervisor.save()
        self.fixture.run_pass(NOW + 2100, pending)
        delayed = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(delayed["active_root"]["attempts"], 1)
        self.fixture.run_pass(NOW + 3600, pending)
        after = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(after["active_root"]["payload"]["idempotency_key"], key)
        self.assertEqual(after["active_root"]["attempts"], 2)
        self.assertIn("message_id", after["active_root"])
        self.assertEqual(after["roots"], before["roots"])
        retries = [payload for payload in self.fixture.api.posts if payload["idempotency_key"] == key]
        self.assertEqual(len(retries), 2)
        self.assertEqual(retries[0], retries[1])

    def test_visual_auth_resume_rejects_mismatched_scope_or_cohort(self):
        supervisor, path, _ = self.unauthorized_review()
        pristine = copy.deepcopy(supervisor.state)
        for variant in ("key", "cohort", "baseline", "body", "goal", "purpose", "recipient", "room", "attempts", "message"):
            with self.subTest(variant=variant):
                state = copy.deepcopy(pristine)
                root = state["active_root"]
                payload = root["payload"]
                if variant == "key":
                    payload["idempotency_key"] += "foreign"
                if variant == "cohort":
                    root["review_cohort"] = "f" * 64
                if variant == "baseline":
                    root["baseline"]["qa_review"]["cohort_sha256"] = "f" * 64
                if variant == "body":
                    payload["body"]["supervision"]["visual_review"] = {}
                if variant == "goal":
                    payload["body"]["supervision"]["goal_sha256"] = "f" * 64
                if variant == "purpose":
                    payload["body"]["supervision"]["purpose"] = "engineering"
                if variant == "recipient":
                    payload["recipients"] = [{"tenant_id": "Hospital", "alias": "teseo"}]
                if variant == "room":
                    payload["room_id"] = "grp.steven"
                if variant == "attempts":
                    root["attempts"] = 3
                if variant == "message":
                    root["message_id"] = "already-posted"
                before = copy.deepcopy(state)
                self.assertFalse(SUP.STATE.consume_auth_resume(state, path, self.fixture.config["goal_sha256"], NOW + 2100))
                self.assertEqual(state, before)

    def test_review_done_without_approval_is_not_repeated_and_does_not_earn_fuel(self):
        baseline, _, pending = self.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        self.assertEqual(self.fixture.run_pass(NOW + 2100, pending)["action"], "visual_review_pending")
        self.assertEqual(self.fixture.run_pass(NOW + 7200, pending)["action"], "visual_review_pending")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(len(self.fixture.engineering_posts()), 2)
        self.assertEqual(sum(state["roots"].values()), 2)
        self.assertFalse(state["continuation_earned"])
        self.assertEqual(state["progress_pause_baseline"], baseline)

    def test_metadata_only_review_or_missing_original_baseline_cannot_resume_engineering(self):
        pending = self.pending()
        supervisor = self.fixture.supervisor()
        supervisor.state.update(phase="waiting_visual_review", pending_visual_review=pending["qa_review"],
                                progress_pause_baseline=pending, continuation_earned=False)
        supervisor.save()
        approved = self.approved()
        self.assertEqual(self.fixture.run_pass(NOW + 1800, approved)["action"], "visual_review_completed_no_progress")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertFalse(state["continuation_earned"])
        state.pop("progress_pause_baseline")
        state["phase"] = "waiting_visual_review"
        SUP.atomic_save(self.fixture.state_path, state)
        self.assertEqual(self.fixture.run_pass(NOW + 3600, approved)["action"], "visual_review_completed_no_progress")
        self.assertEqual(self.fixture.engineering_posts(), [])

    def test_review_preserves_stop_activity_and_daily_caps(self):
        pending = self.pending()
        for constraint in ("stop", "activity", "roots", "reviews"):
            with self.subTest(constraint=constraint):
                self.fixture.state_path.unlink(missing_ok=True)
                supervisor = self.fixture.supervisor()
                supervisor.state.update(phase="circuit_paused", pause_reason="no_measured_progress")
                if constraint == "roots":
                    supervisor.state["roots"][SUP.STATE.utc_day(NOW)] = self.fixture.config["root_limit"]
                if constraint == "reviews":
                    supervisor.state["visual_review_roots"] = {SUP.STATE.utc_day(NOW): 3}
                supervisor.save()
                if constraint == "stop":
                    (self.fixture.directory / "STOP").write_text("owner stop")
                action = self.fixture.run_pass(snapshot=pending, active=1 if constraint == "activity" else 0)["action"]
                self.assertEqual(action, {"stop": "owner_stopped", "activity": "active_work",
                    "roots": "visual_review_fuel_exhausted", "reviews": "visual_review_fuel_exhausted"}[constraint])
                self.assertEqual(self.fixture.engineering_posts(), [])
                (self.fixture.directory / "STOP").unlink(missing_ok=True)

    def test_qa_metadata_and_head_changes_do_not_change_review_cohort(self):
        pending = self.pending()
        verification = json.loads((self.fixture.workspace / "verification.json").read_text())
        verification["irrelevant_metadata"] = "changed"
        self.fixture.write_json("verification.json", verification)
        with mock.patch.object(SUP, "run_command", side_effect=lambda argv, *_: "c" * 40 if "rev-parse" in argv else ""):
            current = SUP.engineering_snapshot(self.fixture.config, time.monotonic() + 55)
        self.assertEqual(current["qa_review"]["cohort_sha256"], pending["qa_review"]["cohort_sha256"])

    def test_legacy_recovered_baseline_is_not_consumed_before_pending_visual_review(self):
        baseline = self.fixture.snapshot()
        pending = self.pending()
        supervisor = self.fixture.supervisor()
        supervisor.state.update(phase="circuit_paused", pause_reason="no_measured_progress",
                                progress_pause_baseline=baseline, continuation_earned=False)
        supervisor.save()
        self.assertEqual(self.fixture.run_pass(snapshot=pending)["action"], "visual_review_requested")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["progress_pause_baseline"], baseline)
        self.assertFalse(state["continuation_earned"])

    def legacy_earned(self, earned=True, bad_binding=False):
        (self.fixture.workspace / "apps/web/app.js").write_text("original implementation before legacy root")
        baseline = self.fixture.snapshot()
        self.fixture.run_pass(snapshot=baseline)
        supervisor = self.fixture.supervisor()
        original = supervisor.state.pop("active_root")
        pending = self.pending()
        self.assertTrue(SUP.made_progress(baseline, pending))
        binding = {key: original[key] for key in ("request_id", "trace_id", "delivery_ids", "body_sha256", "body_type")}
        if bad_binding:
            binding["trace_id"] = ""
        supervisor.state.update(phase="observing", continuation_earned=earned, last_action="root_finished_progress",
            last_finished={"at": NOW, "root": original["message_id"], "binding": binding, "engineering": pending})
        supervisor.state.pop("progress_pause_baseline", None)
        supervisor.state.pop("progress_pause_binding", None)
        supervisor.save()
        self.fixture.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": "reviewed"}]}
        return pending

    def test_legacy_real_earned_credit_without_baseline_survives_review_and_is_consumed_once(self):
        pending = self.legacy_earned()
        self.assertEqual(self.fixture.run_pass(NOW + 1800, pending)["action"], "visual_review_requested")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["review_held_continuation"]["status"], "held")
        self.assertFalse(state["continuation_earned"])
        self.assertNotIn("progress_pause_baseline", state)
        approved = self.approved()
        self.assertEqual(self.fixture.run_pass(NOW + 2100, approved)["action"], "visual_review_completed")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertTrue(state["continuation_earned"])
        self.assertEqual(state["review_held_continuation"]["status"], "restored")
        self.assertFalse(SUP.STATE.restore_earned_review_credit(state, approved, NOW + 2101))
        self.assertEqual(self.fixture.run_pass(NOW + 3301, approved)["action"], "root_published")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["review_held_continuation"]["status"], "consumed")
        self.assertFalse(state["continuation_earned"])
        self.assertFalse(SUP.STATE.restore_earned_review_credit(state, approved, NOW + 3400))

    def test_unearned_or_invalid_causal_finished_binding_cannot_create_review_credit(self):
        for earned, invalid in ((False, False), (True, True)):
            with self.subTest(earned=earned, invalid=invalid):
                self.fixture.state_path.unlink(missing_ok=True)
                self.fixture.api = fixtures.FakeApi()
                pending = self.legacy_earned(earned, invalid)
                self.fixture.run_pass(NOW + 1800, pending)
                approved = self.approved()
                self.assertEqual(self.fixture.run_pass(NOW + 2100, approved)["action"], "visual_review_completed_no_progress")
                state = json.loads(self.fixture.state_path.read_text())
                self.assertFalse(state["continuation_earned"])
                self.assertNotIn("review_held_continuation", state)

    def test_recorded_genuine_origin_survives_other_observation_actions(self):
        pending = self.legacy_earned()
        supervisor = self.fixture.supervisor()
        finished = supervisor.state["last_finished"]
        supervisor.state.update(last_action="cooldown", earned_continuation_origin={"root": finished["root"],
            "binding": finished["binding"], "goal_sha256": self.fixture.config["goal_sha256"],
            "source_sha256": SUP.STATE.code_fingerprint(pending)})
        supervisor.save()
        self.fixture.run_pass(NOW + 1800, pending)
        self.assertEqual(self.fixture.run_pass(NOW + 2100, self.approved())["action"], "visual_review_completed")


if __name__ == "__main__":
    unittest.main()
