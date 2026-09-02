#!/usr/bin/env python3
from __future__ import annotations

import ast
import contextlib
import io
import json
import math
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
    REFRESHABLE,
    UNKNOWN_EXPIRY,
    UNREFRESHABLE,
    classify_doctor_record,
    classify_fleet_guard_record,
    hours_until_expiry,
    probe_container,
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

    def test_probe_reports_an_absent_file(self):
        result = self.run_probe("/synthetic/path/that/does/not/exist.json")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.strip()), {"falta": True})

    def test_wrapper_parses_the_last_line_of_a_successful_probe(self):
        record = fleet_record("fingerprint-a", 1_700_000_000_000)
        with mock.patch(
            "subprocess.run",
            return_value=self.completed(stdout="warning noise\n" + json.dumps(record)),
        ) as runner:
            self.assertEqual(
                probe_container("synthetic-container", "/synthetic/credentials.json"),
                record,
            )

        command = runner.call_args.args[0]
        self.assertEqual(command[:3], ["docker", "exec", "synthetic-container"])
        self.assertEqual(command[3:6], ["python3", "-c", CREDENTIAL_PROBE_SOURCE])
        self.assertEqual(command[6], "/synthetic/credentials.json")
        self.assertEqual(runner.call_args.kwargs["timeout"], 25)

    def test_non_zero_return_code_becomes_a_short_error(self):
        with mock.patch(
            "subprocess.run",
            return_value=self.completed(returncode=7, stderr="x" * 200),
        ):
            failure = probe_container("synthetic-container", "/synthetic/credentials.json")
        with mock.patch("subprocess.run", return_value=self.completed(returncode=7)):
            silent = probe_container("synthetic-container", "/synthetic/credentials.json")

        self.assertEqual(failure, {"error": "x" * 60})
        self.assertEqual(silent, {"error": "rc=7"})

    def test_every_failure_is_reported_as_an_error_field(self):
        for failure in (OSError("boom"), subprocess.TimeoutExpired("docker", 25)):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch("subprocess.run", side_effect=failure):
                    result = probe_container("synthetic-container", "/synthetic/credentials.json")
                self.assertEqual(set(result), {"error"})
                self.assertIn(type(failure).__name__, result["error"])

        with mock.patch("subprocess.run", return_value=self.completed(stdout="not json")):
            unparsable = probe_container("synthetic-container", "/synthetic/credentials.json")
        self.assertEqual(set(unparsable), {"error"})

    def test_the_docker_command_is_overridable(self):
        with mock.patch(
            "subprocess.run",
            return_value=self.completed(stdout=json.dumps({"falta": True})),
        ) as runner:
            self.assertEqual(
                probe_container(
                    "synthetic-container",
                    "/synthetic/credentials.json",
                    timeout=3,
                    docker=("sudo", "docker"),
                ),
                {"falta": True},
            )

        self.assertEqual(runner.call_args.args[0][:3], ["sudo", "docker", "exec"])
        self.assertEqual(runner.call_args.kwargs["timeout"], 3)

    def test_neither_guard_keeps_its_own_copy_of_the_probe(self):
        for filename in ("cred-guard.py", "cauce-cred-guard-kratos.py"):
            with self.subTest(filename=filename):
                source = (GUARDS / filename).read_text(encoding="utf-8")
                self.assertIn("probe_container(contenedor, ruta)", source)
                self.assertNotIn("hashlib", source)


class TestGuardInventory(unittest.TestCase):
    """OBJETIVOS is hand-written on purpose: its labels carry shared-credential facts the
    inventory does not model, and deleting a row is what once left an alias unmonitored.
    This gate does not shrink it, it only catches a container renamed out from under it."""

    def test_every_targeted_container_exists_in_the_alias_inventory(self):
        source = (GUARDS / "cred-guard.py").read_text(encoding="utf-8")
        targets = None
        for node in ast.parse(source).body:
            names = getattr(node, "targets", [])
            if any(isinstance(name, ast.Name) and name.id == "OBJETIVOS" for name in names):
                targets = ast.literal_eval(node.value)
        self.assertIsNotNone(targets, "cred-guard.py no declara OBJETIVOS")

        inventory = json.loads(
            (GUARDS.parent / "container-aliases.json").read_text(encoding="utf-8")
        )
        known = {
            alias["container"]
            for alias in inventory["aliases"].values()
            if alias.get("container")
        }
        self.assertGreater(len(targets), 0)
        for container, _path, label in targets:
            with self.subTest(label=label):
                self.assertIn(container, known)


if __name__ == "__main__":
    unittest.main()
