from __future__ import annotations

import copy
import json
import stat
import subprocess
import unittest
import uuid

import test_praxis_supervision as fixtures

# cauce:requiere none

SUP = fixtures.SUP
NOW = fixtures.NOW
WRAPPER = fixtures.ROOT / "ops/instances/hospital/praxis-supervision-auth-recover.sh"
HELPER = fixtures.ROOT / "ops/instances/hospital/praxis-supervision-state.py"


class AuthRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def paused(self, reason="unauthorized"):
        supervisor = self.fixture.supervisor()
        supervisor.state.update(phase="circuit_paused", pause_reason=reason, backoff_until=NOW + 21600,
                                last_finished={"at": NOW - 300, "root": "failed-root", "engineering": self.fixture.snapshot()})
        supervisor.save()
        return supervisor

    def event(self, now=NOW, updates=None, mode=0o600):
        value = SUP.STATE.auth_resume_event(self.fixture.config["goal_sha256"], now)
        if updates:
            value.update(updates)
        path = self.fixture.directory / "RESUME.json"
        path.write_text(json.dumps(value))
        path.chmod(mode)
        return path, value

    def test_human_reauthentication_allows_one_root_without_erasing_history_or_fuel(self):
        supervisor = self.paused()
        day = SUP.STATE.utc_day(NOW)
        supervisor.state["roots"][day] = 3
        supervisor.state["notice_post_attempts"] = {day: 2}
        supervisor.save()
        _, event = self.event()
        self.assertEqual(self.fixture.run_pass()["action"], "root_published")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["roots"][day], 4)
        self.assertEqual(state["notice_post_attempts"][day], 2)
        self.assertEqual(state["last_finished"]["root"], "failed-root")
        self.assertEqual(state["auth_recoveries"][0]["backoff_until"], NOW + 21600)
        self.assertEqual(state["auth_resume_nonces"], [event["nonce"]])
        self.assertFalse(state["continuation_earned"])
        self.fixture.run_pass(NOW + 300)
        self.assertEqual(len(self.fixture.engineering_posts()), 1)

    def test_duplicate_event_cannot_reopen_a_second_auth_failure(self):
        self.paused()
        path, event = self.event()
        supervisor = self.fixture.supervisor()
        self.assertTrue(SUP.STATE.consume_auth_resume(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))
        supervisor.state.update(phase="circuit_paused", pause_reason="unauthorized", continuation_earned=False)
        supervisor.save()
        self.assertEqual(self.fixture.run_pass(NOW + 300)["action"], "circuit_paused")
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["auth_resume_nonces"], [event["nonce"]])
        self.assertEqual(len(state["auth_recoveries"]), 1)
        self.assertEqual(self.fixture.api.posts, [])

    def test_resume_respects_root_fuel_cooldown_and_activity(self):
        for constraint in ("fuel", "cooldown", "activity"):
            with self.subTest(constraint=constraint):
                self.fixture.state_path.unlink(missing_ok=True)
                supervisor = self.paused()
                if constraint == "fuel":
                    supervisor.state["roots"][SUP.STATE.utc_day(NOW)] = 6
                if constraint == "cooldown":
                    supervisor.state["cooldown_until"] = NOW + 1200
                supervisor.save()
                self.event()
                action = self.fixture.run_pass(active=1 if constraint == "activity" else 0)["action"]
                self.assertEqual(action, {"fuel": "root_fuel_exhausted", "cooldown": "cooldown", "activity": "active_work"}[constraint])
                self.assertEqual(self.fixture.engineering_posts(), [])
                state = json.loads(self.fixture.state_path.read_text())
                self.assertTrue(state["continuation_earned"])
                if constraint == "fuel":
                    self.assertEqual(state["roots"][SUP.STATE.utc_day(NOW)], 6)

    def test_other_pauses_and_active_roots_are_not_bypassed(self):
        for reason in ("quota_exhausted", "no_measured_progress", "foreign_goal"):
            with self.subTest(reason=reason):
                supervisor = self.paused(reason)
                path, _ = self.event()
                before = copy.deepcopy(supervisor.state)
                self.assertFalse(SUP.STATE.consume_auth_resume(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))
                self.assertEqual(supervisor.state, before)
        supervisor = self.paused()
        supervisor.state["active_root"] = {"message_id": str(uuid.uuid4()), "payload": {"static": "retained"}}
        path, _ = self.event()
        before = copy.deepcopy(supervisor.state)
        self.assertFalse(SUP.STATE.consume_auth_resume(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))
        self.assertEqual(supervisor.state, before)

    def test_missing_event_or_invalid_age_schema_goal_and_nonce_never_resume(self):
        supervisor = self.paused()
        missing = self.fixture.directory / "RESUME.json"
        self.assertFalse(SUP.STATE.consume_auth_resume(supervisor.state, missing, self.fixture.config["goal_sha256"], NOW))
        variants = [({"goal_sha256": "f" * 64}, NOW), ({"nonce": "foreign-nonce"}, NOW),
                    ({"nonce": str(uuid.uuid1())}, NOW), ({"schema_version": 2}, NOW),
                    ({"reason": "disable_quality_gates"}, NOW), ({"extra": "untrusted"}, NOW),
                    ({}, NOW - 86401), ({}, NOW + 1)]
        for updates, created in variants:
            with self.subTest(updates=updates, created=created):
                path, _ = self.event(created, updates)
                before = copy.deepcopy(supervisor.state)
                self.assertFalse(SUP.STATE.apply_auth_resume_control(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))
                self.assertEqual(supervisor.state["phase"], "circuit_paused")
                self.assertEqual(supervisor.state["pause_reason"], "unauthorized")
                self.assertNotIn("auth_resume_nonces", supervisor.state)
                self.assertEqual(supervisor.state["roots"], before["roots"])
        path, event = self.event()
        event.pop("nonce")
        path.write_text(json.dumps(event))
        self.assertFalse(SUP.STATE.apply_auth_resume_control(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))

    def test_unsafe_event_permissions_and_symlink_are_rejected(self):
        supervisor = self.paused()
        path, _ = self.event(mode=0o644)
        self.assertFalse(SUP.STATE.apply_auth_resume_control(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))
        self.assertEqual(supervisor.state["auth_resume_rejection"]["code"], "untrusted_resume_mode")
        path.unlink()
        target = self.fixture.directory / "foreign-control.json"
        target.write_text("{}")
        path.symlink_to(target)
        self.assertFalse(SUP.STATE.apply_auth_resume_control(supervisor.state, path, self.fixture.config["goal_sha256"], NOW))
        self.assertEqual(supervisor.state["auth_resume_rejection"]["code"], "untrusted_control_file")

    def reserve_unauthorized(self):
        self.fixture.api.post_errors = ["unauthorized"]
        self.assertEqual(self.fixture.run_pass()["action"], "unauthorized")
        return json.loads(self.fixture.state_path.read_text())

    def test_resume_reconciles_original_post401_reservation_and_receipt(self):
        before = self.reserve_unauthorized()
        original = copy.deepcopy(before["active_root"])
        _, event = self.event(NOW + 1500)
        self.fixture.run_pass(NOW + 1500)
        after = json.loads(self.fixture.state_path.read_text())
        self.assertIn("message_id", after["active_root"])
        self.assertEqual(after["active_root"]["payload"], original["payload"])
        self.assertEqual(after["active_root"]["message_id"], self.fixture.api.keys[original["payload"]["idempotency_key"]])
        self.assertEqual(after["active_root"]["attempts"], 2)
        self.assertEqual(self.fixture.engineering_posts(), [original["payload"], original["payload"]])
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["notices"], before["notices"])
        self.assertEqual(after["auth_resume_nonces"], [event["nonce"]])
        self.assertFalse(after["continuation_earned"])
        self.fixture.run_pass(NOW + 1800)
        self.assertEqual(len(self.fixture.engineering_posts()), 2)

    def test_resumed_reservation_waits_for_runtime_revalidation_without_losing_nonce(self):
        before = self.reserve_unauthorized()
        _, event = self.event(NOW + 1500)
        supervisor = self.fixture.supervisor(NOW + 1500)
        supervisor.runtime_reader = lambda: {**self.fixture.runtime(active=1), "observed_at": NOW + 1500}
        self.assertEqual(supervisor.pass_once(self.fixture.runtime(), self.fixture.snapshot())["action"], "active_work")
        deferred = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(deferred["active_root"]["payload"], before["active_root"]["payload"])
        self.assertEqual(deferred["roots"], before["roots"])
        self.assertEqual(deferred["auth_resume_nonces"], [event["nonce"]])
        self.assertEqual(len(self.fixture.engineering_posts()), 1)
        self.fixture.run_pass(NOW + 1800)
        final = json.loads(self.fixture.state_path.read_text())
        self.assertIn("message_id", final["active_root"])
        self.assertEqual(final["auth_resume_nonces"], [event["nonce"]])
        self.assertEqual(len(final["auth_recoveries"]), 1)

    def test_resumed_reservation_cannot_post_after_stale_runtime_read(self):
        before = self.reserve_unauthorized()
        _, event = self.event(NOW + 1500)
        supervisor = self.fixture.supervisor(NOW + 1500)
        supervisor.runtime_reader = lambda: {**self.fixture.runtime(), "observed_at": NOW}
        with self.assertRaisesRegex(SUP.SupervisionError, "stale_runtime_snapshot"):
            supervisor.pass_once(self.fixture.runtime(), self.fixture.snapshot())
        after = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(after["active_root"]["payload"], before["active_root"]["payload"])
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["auth_resume_nonces"], [event["nonce"]])
        self.assertEqual(len(self.fixture.engineering_posts()), 1)

    def test_reserved_resume_preserves_retry_deadline_and_attempt_ceiling(self):
        before = self.reserve_unauthorized()
        self.event(NOW + 10)
        self.fixture.run_pass(NOW + 10)
        deferred = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(deferred["active_root"]["retry_after"], before["active_root"]["retry_after"])
        self.assertEqual(deferred["active_root"]["attempts"], 1)
        self.assertEqual(len(self.fixture.engineering_posts()), 1)
        self.fixture.run_pass(NOW + 1500)
        self.assertEqual(len(self.fixture.engineering_posts()), 2)
        supervisor = self.fixture.supervisor(NOW + 2000)
        supervisor.state.update(phase="circuit_paused", pause_reason="unauthorized")
        supervisor.state["active_root"].pop("message_id")
        supervisor.state["active_root"].update(error="unauthorized", attempts=3)
        supervisor.save()
        path, _ = self.event(NOW + 2000)
        snapshot = copy.deepcopy(supervisor.state)
        self.assertFalse(SUP.STATE.consume_auth_resume(supervisor.state, path, self.fixture.config["goal_sha256"], NOW + 2000))
        self.assertEqual(supervisor.state, snapshot)

    def test_repeated_nonce_cannot_resume_another_reserved_post401(self):
        self.reserve_unauthorized()
        _, event = self.event(NOW + 1500)
        self.fixture.api.post_errors = ["unauthorized"]
        self.fixture.run_pass(NOW + 1500)
        self.fixture.run_pass(NOW + 3000)
        state = json.loads(self.fixture.state_path.read_text())
        self.assertEqual(state["phase"], "circuit_paused")
        self.assertEqual(state.get("auth_resume_nonces"), [event["nonce"]])
        self.assertEqual(len(self.fixture.engineering_posts()), 2)

    def test_reserved_resume_never_adopts_receipts_other_errors_or_foreign_goal(self):
        original = self.reserve_unauthorized()
        path, _ = self.event(NOW + 1500)
        for field, value in [("message_id", None), ("message_id", str(uuid.uuid4())),
                             ("error", "transport_unknown"), ("attempts", 0), ("attempts", True)]:
            with self.subTest(field=field, value=value):
                state = copy.deepcopy(original)
                state["active_root"][field] = value
                before = copy.deepcopy(state)
                self.assertFalse(SUP.STATE.consume_auth_resume(state, path, self.fixture.config["goal_sha256"], NOW + 1500))
                self.assertEqual(state, before)
        state = copy.deepcopy(original)
        state["active_root"]["baseline"]["goal_sha256"] = "f" * 64
        self.assertFalse(SUP.STATE.consume_auth_resume(state, path, self.fixture.config["goal_sha256"], NOW + 1500))

    def synthetic_wrapper(self, exit_code):
        root = self.fixture.directory
        binary = root / "bin"
        binary.mkdir(exist_ok=True)
        arguments = root / "docker-arguments.json"
        docker = binary / "docker"
        docker.write_text("#!/usr/bin/python3\nimport json,pathlib,sys\npathlib.Path(" + repr(str(arguments))
                          + ").write_text(json.dumps(sys.argv[1:]))\nraise SystemExit(" + str(exit_code) + ")\n")
        docker.chmod(0o700)
        helper = root / "synthetic-state.py"
        helper.write_text(HELPER.read_text() + "\ndef trusted_file(path, directory=False):\n"
                          "    metadata = path.lstat()\n"
                          "    valid = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)\n"
                          "    if not valid or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:\n"
                          "        raise SupervisionError('untrusted_control_file')\n")
        wrapper = root / "synthetic-wrapper.sh"
        content = WRAPPER.read_text().replace("[[ $EUID -ne 0 ]]", "[[ 1 -ne 1 ]]").replace("[[ ! -t 0 || ! -t 1 ]]", "[[ 1 -ne 1 ]]")
        content = content.replace("/usr/local/sbin/praxis-supervision-state.py", str(helper))
        destination = root / "control" / "RESUME.json"
        content = content.replace("/var/lib/praxis-supervision/RESUME.json", str(destination))
        wrapper.write_text(content)
        result = subprocess.run(["bash", str(wrapper)], capture_output=True, text=True,
                                env={"PATH": str(binary) + ":/usr/bin:/bin"}, timeout=10)
        return result, arguments, destination

    def test_wrapper_only_emits_event_after_native_login_exit_zero(self):
        result, arguments, destination = self.synthetic_wrapper(42)
        self.assertEqual(result.returncode, 42)
        self.assertFalse(destination.exists())
        result, arguments, destination = self.synthetic_wrapper(0)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(arguments.read_text()), ["exec", "-it", "-u", "1000",
            "hospital-agent-openclaw-operator-gateway-1", "timeout", "--foreground", "--signal=TERM",
            "--kill-after=5s", "585s", "openclaw", "models", "auth", "login",
            "--provider", "xai", "--method", "device-code"])
        event = json.loads(destination.read_text())
        self.assertEqual(set(event), {"schema_version", "goal_sha256", "reason", "nonce", "created_at"})
        self.assertEqual(event["reason"], "provider_reauthenticated")
        self.assertEqual(event["goal_sha256"], "671e16cb7edad5d061afb71a21aef6ca2d8711655bb7999ccffeecfcdba2ba29")
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)

    def test_wrapper_requires_human_terminal_and_has_bounded_native_command(self):
        result = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 64)
        source = WRAPPER.read_text()
        self.assertIn("timeout --foreground --signal=TERM --kill-after=5s 595s", source)
        self.assertIn("timeout --foreground --signal=TERM --kill-after=5s 585s", source)
        self.assertNotIn("--force", source)
        self.assertNotIn("--set-default", source)
        self.assertNotIn("systemctl", source)
        self.assertNotIn("models probe", source)


if __name__ == "__main__":
    unittest.main()
