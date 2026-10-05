from __future__ import annotations

import copy
import csv
import importlib.util
import json
import os
import stat
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

# cauce:requiere none

ROOT = Path(__file__).resolve().parents[2]
PROGRAM = ROOT / "ops/instances/hospital/praxis-supervision.py"
SPEC = importlib.util.spec_from_file_location("praxis_supervision", PROGRAM)
SUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUP)
HEAD = "a" * 40
NEXT_HEAD = "b" * 40
NOW = 1791200000.0


class FakeApi:
    def __init__(self):
        self.posts = []
        self.gets = []
        self.keys = {}
        self.bindings = {}
        self.post_errors = []
        self.get_error = None
        self.receipt = {"chain_open": True, "deliveries": [{"status": "started", "reply": None}]}

    def post(self, payload):
        self.posts.append(copy.deepcopy(payload))
        key = payload["idempotency_key"]
        self.keys.setdefault(key, str(uuid.uuid4()))
        message_id = self.keys[key]
        self.bindings.setdefault(message_id, {"request_id": str(uuid.uuid4()), "trace_id": "trace-" + str(uuid.uuid4()),
                                               "delivery_ids": [str(uuid.uuid4())], "body": copy.deepcopy(payload["body"])})
        if self.post_errors:
            code = self.post_errors.pop(0)
            if code:
                raise SUP.ApiError(code)
        binding = {key: value for key, value in self.bindings[message_id].items() if key != "body"}
        return {"message_id": message_id, "idempotency_key": key,
                "actor_alias": "praxis-supervisor", "tenant_id": "Hospital", **binding}

    def get(self, message_id):
        self.gets.append(message_id)
        if self.get_error:
            raise SUP.ApiError(self.get_error)
        binding = self.bindings[message_id]
        deliveries = [{"tenant_id": "Hospital", "alias": "operador", "delivery_id": binding["delivery_ids"][0], **row}
                      for row in copy.deepcopy(self.receipt["deliveries"])]
        return {"id": message_id, "tenant_id": "Hospital", "actor_alias": "praxis-supervisor",
                "room_id": "grp.hospital", **binding, **copy.deepcopy(self.receipt), "deliveries": deliveries}


class PraxisSupervisionTests(unittest.TestCase):
    def test_non_root_git_observation_fails_before_any_subprocess(self):
        with mock.patch.object(SUP.STATE.os, "geteuid", return_value=1000), \
                mock.patch.object(SUP.STATE.Path, "stat", return_value=mock.Mock(st_uid=1000, st_gid=1000)), \
                mock.patch.object(SUP.subprocess, "run") as execute:
            with self.assertRaisesRegex(SUP.SupervisionError, "git_requires_actor_isolation"):
                SUP.run_command(["git", "-C", "/opt/hospital-agent/runtime/praxis/operator", "status", "--porcelain"], time.monotonic() + 5)
            execute.assert_not_called()

    def test_git_helpers_cannot_inherit_host_root_identity(self):
        with mock.patch.object(SUP.STATE.os, "geteuid", return_value=0), \
                mock.patch.object(SUP.STATE.Path, "stat", return_value=mock.Mock(st_uid=1000, st_gid=1000)), \
                mock.patch.object(SUP.subprocess, "run", return_value=mock.Mock(stdout="synthetic")) as execute:
            SUP.run_command(["git", "-C", "/opt/hospital-agent/runtime/praxis/operator", "status", "--porcelain"], time.monotonic() + 5)
        self.assertEqual(execute.call_args.args[0][:5], ["docker", "exec", "-u", "1000:1000", "hospital-agent-openclaw-operator-gateway-1"])
        self.assertIn("/home/node/.openclaw/workspace/praxis", execute.call_args.args[0])
        self.assertNotIn("user", execute.call_args.kwargs)
        self.assertNotIn("GIT_CONFIG_VALUE_0", execute.call_args.kwargs["env"])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.workspace = self.directory / "workspace"
        self.preview = self.directory / "preview"
        self.workspace.mkdir()
        self.preview.mkdir()
        self.state_path = self.directory / "state.json"
        goal = b"Synthetic authorized engineering goal\n"
        (self.workspace / "GOAL.md").write_bytes(goal)
        (self.workspace / "apps/web").mkdir(parents=True)
        for name in ("index.html", "app.js", "app.css"):
            (self.workspace / "apps/web" / name).write_text("synthetic " + name)
            (self.preview / name).write_text("synthetic " + name)
        self.config = {
            "enabled": True, "workspace": str(self.workspace), "preview_root": str(self.preview),
            "goal_file": "GOAL.md", "goal_sha256": SUP.digest(goal), "issues_file": "ISSUES.csv",
            "roadmap_file": "roadmap.json", "evidence_file": "evidence.json",
            "verification_file": "verification.json", "client_cert": "/unused/client.crt",
            "client_key": "/unused/client.key", "ca_cert": "/unused/ca.crt",
            "preview_files": {"apps/web/" + name: name for name in ("index.html", "app.js", "app.css")},
            "issue_count": 2, "roadmap_count": 3, "idle_seconds": 480, "cooldown_seconds": 1200,
            "root_limit": 6, "notice_limit": 3, "api_timeout": 8, "heartbeat_seconds": 180,
        }
        self.write_issues("en curso")
        self.write_json("roadmap.json", {"goal_sha256": self.config["goal_sha256"], "issues": [
            {"id": "PRAX001", "criteria": [{"id": "C1"}, {"id": "C2"}]},
            {"id": "PRAX002", "criteria": [{"id": "C1"}]},
        ]})
        self.write_json("evidence.json", {"goal_sha256": self.config["goal_sha256"], "records": {}})
        self.write_json("verification.json", {})
        self.api = FakeApi()
        self.trust_patch = mock.patch.object(SUP, "trusted_file", side_effect=self.fixture_trust)
        self.state_trust_patch = mock.patch.object(SUP.STATE, "trusted_file", side_effect=self.fixture_trust)
        self.trust_patch.start()
        self.state_trust_patch.start()

    def tearDown(self):
        self.trust_patch.stop()
        self.state_trust_patch.stop()
        self.temporary.cleanup()

    def fixture_trust(self, path, directory=False):
        metadata = path.lstat()
        valid = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
        if (not path.is_relative_to(self.directory) or not valid
                or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022):
            raise SUP.SupervisionError("untrusted_control_file")

    def write_json(self, name, value):
        (self.workspace / name).write_text(json.dumps(value))

    def write_issues(self, status):
        with (self.workspace / "ISSUES.csv").open("w") as stream:
            writer = csv.writer(stream)
            writer.writerow(["order", "id", "phase", "title", "hito", "status", "owner", "evidence", "blocker", "source"])
            for number in range(1, 3):
                writer.writerow([number, f"PRAX{number:03}", "phase", "title", "hito", status, "", "", "", ""])

    def snapshot(self, head=HEAD, dirty=False):
        def fake_git(argv, *_):
            if "status" in argv:
                return "modified file" if dirty else ""
            if "diff" in argv or "merge-base" in argv:
                return ""
            return head + "\n"
        with mock.patch.object(SUP, "run_command", side_effect=fake_git):
            return SUP.engineering_snapshot(self.config, time.monotonic() + 55)

    def supervisor(self, now=NOW, observe_only=False):
        supervisor = SUP.Supervisor(self.config, self.state_path, self.api, now, observe_only, failure_reader=lambda _: None,
                                    runtime_reader=lambda: {**self.runtime(), "observed_at": now})
        supervisor.state.setdefault("idle_since", now - 481)
        return supervisor

    def runtime(self, active=0, ready=True):
        return {"active": active, "ready": ready, "observed_at": NOW,
                "work": {status: active if status == "started" else 0 for status in SUP.OPEN}}

    def run_pass(self, now=NOW, snapshot=None, active=0, ready=True):
        return self.supervisor(now).pass_once(self.runtime(active, ready), snapshot or self.snapshot())

    def engineering_posts(self):
        return [row for row in self.api.posts if row["body"]["type"] == "praxis.supervision.continue"]

    def test_active_work_skips_dispatch(self):
        self.assertEqual(self.run_pass(active=1)["action"], "active_work")
        self.assertEqual(self.api.posts, [])

    def test_actor_starting_after_engineering_snapshot_prevents_root_reservation(self):
        snapshot = self.snapshot()
        supervisor = self.supervisor()
        supervisor.runtime_reader = mock.Mock(return_value={**self.runtime(active=1), "observed_at": NOW})
        result = supervisor.pass_once(self.runtime(), snapshot)
        self.assertEqual(result["action"], "active_work")
        supervisor.runtime_reader.assert_called_once()
        self.assertEqual(self.api.posts, [])
        self.assertNotIn("active_root", supervisor.state)
        self.assertEqual(sum(supervisor.state["roots"].values()), 0)

    def test_late_activity_defers_unknown_reconciliation_without_changing_key_or_fuel(self):
        self.api.post_errors = ["transport_unknown"]
        self.run_pass()
        before = json.loads(self.state_path.read_text())
        supervisor = self.supervisor(NOW + 1500)
        supervisor.runtime_reader = lambda: {**self.runtime(active=1), "observed_at": NOW + 1500}
        self.assertEqual(supervisor.pass_once(self.runtime(), self.snapshot())["action"], "active_work")
        after = json.loads(self.state_path.read_text())
        self.assertEqual(after["active_root"], before["active_root"])
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(len(self.api.posts), 1)
        self.run_pass(NOW + 2000)
        self.assertEqual(self.api.posts[0], self.api.posts[1])

    def test_stale_runtime_revalidation_prevents_post(self):
        supervisor = self.supervisor()
        supervisor.runtime_reader = lambda: {**self.runtime(), "observed_at": NOW - 11}
        with self.assertRaisesRegex(SUP.SupervisionError, "stale_runtime_snapshot"):
            supervisor.pass_once(self.runtime(), self.snapshot())
        self.assertEqual(self.api.posts, [])
        self.assertNotIn("active_root", supervisor.state)

    def test_deadline_exhausted_during_refresh_prevents_root_reservation(self):
        supervisor = self.supervisor()
        def exhaust_deadline():
            self.api.deadline = time.monotonic() - 1
            return self.runtime()
        supervisor.runtime_reader = exhaust_deadline
        with self.assertRaisesRegex(SUP.SupervisionError, "pass_timeout"):
            supervisor.pass_once(self.runtime(), self.snapshot())
        self.assertEqual(self.api.posts, [])
        self.assertNotIn("active_root", supervisor.state)

    def test_new_observer_requires_eight_minutes(self):
        supervisor = SUP.Supervisor(self.config, self.state_path, self.api, NOW, failure_reader=lambda _: None)
        self.assertEqual(supervisor.pass_once(self.runtime(), self.snapshot())["action"], "idle_observation")
        self.assertEqual(self.run_pass(NOW + 479)["action"], "idle_observation")
        self.assertEqual(self.run_pass(NOW + 480)["action"], "root_published")

    def test_pending_root_is_read_without_another_publish(self):
        self.assertEqual(self.run_pass()["action"], "root_published")
        self.assertEqual(self.run_pass(NOW + 1500)["action"], "root_pending")
        self.assertEqual(len(self.engineering_posts()), 1)
        self.assertEqual(len(self.api.gets), 1)

    def test_unknown_transport_preserves_key_and_fuel_before_retry(self):
        self.api.post_errors = ["transport_unknown"]
        self.assertEqual(self.run_pass()["action"], "root_transport_unknown")
        before = json.loads(self.state_path.read_text())
        key = before["active_root"]["payload"]["idempotency_key"]
        self.assertEqual(self.run_pass(NOW + 1201)["action"], "root_transport_unknown")
        after = json.loads(self.state_path.read_text())
        self.assertEqual(after["active_root"]["payload"]["idempotency_key"], key)
        self.assertIn("message_id", after["active_root"])
        self.assertEqual(sum(after["roots"].values()), 1)
        self.assertEqual(self.api.posts[0], self.api.posts[1])

    def test_unknown_root_does_not_publish_while_other_actor_active(self):
        self.api.post_errors = ["transport_unknown"]
        self.run_pass()
        self.run_pass(NOW + 1500, active=1)
        self.assertEqual(len(self.api.posts), 1)

    def test_quota_error_sets_backoff_and_circuit(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "failed", "reply": json.dumps({
            "supervision": {"version": 1, "outcome": "capacity_failure", "code": "quota_exhausted"}})}]}
        self.assertEqual(self.run_pass(NOW + 300)["action"], "quota_exhausted")
        state = json.loads(self.state_path.read_text())
        self.assertGreater(state["backoff_until"], NOW + 300)
        self.assertEqual(self.run_pass(NOW + 23000)["action"], "circuit_paused")
        self.assertEqual(len(self.engineering_posts()), 1)
        self.assertEqual(len(self.api.posts), 2)

    def test_post_auth_failure_keeps_unknown_root_and_alerts(self):
        self.api.post_errors = ["unauthorized"]
        self.assertEqual(self.run_pass()["action"], "unauthorized")
        state = json.loads(self.state_path.read_text())
        self.assertIn("active_root", state)
        self.assertEqual(state["phase"], "circuit_paused")
        self.run_pass(NOW + 1500)
        self.assertEqual(len(self.engineering_posts()), 1)

    def test_idempotency_key_is_durable_before_post(self):
        def failing_post(payload):
            state = json.loads(self.state_path.read_text())
            self.assertEqual(state["active_root"]["payload"], payload)
            self.assertEqual(state["active_root"]["attempts"], 1)
            self.assertEqual(stat.S_IMODE(self.state_path.stat().st_mode), 0o600)
            raise SUP.ApiError("transport_unknown")
        self.api.post = failing_post
        self.assertEqual(self.run_pass()["action"], "root_transport_unknown")

    def test_done_without_measured_progress_pauses(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": "all done"}]}
        self.assertEqual(self.run_pass(NOW + 300)["action"], "no_measured_progress")
        self.run_pass(NOW + 2000)
        self.assertEqual(len(self.engineering_posts()), 1)

    def test_progress_earns_one_continuation_after_cooldown(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": "verified commit"}]}
        progressed = self.snapshot(NEXT_HEAD)
        progressed.update(source_hashes={"apps/web/app.js": "b" * 64}, verification_source_current=True,
                          gate_artifacts=["tests:" + "b" * 64])
        self.assertEqual(self.run_pass(NOW + 300, progressed)["action"], "root_finished_progress")
        self.assertEqual(self.run_pass(NOW + 1000, progressed)["action"], "cooldown")
        self.assertEqual(self.run_pass(NOW + 1501, progressed)["action"], "root_published")
        self.assertEqual(len(self.engineering_posts()), 2)

    def test_concurrent_lock_refuses_second_pass(self):
        path = self.directory / "pass.lock"
        with SUP.StateLock(path):
            with self.assertRaisesRegex(SUP.SupervisionError, "already_running"):
                with SUP.StateLock(path):
                    self.fail("second pass acquired lock")

    def test_goal_hash_drift_stops_observation_and_dispatch(self):
        (self.workspace / "GOAL.md").write_text("foreign goal")
        with self.assertRaisesRegex(SUP.SupervisionError, "foreign_goal"):
            self.snapshot()
        snapshot = self.snapshot_mock()
        snapshot["goal_sha256"] = "0" * 64
        self.assertEqual(self.run_pass(snapshot=snapshot)["action"], "foreign_goal")
        self.assertEqual(self.engineering_posts(), [])

    def snapshot_mock(self):
        return {"goal_sha256": self.config["goal_sha256"], "git_head": HEAD,
                "completion_candidate": False, "advanced_issues": [], "accepted_issues": [],
                "accepted_roadmap": [], "valid_gates": []}

    def test_labels_without_gate_artifacts_never_complete(self):
        self.write_issues("accepted")
        self.write_json("verification.json", {"status": "verified-preview", "source_commit": HEAD,
                                              "integration_commit": HEAD, "accepted_issues": ["PRAX001", "PRAX002"]})
        snapshot = self.snapshot()
        self.assertFalse(snapshot["completion_candidate"])
        self.assertEqual(snapshot["accepted_issues"], [])
        self.assertNotEqual(self.run_pass(snapshot=snapshot)["phase"], "awaiting_final_review")

    def test_daily_engineering_fuel_and_notice_fuel_are_bounded(self):
        supervisor = self.supervisor()
        day = SUP.dt.datetime.fromtimestamp(NOW, SUP.dt.timezone.utc).strftime("%Y-%m-%d")
        supervisor.state["roots"][day] = 6
        self.assertEqual(supervisor.pass_once(self.runtime(), self.snapshot())["action"], "root_fuel_exhausted")
        for number in range(8):
            supervisor.notice("synthetic:" + str(number), "alert", "synthetic notice")
        self.assertEqual(len(self.engineering_posts()), 0)
        self.assertEqual(len(self.api.posts), 3)

    def test_previous_day_unknown_notices_and_new_notices_share_today_post_budget(self):
        self.api.post_errors = ["transport_unknown"] * 3
        yesterday = self.supervisor()
        for number in range(3):
            yesterday.notice("old:" + str(number), "alert", "synthetic old notice")
        original = [row["idempotency_key"] for row in self.api.posts]
        today = self.supervisor(NOW + 86400)
        for number in range(3):
            today.notice("old:" + str(number), "alert", "synthetic old notice")
        for number in range(3):
            today.notice("new:" + str(number), "alert", "synthetic new notice")
        self.assertEqual(len(self.api.posts), 6)
        self.assertEqual([row["idempotency_key"] for row in self.api.posts[3:]], original)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state["notice_post_attempts"][SUP.STATE.utc_day(NOW)], 3)
        self.assertEqual(state["notice_post_attempts"][SUP.STATE.utc_day(NOW + 86400)], 3)

    def test_notice_post_fuel_is_durable_before_network_and_get_reads_do_not_consume(self):
        def failing_post(payload):
            state = json.loads(self.state_path.read_text())
            self.assertEqual(state["notice_post_attempts"][SUP.STATE.utc_day(NOW)], 1)
            record = next(iter(state["notices"].values()))
            self.assertEqual(record["payload"], payload)
            self.assertEqual(record["attempts"], 1)
            raise SUP.ApiError("transport_unknown")
        self.api.post = failing_post
        supervisor = self.supervisor()
        supervisor.notice("durable", "alert", "synthetic notice")
        self.assertEqual(supervisor.state["notice_post_attempts"][SUP.STATE.utc_day(NOW)], 1)
        self.api = FakeApi()
        self.run_pass(NOW + 1200)
        self.run_pass(NOW + 1500)
        self.assertEqual(json.loads(self.state_path.read_text())["notice_post_attempts"][SUP.STATE.utc_day(NOW)], 1)

    def test_post_clock_crossing_midnight_counts_attempt_on_actual_day(self):
        supervisor = self.supervisor()
        supervisor.post_clock = lambda: NOW + 86400
        supervisor.notice("crossing", "alert", "synthetic notice")
        state = json.loads(self.state_path.read_text())
        self.assertNotIn(SUP.STATE.utc_day(NOW), state["notice_post_attempts"])
        self.assertEqual(state["notice_post_attempts"][SUP.STATE.utc_day(NOW + 86400)], 1)

    def test_ledger_cannot_reference_outside_workspace_or_secret(self):
        marker = self.directory / "shell-marker"
        self.write_json("evidence.json", {"goal_sha256": self.config["goal_sha256"], "records": {
            "PRAX001": {"source_commit": HEAD, "criteria": [{"id": "C1", "outcome": "accepted", "artifact": {
                "path": "../outside; touch " + str(marker), "sha256": "f" * 64}}]}}})
        with self.assertRaisesRegex(SUP.SupervisionError, "artifact_scope"):
            self.snapshot()
        self.assertFalse(marker.exists())
        for path in (".env", "secret/auth.json", "credentials/a", "docs/../../private", "/etc/passwd"):
            with self.subTest(path=path), self.assertRaises(SUP.SupervisionError):
                SUP.scoped(self.workspace, path)

    def test_source_and_publication_mismatch_fail_snapshot_match(self):
        (self.preview / "app.js").write_text("stale published code")
        source_files = {path: SUP.digest((self.workspace / path).read_bytes()) for path in self.config["preview_files"]}
        source_files["apps/web/app.css"] = "f" * 64
        self.write_json("verification.json", {"status": "verified-preview", "source_commit": HEAD,
                                              "integration_commit": HEAD, "source_files": source_files})
        snapshot = self.snapshot()
        self.assertFalse(snapshot["web_matches"])
        self.assertFalse(snapshot["source_files_match"])
        self.assertFalse(snapshot["completion_candidate"])

    def test_complete_evidence_pauses_for_owner_review_and_keeps_observing(self):
        self.write_issues("accepted")
        proof = self.workspace / "proof.json"
        proof.write_text('{"synthetic":true}')
        artifact = {"path": "proof.json", "sha256": SUP.digest(proof.read_bytes())}
        self.write_json("evidence.json", {"goal_sha256": self.config["goal_sha256"], "records": {
            "PRAX001": {"source_commit": HEAD, "validation_status": "accepted", "criteria": [
                {"id": identifier, "outcome": "accepted", "artifact": artifact} for identifier in ("C1", "C2")]},
            "PRAX002": {"source_commit": HEAD, "validation_status": "accepted", "criteria": [{"id": "C1", "outcome": "accepted", "artifact": artifact}]},
        }})
        self.write_json("verification.json", {"status": "verified-preview", "source_commit": HEAD,
            "integration_commit": HEAD, "accepted_issues": ["PRAX001", "PRAX002"],
            "source_files": {path: SUP.digest((self.workspace / path).read_bytes()) for path in self.config["preview_files"]},
            "gates": [{"id": name, "outcome": "accepted", "artifacts": [artifact]}
                      for name in ("tests", "typecheck", "build", "qa", "snapshot")]})
        snapshot = self.snapshot()
        self.assertTrue(snapshot["completion_candidate"])
        self.assertTrue(self.snapshot(NEXT_HEAD)["completion_candidate"])
        def changed_source(argv, *_):
            if "diff" in argv:
                return "apps/web/app.js\n"
            return NEXT_HEAD + "\n" if "rev-parse" in argv else ""
        with mock.patch.object(SUP, "run_command", side_effect=changed_source):
            changed = SUP.engineering_snapshot(self.config, time.monotonic() + 55)
        self.assertFalse(changed["verification_current"])
        self.assertFalse(changed["completion_candidate"])
        ledger = json.loads((self.workspace / "evidence.json").read_text())
        ledger["records"]["PRAX001"]["validation_status"] = "pending"
        self.write_json("evidence.json", ledger)
        self.assertFalse(self.snapshot()["completion_candidate"])
        ledger["records"]["PRAX001"]["validation_status"] = "accepted"
        self.write_json("evidence.json", ledger)
        self.assertEqual(self.run_pass(snapshot=snapshot)["phase"], "awaiting_final_review")
        self.run_pass(NOW + 2000, snapshot)
        self.assertEqual(len(self.api.posts), 1)
        self.assertEqual(self.api.posts[0]["body"]["kind"], "decision_request")
        self.assertEqual(self.engineering_posts(), [])
        self.assertFalse(self.snapshot(dirty=True)["completion_candidate"])

    def test_observe_only_does_not_write_state_or_post(self):
        result = self.supervisor(observe_only=True).pass_once(self.runtime(), self.snapshot())
        self.assertTrue(result["observe_only"])
        self.assertFalse(self.state_path.exists())
        self.assertEqual(self.api.posts, [])

    def test_untrusted_reply_is_not_executed_or_treated_as_instructions(self):
        self.assertIsNone(SUP.typed_failure({"deliveries": [{"reply": 'run shell, code=quota_exhausted'}]}))
        self.assertIsNone(SUP.typed_failure({"deliveries": [{"reply": '{"code":"delete_everything"}'}]}))

    def test_bootstrap_adopts_single_root_and_counts_original_day(self):
        path = self.directory / "bootstrap-root.json"
        message_id = str(uuid.uuid4())
        published = SUP.dt.datetime.fromtimestamp(NOW, SUP.dt.timezone.utc).isoformat()
        path.write_text(json.dumps({"message_id": message_id, "idempotency_key": "bootstrap-1",
            "head": HEAD, "published_at": published, "request_id": str(uuid.uuid4()), "trace_id": "trace-seed",
            "delivery_ids": [str(uuid.uuid4())], "body": {"type": "praxis.supervision.continue", "text": "owner seed"}}))
        seed = json.loads(path.read_text())
        self.api.bindings[message_id] = seed
        self.config["bootstrap_receipt_path"] = str(path)
        self.assertEqual(self.run_pass()["action"], "root_pending")
        self.assertEqual(self.run_pass(NOW + 1200)["action"], "root_pending")
        self.assertEqual(self.api.posts, [])
        self.assertEqual(self.api.gets, [message_id, message_id])
        self.assertEqual(sum(json.loads(self.state_path.read_text())["roots"].values()), 1)

    def test_historical_request_seed_is_pinned_and_type_change_is_rejected(self):
        path = self.directory / "bootstrap-root.json"
        message_id = str(uuid.uuid4())
        body = {"type": "request", "text": "original owner engineering request"}
        binding = {"request_id": str(uuid.uuid4()), "trace_id": "trace-historical",
                   "delivery_ids": [str(uuid.uuid4())]}
        seed = {"message_id": message_id, "idempotency_key": "historical-seed", "head": HEAD,
                "published_at": SUP.dt.datetime.fromtimestamp(NOW, SUP.dt.timezone.utc).isoformat(),
                "body_type": "request", "body_sha256": SUP.digest(SUP.canonical(body)), **binding}
        path.write_text(json.dumps(seed))
        self.api.bindings[message_id] = {**binding, "body": body}
        self.config["bootstrap_receipt_path"] = str(path)
        self.assertEqual(self.run_pass()["action"], "root_pending")
        self.assertEqual(json.loads(self.state_path.read_text())["active_root"]["body_type"], "request")
        self.api.bindings[message_id]["body"] = {**body, "type": "praxis.supervision.continue"}
        self.assertEqual(self.run_pass(NOW + 300)["action"], "causal_receipt_mismatch")
        self.assertEqual(json.loads(self.state_path.read_text())["active_root"]["body_type"], "request")
        self.assertEqual(self.engineering_posts(), [])

    def test_bootstrap_types_are_closed_and_new_publication_type_is_fixed(self):
        for body_type in ("agent.response", "praxis.supervision.notice", "unknown"):
            with self.subTest(body_type=body_type), self.assertRaisesRegex(SUP.SupervisionError, "invalid_bootstrap_type"):
                SUP.STATE.seed_body_type({"body_type": body_type})
        with self.assertRaisesRegex(SUP.SupervisionError, "invalid_bootstrap_type"):
            SUP.STATE.seed_body_type({"body_type": "request", "body": {"type": "praxis.supervision.continue"}})
        self.config["body_type"] = "request"
        self.run_pass()
        self.assertEqual(self.engineering_posts()[0]["body"]["type"], "praxis.supervision.continue")
        self.assertEqual(json.loads(self.state_path.read_text())["active_root"]["body_type"], "praxis.supervision.continue")

    def test_causal_receipt_request_trace_body_or_recipient_mismatch_preserves_root(self):
        for field in ("request_id", "trace_id", "body", "recipient"):
            with self.subTest(field=field):
                if self.state_path.exists():
                    self.state_path.unlink()
                self.api = FakeApi()
                self.run_pass()
                state = json.loads(self.state_path.read_text())
                message_id = state["active_root"]["message_id"]
                if field == "recipient":
                    self.api.receipt["deliveries"] = [{"status": "done", "reply": None, "alias": "teseo"}]
                else:
                    self.api.bindings[message_id][field] = ({"type": "praxis.supervision.continue", "text": "foreign text"}
                                                           if field == "body" else str(uuid.uuid4()))
                self.assertEqual(self.run_pass(NOW + 300)["action"], "causal_receipt_mismatch")
                self.assertEqual(json.loads(self.state_path.read_text())["active_root"]["message_id"], message_id)

    def test_foreign_receipt_pauses(self):
        self.run_pass()
        self.api.receipt["actor_alias"] = "foreign-actor"
        self.assertEqual(self.run_pass(NOW + 300)["action"], "foreign_receipt")

    def test_failed_root_without_error_metadata_does_not_retry(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "failed", "reply": None}]}
        self.assertEqual(self.run_pass(NOW + 300, self.snapshot(NEXT_HEAD))["action"], "root_failed_unclassified")
        self.run_pass(NOW + 1800, self.snapshot(NEXT_HEAD))
        self.assertEqual(len(self.engineering_posts()), 1)

    def test_root_done_with_hidden_fanin_failure_pauses_despite_verified_progress(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": None}]}
        supervisor = self.supervisor(NOW + 300)
        def failed_chain(message_id):
            self.assertEqual(supervisor.state["active_root"]["message_id"], message_id)
            return "quota_exhausted"
        supervisor.failure_reader = mock.Mock(side_effect=failed_chain)
        progressed = self.snapshot(NEXT_HEAD)
        progressed["accepted_roadmap"] = ["PRAX001:C1"]
        self.assertEqual(supervisor.pass_once(self.runtime(), progressed)["action"], "quota_exhausted")
        supervisor.failure_reader.assert_called_once()
        self.run_pass(NOW + 1501, progressed)
        self.assertEqual(len(self.engineering_posts()), 1)

    def test_unknown_chain_metadata_preserves_active_root(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": None}]}
        supervisor = self.supervisor(NOW + 300)
        supervisor.failure_reader = mock.Mock(side_effect=SUP.SupervisionError("observation_unavailable"))
        self.assertEqual(supervisor.pass_once(self.runtime(), self.snapshot(NEXT_HEAD))["action"], "chain_receipt_unavailable")
        self.assertIn("active_root", json.loads(self.state_path.read_text()))
        self.assertEqual(len(self.engineering_posts()), 1)

    def test_documentation_only_head_change_is_not_progress(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": None}]}
        self.assertEqual(self.run_pass(NOW + 300, self.snapshot(NEXT_HEAD))["action"], "no_measured_progress")
        self.assertEqual(len(self.engineering_posts()), 1)

    def test_code_change_without_current_new_gate_proof_is_not_progress(self):
        previous = self.snapshot()
        current = self.snapshot(NEXT_HEAD)
        current["source_hashes"] = {"apps/web/app.js": "f" * 64}
        self.assertFalse(SUP.made_progress(previous, current))
        current["verification_source_current"] = True
        current["gate_artifacts"] = ["tests:" + "f" * 64]
        self.assertTrue(SUP.made_progress(previous, current))

    def test_root_absent_from_metadata_does_not_accredit_chain_completion(self):
        value = {"root_found": False, "open": 0, "failed": 0, "errors": []}
        with mock.patch.object(SUP, "run_command", return_value=json.dumps(value)):
            with self.assertRaisesRegex(SUP.SupervisionError, "chain_verification_unknown"):
                SUP.root_failure_metadata(self.config, str(uuid.uuid4()), time.monotonic() + 55)

    def test_provider_error_metadata_is_scoped_and_classified_without_quota_guess(self):
        message_id = str(uuid.uuid4())
        error = "OpenClaw API rejected the request (HTTP 401; category=unclassified)"
        result = {"root_found": True, "open": 0, "failed": 1, "errors": [error]}
        with mock.patch.object(SUP, "run_command", return_value=json.dumps(result)) as command:
            code = SUP.root_failure_metadata(self.config, message_id, time.monotonic() + 55)
        self.assertEqual(code, "unauthorized")
        sql = command.call_args.args[2]
        self.assertIn(message_id, sql)
        self.assertIn("actor_alias='praxis-supervisor'", sql)
        self.assertIn("m.trace_id=root.trace_id", sql)
        result["errors"] = ["someone says no quota left"]
        with mock.patch.object(SUP, "run_command", return_value=json.dumps(result)):
            self.assertEqual(SUP.root_failure_metadata(self.config, message_id, time.monotonic() + 55), "chain_failed_unclassified")
        with self.assertRaises(ValueError):
            SUP.root_failure_metadata(self.config, "UUID'; DELETE FROM deliveries;", time.monotonic() + 55)

    def test_expired_certificate_prevents_engineering_publish(self):
        self.config["certificate_not_after"] = NOW - 1
        self.assertEqual(self.run_pass()["action"], "supervisor_certificate_expired")
        self.assertEqual(self.engineering_posts(), [])

    def test_identity_expiry_comes_from_certificate_or_matching_public_metadata(self):
        certificate = self.directory / "client.crt"
        certificate.write_text("public synthetic certificate")
        self.config["client_cert"] = str(certificate)
        metadata = self.directory / "identity.json"
        metadata.write_text(json.dumps({"alias": "praxis-supervisor", "cert_sha256": SUP.digest(certificate.read_bytes()),
                                       "expires_at": "2026-10-12T10:44:00Z"}))
        self.config["identity_metadata_file"] = str(metadata)
        with mock.patch.object(SUP.ssl._ssl, "_test_decode_cert", return_value={"notAfter": "Oct 12 10:44:00 2026 GMT"}):
            observed = SUP.certificate_expiry(self.config)
        self.assertEqual(observed, SUP.dt.datetime(2026, 10, 12, 10, 44, tzinfo=SUP.dt.timezone.utc).timestamp())
        metadata.write_text(json.dumps({"alias": "foreign", "cert_sha256": "f" * 64, "expires_at": "2020-01-01T00:00:00Z"}))
        with mock.patch.object(SUP.ssl._ssl, "_test_decode_cert", return_value={"notAfter": "Oct 12 10:44:00 2026 GMT"}):
            self.assertEqual(SUP.certificate_expiry(self.config), observed)

    def test_owner_stop_is_sticky_and_requires_trusted_file(self):
        stop = self.directory / "STOP"
        stop.write_text("explicit owner stop")
        self.assertEqual(self.supervisor().owner_stop()["phase"], "owner_stopped")
        stop.unlink()
        self.assertEqual(self.supervisor().owner_stop()["phase"], "owner_stopped")
        self.assertEqual(self.api.posts, [])

    def test_default_configuration_is_observation_only(self):
        self.config.pop("enabled")
        result = self.run_pass()
        self.assertTrue(result["observe_only"])
        self.assertEqual(self.api.posts, [])

    def test_runtime_query_is_read_only_and_contains_only_operational_metadata(self):
        actors = [{"alias": actor, "enabled": True, "online": True, "heartbeat_age": 5} for actor in SUP.ACTORS]
        value = {"actors": actors, "work": {status: 0 for status in SUP.OPEN}, "observed_at": time.time()}
        with mock.patch.object(SUP, "run_command", return_value=json.dumps(value)) as command:
            snapshot = SUP.runtime_snapshot(self.config, time.monotonic() + 55)
        self.assertTrue(snapshot["ready"])
        argv, _, sql = command.call_args.args
        self.assertEqual(argv[:3], ["docker", "exec", "-i"])
        self.assertIn("BEGIN READ ONLY", sql)
        self.assertNotIn("d.result", sql)
        self.assertNotIn("m.body", sql)
        self.assertNotIn("INSERT", sql)
        self.assertNotIn("UPDATE", sql)

    def test_stale_lease_snapshot_prevents_ready_state(self):
        actors = [{"alias": actor, "enabled": True, "online": True, "heartbeat_age": 500} for actor in SUP.ACTORS]
        value = {"actors": actors, "work": {status: 0 for status in SUP.OPEN}, "observed_at": time.time()}
        with mock.patch.object(SUP, "run_command", return_value=json.dumps(value)):
            self.assertFalse(SUP.runtime_snapshot(self.config, time.monotonic() + 55)["ready"])
        value["observed_at"] -= 60
        with mock.patch.object(SUP, "run_command", return_value=json.dumps(value)):
            with self.assertRaisesRegex(SUP.SupervisionError, "stale_runtime_snapshot"):
                SUP.runtime_snapshot(self.config, time.monotonic() + 55)

    def test_https_redirect_is_never_followed(self):
        with self.assertRaisesRegex(SUP.ApiError, "unexpected_redirect"):
            SUP.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://foreign.example")

    def test_exhausted_pass_never_loads_credentials(self):
        api = SUP.Api(self.config, time.monotonic() - 1)
        with mock.patch.object(SUP.ssl, "create_default_context") as context:
            with self.assertRaisesRegex(SUP.ApiError, "pass_timeout"):
                api.get(str(uuid.uuid4()))
        context.assert_not_called()

    def test_control_guard_rejects_symlinks_and_nonroot_metadata(self):
        self.trust_patch.stop()
        self.state_trust_patch.stop()
        path = self.directory / "control"
        metadata = mock.Mock(st_mode=stat.S_IFREG | 0o600, st_uid=1000)
        with mock.patch.object(Path, "lstat", return_value=metadata):
            with self.assertRaisesRegex(SUP.SupervisionError, "untrusted_control_file"):
                SUP.trusted_file(path)
        metadata.st_uid, metadata.st_mode = 0, stat.S_IFLNK | 0o777
        with mock.patch.object(Path, "lstat", return_value=metadata):
            with self.assertRaises(SUP.SupervisionError):
                SUP.trusted_file(path)
        self.trust_patch.start()
        self.state_trust_patch.start()


if __name__ == "__main__":
    unittest.main()
