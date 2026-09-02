#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import io
import json
import math
import os
import pathlib
import runpy
import sys
import tempfile
import time
import unittest
from unittest import mock

GUARDS = pathlib.Path(__file__).resolve().parents[1] / "guardias"
sys.path.insert(0, str(GUARDS))

import credential_health  # noqa: E402
from credential_health import (  # noqa: E402
    LONG_LIVED,
    REFRESHABLE,
    UNKNOWN_EXPIRY,
    UNREFRESHABLE,
    classify_doctor_record,
    classify_fleet_guard_record,
    hours_until_expiry,
    shared_fingerprints,
)

NOW = 2_000_000_000.0


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

    def test_invalid_expiry_is_unknown(self):
        for value in (None, True, "not-a-timestamp", 0, -1, math.nan, math.inf):
            with self.subTest(value=value):
                self.assertIsNone(hours_until_expiry(value, now_epoch=NOW))


class TestCredentialClassification(unittest.TestCase):
    def test_fleet_record_reads_huella_and_expires_at(self):
        record = fleet_record("fingerprint-a", (NOW - 3_600) * 1_000)
        record["exp"] = (NOW + 999_999) * 1_000
        health = classify_fleet_guard_record(
            record,
            now_epoch=NOW,
        )
        self.assertEqual(health.fingerprint, "fingerprint-a")
        self.assertEqual(health.state, REFRESHABLE)
        self.assertEqual(health.operational_state, "OK")
        self.assertFalse(health.problem)
        self.assertEqual(health.hours_until_expiry, -1)

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

    def test_threshold_is_exclusive(self):
        health = classify_doctor_record(
            doctor_record(None, (NOW + 168 * 3_600) * 1_000),
            now_epoch=NOW,
        )
        self.assertEqual(health.state, UNREFRESHABLE)
        self.assertTrue(health.problem)

    def test_unknown_expiry_policy_changes_only_problem_flag(self):
        strict = classify_fleet_guard_record(fleet_record(None, None), now_epoch=NOW)
        tolerant = classify_doctor_record(doctor_record(None, None), now_epoch=NOW)

        self.assertEqual(strict.state, UNKNOWN_EXPIRY)
        self.assertEqual(strict.operational_state, "MUERTO")
        self.assertTrue(strict.problem)
        self.assertEqual(tolerant.state, UNKNOWN_EXPIRY)
        self.assertEqual(tolerant.operational_state, "OK")
        self.assertFalse(tolerant.problem)

    def test_each_consumer_ignores_the_other_expiry_key(self):
        fleet_fixture = fleet_record(None, None)
        fleet_fixture["exp"] = (NOW + 1_000 * 3_600) * 1_000
        doctor_fixture = doctor_record(None, None)
        doctor_fixture["expiresAt"] = (NOW + 1_000 * 3_600) * 1_000
        fleet_guard = classify_fleet_guard_record(
            fleet_fixture,
            now_epoch=NOW,
        )
        doctor = classify_doctor_record(
            doctor_fixture,
            now_epoch=NOW,
        )

        self.assertEqual((fleet_guard.state, fleet_guard.problem), (UNKNOWN_EXPIRY, True))
        self.assertEqual((doctor.state, doctor.problem), (UNKNOWN_EXPIRY, False))


class TestConsumerWiring(unittest.TestCase):
    @staticmethod
    def result(stdout=""):
        return mock.Mock(returncode=0, stdout=stdout, stderr="")

    def test_vps_guard_classifies_the_complete_record(self):
        fixture = fleet_record(None, (time.time() + 200 * 3_600) * 1_000)
        output = io.StringIO()
        real_open = open

        def synthetic_open(path, *args, **kwargs):
            if str(path) == "/var/lib/cauce-v3/cred-guard-kratos.json":
                raise FileNotFoundError(path)
            return real_open(path, *args, **kwargs)

        with (
            mock.patch.object(
                credential_health,
                "classify_fleet_guard_record",
                wraps=credential_health.classify_fleet_guard_record,
            ) as adapter,
            mock.patch(
                "subprocess.run",
                return_value=self.result(json.dumps(fixture)),
            ),
            mock.patch("builtins.open", side_effect=synthetic_open),
            contextlib.redirect_stdout(output),
            self.assertRaises(SystemExit) as exited,
        ):
            runpy.run_path(str(GUARDS / "cred-guard.py"), run_name="credential_test_vps")

        self.assertEqual(exited.exception.code, 1)
        self.assertGreater(adapter.call_count, 0)
        for call in adapter.call_args_list:
            self.assertEqual(call.args[0], fixture)
            self.assertIn("now_epoch", call.kwargs)
        self.assertIn("MUERTO", output.getvalue())

    def test_kratos_guard_classifies_the_complete_record(self):
        fixture = fleet_record(None, (time.time() + 200 * 3_600) * 1_000)
        output = io.StringIO()

        def synthetic_run(command, *_args, **_kwargs):
            stdout = json.dumps(fixture) if command[:2] == ["docker", "exec"] else ""
            return self.result(stdout)

        with tempfile.TemporaryDirectory() as home_dir:
            with (
                mock.patch.dict(os.environ, {"HOME": home_dir}),
                mock.patch.object(
                    credential_health,
                    "classify_fleet_guard_record",
                    wraps=credential_health.classify_fleet_guard_record,
                ) as adapter,
                mock.patch("subprocess.run", side_effect=synthetic_run),
                contextlib.redirect_stdout(output),
                self.assertRaises(SystemExit) as exited,
            ):
                runpy.run_path(
                    str(GUARDS / "cauce-cred-guard-kratos.py"),
                    run_name="credential_test_kratos",
                )

        self.assertEqual(exited.exception.code, 0)
        self.assertGreater(adapter.call_count, 0)
        for call in adapter.call_args_list:
            self.assertEqual(call.args[0], fixture)
            self.assertIn("now_epoch", call.kwargs)
        self.assertIn("MUERTO", output.getvalue())

    def test_doctor_classifies_the_complete_record(self):
        fixture = doctor_record(None, (time.time() + 200 * 3_600) * 1_000)

        with mock.patch.object(
            credential_health,
            "classify_doctor_record",
            wraps=credential_health.classify_doctor_record,
        ) as adapter:
            namespace = runpy.run_path(
                str(GUARDS / "cauce-v3-medico-monitor"),
                run_name="credential_test_doctor",
            )
            consumer = namespace["sonda_credenciales"]
            consumer.__globals__["sh"] = lambda *_args, **_kwargs: (
                0,
                json.dumps(fixture),
                "",
            )
            problems, shared = consumer(
                {"alpha": {"contenedor": "synthetic-container", "host": "kratos"}}
            )

        adapter.assert_called_once()
        self.assertEqual(adapter.call_args.args[0], fixture)
        self.assertIn("now_epoch", adapter.call_args.kwargs)
        self.assertEqual(problems, [])
        self.assertEqual(shared, {})

    def test_all_consumers_use_full_record_classification(self):
        consumers = {
            "cred-guard.py": "classify_fleet_guard_record(d,",
            "cauce-cred-guard-kratos.py": "classify_fleet_guard_record(d,",
            "cauce-v3-medico-monitor": "classify_doctor_record(d,",
        }
        for filename, adapter_call in consumers.items():
            with self.subTest(filename=filename):
                source = (GUARDS / filename).read_text(encoding="utf-8")
                self.assertIn(adapter_call, source)


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

    def test_duplicate_subject_is_reported_once(self):
        observations = [
            ("fingerprint-a", "alpha", "container-one"),
            ("fingerprint-a", "alpha", "container-two"),
        ]

        self.assertEqual(shared_fingerprints(observations), {"fingerprint-a": ["alpha"]})


if __name__ == "__main__":
    unittest.main()
