#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import datetime
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

    def test_vps_guard_reports_shared_fingerprint_as_a_note_not_a_failure(self):
        fixture = fleet_record("shared-fingerprint", (time.time() + 200 * 3_600) * 1_000)
        remote = json.dumps({"host": "kratos", "ts": datetime.datetime.now(datetime.UTC).isoformat(), "filas": []})
        output = io.StringIO()
        real_open = open

        def synthetic_open(path, *args, **kwargs):
            if str(path) == "/var/lib/cauce-v3/cred-guard-kratos.json":
                return io.StringIO(remote)
            return real_open(path, *args, **kwargs)

        with (
            mock.patch("subprocess.run", return_value=self.result(json.dumps(fixture))),
            mock.patch("builtins.open", side_effect=synthetic_open),
            contextlib.redirect_stdout(output),
            self.assertRaises(SystemExit) as exited,
        ):
            runpy.run_path(str(GUARDS / "cred-guard.py"), run_name="credential_test_vps_shared")

        self.assertEqual(exited.exception.code, 0)
        self.assertIn("NOTA: cuentas compartidas", output.getvalue())
        self.assertIn("problemas=0", output.getvalue())

    def test_doctor_reports_shared_fingerprint_once_and_never_as_a_problem(self):
        fixture = doctor_record("shared-fingerprint", (time.time() + 200 * 3_600) * 1_000)
        namespace = runpy.run_path(str(GUARDS / "cauce-v3-medico-monitor"), run_name="credential_test_doctor_shared")
        consumer = namespace["sonda_credenciales"]
        consumer.__globals__["sh"] = lambda *_args, **_kwargs: (0, json.dumps(fixture), "")
        problems, shared = consumer({
            ("t", "alpha"): {"contenedor": "container-one", "host": "kratos"},
            ("t", "beta"): {"contenedor": "container-two", "host": "kratos"},
        })
        self.assertEqual(problems, [])
        self.assertEqual(shared, {"shared-fingerprint": ["t/alpha", "t/beta"]})
        source = (GUARDS / "cauce-v3-medico-monitor").read_text(encoding="utf-8")
        loop = source[source.index("for h, quienes in sorted(compartidas.items())"):source.index("# --- 5) AI account")]
        self.assertIn('apuntes.append({"tipo": "credencial_compartida"', loop)
        self.assertNotIn("escalar", loop)

    def test_doctor_still_escalates_a_credential_without_refresh_token(self):
        fixture = doctor_record(None, (time.time() - 3_600) * 1_000)
        namespace = runpy.run_path(str(GUARDS / "cauce-v3-medico-monitor"), run_name="credential_test_doctor_dead")
        consumer = namespace["sonda_credenciales"]
        consumer.__globals__["sh"] = lambda *_args, **_kwargs: (0, json.dumps(fixture), "")
        problems, shared = consumer({"alpha": {"contenedor": "container-one", "host": "kratos"}})
        self.assertEqual(len(problems), 1)
        self.assertEqual(shared, {})

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
                with mock.patch.object(sys, "argv", ["cred-guard.py", "--sonda-remota"]):
                    runpy.run_path(
                        str(GUARDS / "cred-guard.py"),
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

    def test_unreadable_credentials_count_as_problems_with_state_enabled(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            code, output, errors = self.run_guard(directory, lambda *_args: {"error": "synthetic-read-failure"})
            self.assertEqual(code, 1)
            self.assertIn("ILEGIBLE", output)
            self.assertIn("problemas=2", output)
            self.assert_state(directory, output, errors, exit_code=1, problems=2, shared=0)

    def test_remote_unreadable_record_counts_even_without_problem_flag(self):
        remote = json.dumps({
            "host": "kratos", "ts": datetime.datetime.now(datetime.UTC).isoformat(),
            "filas": [{"huella": "?", "etiqueta": "claude/synthetic", "contenedor": "synthetic",
                       "estado": "ILEGIBLE", "detalle": "synthetic-read-failure"}],
        })
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            real_load = json.load

            def load(handle, *args, **kwargs):
                data = real_load(handle, *args, **kwargs)
                if isinstance(data, dict) and "filas" in data and "targets" not in data:
                    return json.loads(remote)
                return data

            with mock.patch("json.load", side_effect=load):
                code, output, errors = self.run_guard(directory, lambda *_args: {"falta": True})
            self.assertEqual(code, 1)
            self.assert_state(directory, output, errors, exit_code=1, problems=1, shared=0)

    def test_remote_push_failure_preserves_stderr_and_exit_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            code, output, errors = self.run_guard(
                directory, lambda *_args: {"falta": True}, arguments=("--sonda-remota",),
                push_result=mock.Mock(returncode=7, stderr="synthetic-push-failure"),
            )
            self.assertEqual(code, 1)
            self.assertIn("synthetic-push-failure", errors)
            self.assertIn("NO EXISTE", output)
            self.assert_state(directory, output, errors, exit_code=1, problems=0, shared=0)

    def test_unknown_arguments_are_rejected_in_both_modes(self):
        for arguments in (("--unknown",), ("--sonda-remota", "--unknown"), ("--sonda",)):
            with self.subTest(arguments=arguments), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                code, output, errors = self.run_guard(
                    directory, lambda *_args: self.fail("invalid arguments must not run a probe"), arguments=arguments,
                )
                self.assertEqual(code, 2)
                self.assertIn("unrecognized arguments", errors)
                self.assert_state(directory, output, errors, exit_code=2, problems=0, shared=0)

    def test_failed_push_preserves_measured_problems_and_timeout_stderr(self):
        failures = (
            subprocess.TimeoutExpired("ssh", 60, stderr="synthetic-timeout-diagnostic"),
            subprocess.TimeoutExpired("ssh", 60, stderr=b"synthetic-timeout-diagnostic"),
            OSError("synthetic-launch-failure"),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)
                code, output, errors = self.run_guard(
                    directory, lambda *_args: fleet_record(None, None), arguments=("--sonda-remota",),
                    push_failure=failure,
                )
                self.assertEqual(code, 1)
                self.assertIn("MUERTO", output)
                if isinstance(failure, subprocess.TimeoutExpired):
                    self.assertIn("synthetic-timeout-diagnostic", errors)
                else:
                    self.assertIn("OSError", errors)
                self.assert_state(directory, output, errors, exit_code=1, problems=2, shared=0)

    def test_unexpected_failure_preserves_partial_output_and_restores_streams(self):
        def record(*_args):
            print("synthetic partial output")
            print("synthetic diagnostic", file=sys.stderr)
            raise RuntimeError("synthetic failure")

        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            code, output, errors = self.run_guard(directory, record)
            self.assertEqual(code, 1)
            self.assertIn("synthetic partial output", output)
            self.assertIn("synthetic diagnostic", errors)
            self.assertIn("RuntimeError", errors)
            self.assert_state(directory, output, errors, exit_code=1, problems=0, shared=0)


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
        for filename in ("cred-guard.py",):
            with self.subTest(filename=filename):
                source = (GUARDS / filename).read_text(encoding="utf-8")
                self.assertIn("probe_container(contenedor, ruta)", source)
                self.assertNotIn("hashlib", source)


class TestGuardInventory(unittest.TestCase):
    def test_targets_come_from_a_private_file(self):
        source = (GUARDS / "cred-guard.py").read_text(encoding="utf-8")
        self.assertIn("CAUCE_CRED_GUARD_TARGETS", source)
        self.assertNotIn("/home/claw", source)
        self.assertNotIn("/home/stev", source)
        example = json.loads((GUARDS / "cred-guard-targets.example.json").read_text(encoding="utf-8"))
        inventory = json.loads((GUARDS.parent / "container-aliases.json").read_text(encoding="utf-8"))
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
                self.assertNotIn("/home/claw", path)
                self.assertNotIn("/home/stev", path)
                self.assertNotIn(container, known)


if __name__ == "__main__":
    unittest.main()
