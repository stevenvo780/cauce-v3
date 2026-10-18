#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import datetime
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

GUARDS = pathlib.Path(__file__).resolve().parents[1] / "guardias"
sys.path.insert(0, str(GUARDS))

import credential_health  # noqa: E402
from credential_health import (  # noqa: E402
    CREDENTIAL_PROBE_SOURCE,
    LONG_LIVED,
    UNREFRESHABLE,
    classify_doctor_record,
    classify_fleet_guard_record,
    hours_until_expiry,
    shared_fingerprints,
)

NOW = 2_000_000_000.0

SYNTHETIC_TARGETS = {
    "targets": [
        ["synthetic-a", "/home/dev/.claude/.credentials.json", "claude/fixture-a"],
        ["synthetic-b", "/home/dev/.codex/auth.json", "codex/fixture-b"],
    ],
    "remote_targets": [
        ["synthetic-remote-a", "/home/dev/.claude/.credentials.json", "claude/fixture-remote-a"],
        ["synthetic-remote-b", "/home/dev/.codex/auth.json", "codex/fixture-remote-b"],
    ],
}


def fleet_record(fingerprint, expiry):
    return {
        "huella": fingerprint,
        "expiresAt": expiry,
        "last_refresh": "synthetic-refresh-marker",
        "at_len": 64,
    }


def doctor_record(fingerprint, expiry):
    return {
        "huella": fingerprint,
        "huella_acc": "synthetic-access-fingerprint",
        "exp": expiry,
    }


class TestExpiryParsing(unittest.TestCase):
    def test_seconds_and_milliseconds_are_equivalent(self):
        expiry = NOW + 36_000
        self.assertEqual(hours_until_expiry(expiry, now_epoch=NOW), 10)
        self.assertEqual(hours_until_expiry(expiry * 1_000, now_epoch=NOW), 10)
        self.assertEqual(hours_until_expiry(str(expiry), now_epoch=NOW), 10)

class TestCredentialClassification(unittest.TestCase):
    def test_full_records_apply_each_consumers_threshold(self):
        expires_at = (NOW + 200 * 3_600) * 1_000
        fleet_guard = classify_fleet_guard_record(
            fleet_record(None, expires_at),
            now_epoch=NOW,
        )
        doctor = classify_doctor_record(
            doctor_record(None, expires_at),
            now_epoch=NOW,
        )

        self.assertEqual(doctor.state, LONG_LIVED)
        self.assertEqual(doctor.operational_state, "TOKEN-LARGO")
        self.assertFalse(doctor.problem)
        self.assertEqual(fleet_guard.state, UNREFRESHABLE)
        self.assertEqual(fleet_guard.operational_state, "MUERTO")
        self.assertTrue(fleet_guard.problem)

class TestConsumerWiring(unittest.TestCase):
    def setUp(self):
        self.argv = mock.patch.object(sys, "argv", ["cred-guard.py"])
        self.argv.start()
        self.addCleanup(self.argv.stop)
        self.targets_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.targets_dir.cleanup)
        targets = pathlib.Path(self.targets_dir.name) / "targets.json"
        targets.write_text(json.dumps(SYNTHETIC_TARGETS), encoding="utf-8")
        self.targets_env = mock.patch.dict(os.environ, {"CAUCE_CRED_GUARD_TARGETS": str(targets)})
        self.targets_env.start()
        self.addCleanup(self.targets_env.stop)

    @staticmethod
    def result(stdout=""):
        return mock.Mock(returncode=0, stdout=stdout, stderr="")

    def test_doctor_still_escalates_a_credential_without_refresh_token(self):
        fixture = doctor_record(None, (time.time() - 3_600) * 1_000)
        namespace = runpy.run_path(str(GUARDS / "cauce-v3-medico-monitor"), run_name="credential_test_doctor_dead")
        consumer = namespace["sonda_credenciales"]
        consumer.__globals__["sh"] = lambda *_args, **_kwargs: (0, json.dumps(fixture), "")
        problems, shared = consumer({"alpha": {"contenedor": "container-one", "host": "kratos"}})
        self.assertEqual(len(problems), 1)
        self.assertEqual(shared, {})

    def test_all_consumers_use_full_record_classification(self):
        consumers = {
            "cred-guard.py": "classify_fleet_guard_record(d,",
            "cauce-v3-medico-monitor": "classify_doctor_record(d,",
        }
        for filename, adapter_call in consumers.items():
            with self.subTest(filename=filename):
                source = (GUARDS / filename).read_text(encoding="utf-8")
                self.assertIn(adapter_call, source)


class TestGuardState(unittest.TestCase):
    def run_guard(self, directory, record, *, arguments=(), push_result=None, push_failure=None):
        output, errors = io.StringIO(), io.StringIO()
        (directory / "targets.json").write_text(json.dumps(SYNTHETIC_TARGETS), encoding="utf-8")
        remote = json.dumps({"host": "kratos", "ts": datetime.datetime.now(datetime.UTC).isoformat(), "filas": []})
        real_open = open

        def synthetic_open(path, *args, **kwargs):
            if str(path) == "/var/lib/cauce-v3/cred-guard-kratos.json":
                return io.StringIO(remote)
            return real_open(path, *args, **kwargs)

        with (
            mock.patch.dict(os.environ, {
                "HOME": str(directory),
                "CAUCE_CRED_GUARD_ESTADO": str(directory / "state"),
                "CAUCE_CRED_GUARD_TARGETS": str(directory / "targets.json"),
            }),
            mock.patch.object(sys, "argv", ["cred-guard.py", *arguments]),
            mock.patch.object(credential_health, "probe_container", side_effect=record),
            mock.patch("subprocess.run", return_value=push_result, side_effect=push_failure),
            mock.patch("builtins.open", side_effect=synthetic_open),
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(errors),
        ):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(GUARDS / "cred-guard.py"), run_name="credential_test_state")
            self.assertIs(sys.stdout, output)
            self.assertIs(sys.stderr, errors)
        return exited.exception.code, output.getvalue(), errors.getvalue()

    def assert_state(self, directory, output, errors, *, exit_code, problems, shared):
        state = directory / "state"
        self.assertEqual((state / "cred-guard.txt").read_text(encoding="utf-8"), output + errors)
        lines = (state / "cred-guard.log").read_text(encoding="utf-8").splitlines()
        timestamp, fields = lines[-1].split(" ", 1)
        self.assertEqual(datetime.datetime.fromisoformat(timestamp).utcoffset(), datetime.timedelta(0))
        self.assertEqual(fields, f"rc={exit_code} problemas={problems} compartidas={shared}")

    def test_state_keeps_shared_credentials_successful_and_appends_utc_logs(self):
        def record(*_args):
            return fleet_record("shared-fingerprint", None)

        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            for _ in range(2):
                code, output, errors = self.run_guard(directory, record)
                self.assertEqual(code, 0)
                self.assertIn("NOTA: cuentas compartidas", output)
                self.assertEqual(errors, "")
                self.assert_state(directory, output, errors, exit_code=0, problems=0, shared=1)
            self.assertEqual(len((directory / "state" / "cred-guard.log").read_text().splitlines()), 2)

class TestSharedFingerprints(unittest.TestCase):
    def test_only_distinct_containers_are_shared(self):
        observations = [
            ("fingerprint-a", "alpha", "container-one"),
            ("fingerprint-a", "beta", "container-one"),
            ("fingerprint-b", "gamma", "container-one"),
            ("fingerprint-b", "delta", "container-two"),
            ("fingerprint-c", "epsilon", "container-three"),
        ]

        self.assertEqual(
            shared_fingerprints(observations),
            {"fingerprint-b": ["gamma", "delta"]},
        )

class TestCredentialProbe(unittest.TestCase):
    """The probe is the half of the guards that reads; it must not leak the token it reads."""

    @staticmethod
    def completed(returncode=0, stdout="", stderr=""):
        return mock.Mock(returncode=returncode, stdout=stdout, stderr=stderr)

    @staticmethod
    def run_probe(argument):
        return subprocess.run(
            [sys.executable, "-c", CREDENTIAL_PROBE_SOURCE, argument],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_probe_emits_every_field_its_consumers_read(self):
        with tempfile.TemporaryDirectory() as directory:
            credentials = pathlib.Path(directory) / "credentials.json"
            credentials.write_text(
                json.dumps(
                    {
                        "claudeAiOauth": {
                            "refreshToken": "refresh-token-that-must-not-be-printed",
                            "accessToken": "access-token-that-must-not-be-printed",
                            "expiresAt": 1_700_000_000_000,
                        },
                        "last_refresh": "2000-01-01T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            result = self.run_probe(str(credentials))

        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(
            set(record),
            {"huella", "huella_acc", "expiresAt", "last_refresh", "at_len"},
        )
        self.assertEqual(record["expiresAt"], 1_700_000_000_000)
        self.assertEqual(record["at_len"], len("access-token-that-must-not-be-printed"))
        self.assertEqual(len(record["huella"]), 10)
        self.assertEqual(len(record["huella_acc"]), 10)
        self.assertNotIn("refresh-token-that-must-not-be-printed", result.stdout)
        self.assertNotIn("access-token-that-must-not-be-printed", result.stdout)

class TestGuardInventory(unittest.TestCase):
    def test_targets_come_from_a_private_file(self):
        source = (GUARDS / "cred-guard.py").read_text(encoding="utf-8")
        self.assertIn("CAUCE_CRED_GUARD_TARGETS", source)
        example = json.loads((GUARDS / "cred-guard-targets.example.json").read_text(encoding="utf-8"))
        inventory = json.loads((GUARDS.parent / "container-aliases.json").read_text(encoding="utf-8"))
        known_homes = {alias["home"] for alias in inventory["aliases"].values() if alias.get("home")}
        for home in known_homes:
            self.assertNotIn(home, source)
        known = {
            alias["container"]
            for alias in inventory["aliases"].values()
            if alias.get("container")
        }
        for key in ("targets", "remote_targets"):
            rows = example[key]
            self.assertGreater(len(rows), 0)
            for row in rows:
                self.assertEqual(len(row), 3)
                self.assertTrue(all(isinstance(item, str) and item for item in row))
                container, path, _label = row
                self.assertTrue(container.startswith("<"))
                self.assertTrue(path.startswith("/home/dev/"))
                self.assertNotIn(container, known)


if __name__ == "__main__":
    unittest.main()
