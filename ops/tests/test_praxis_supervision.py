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
        self.write_json("evidence.json", {"schema_version": 1, "goal_sha256": self.config["goal_sha256"], "records": {}})
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
        return self.supervisor(now).pass_once({**self.runtime(active, ready), "observed_at": now}, snapshot or self.snapshot())

    def engineering_posts(self):
        return [row for row in self.api.posts if row["body"]["type"] == "praxis.supervision.continue"]

    def test_active_work_skips_dispatch(self):
        self.assertEqual(self.run_pass(active=1)["action"], "active_work")
        self.assertEqual(self.api.posts, [])

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

    def test_progress_earns_one_continuation_after_cooldown(self):
        self.run_pass()
        self.api.receipt = {"chain_open": False, "deliveries": [{"status": "done", "reply": "verified commit"}]}
        progressed = self.snapshot(NEXT_HEAD)
        progressed.update(source_hashes={"apps/web/app.js": "b" * 64}, verification_source_current=True,
                          gate_artifacts=["tests:" + "b" * 64], verified_engineering=True,
                          tested_source_hashes={"apps/web/app.js": "b" * 64})
        self.assertEqual(self.run_pass(NOW + 300, progressed)["action"], "root_finished_progress")
        self.assertEqual(self.run_pass(NOW + 1000, progressed)["action"], "cooldown")
        self.assertEqual(self.run_pass(NOW + 1501, progressed)["action"], "root_published")
        self.assertEqual(len(self.engineering_posts()), 2)

    def snapshot_mock(self):
        return {"goal_sha256": self.config["goal_sha256"], "git_head": HEAD,
                "completion_candidate": False, "advanced_issues": [], "accepted_issues": [],
                "accepted_roadmap": [], "valid_gates": []}

    def proof_fixture(self, head=HEAD, accepted=False):
        from test_praxis_supervision_evidence import proof_fixture
        return proof_fixture(self, head, accepted)

    def test_observe_only_does_not_write_state_or_post(self):
        result = self.supervisor(observe_only=True).pass_once(self.runtime(), self.snapshot())
        self.assertTrue(result["observe_only"])
        self.assertFalse(self.state_path.exists())
        self.assertEqual(self.api.posts, [])

    def test_owner_stop_is_sticky_and_requires_trusted_file(self):
        stop = self.directory / "STOP"
        stop.write_text("explicit owner stop")
        self.assertEqual(self.supervisor().owner_stop()["phase"], "owner_stopped")
        stop.unlink()
        self.assertEqual(self.supervisor().owner_stop()["phase"], "owner_stopped")
        self.assertEqual(self.api.posts, [])

if __name__ == "__main__":
    unittest.main()
