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

    def legacy_closed_review(self):
        baseline, _, pending = self.visual.reserve_engineering()
        self.fixture.run_pass(NOW + 1800, pending)
        review_root = self.state()["active_root"]
        with mock.patch.object(SUP.Supervisor, "review_contract_incomplete", autospec=True,
                               side_effect=lambda supervisor, _: supervisor.finish("visual_review_pending")):
            self.assertEqual(self.fixture.run_pass(NOW + 2100, pending)["action"], "visual_review_pending")
        state = self.state()
        self.assertEqual(state["visual_review_requests"][review_root["review_cohort"]]["status"], "closed")
        self.assertNotIn("contract_status", state["visual_review_requests"][review_root["review_cohort"]])
        self.assertNotIn("review_contract_failure", state)
        self.assertEqual(len(self.fixture.api.posts), 2)
        return baseline, pending, review_root

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

if __name__ == "__main__":
    unittest.main()
