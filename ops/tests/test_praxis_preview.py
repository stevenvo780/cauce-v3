from __future__ import annotations

import json
import time
import unittest
import urllib.error
from unittest import mock

import test_praxis_supervision as fixtures

# cauce:requiere none

SUP, PREVIEW = fixtures.SUP, fixtures.SUP.PREVIEW


class PreviewPublicationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()
        self.control = self.fixture.directory / "control"
        self.control.mkdir(mode=0o700)
        self.unit = self.fixture.directory / "praxis-preview.service"
        self.unit.write_text("synthetic protected systemd configuration")
        self.marker = self.control / "published-preview.json"
        self.patches = [mock.patch.object(PREVIEW, name, value) for name, value in (
            ("WORKSPACE", self.fixture.workspace), ("PREVIEW_ROOT", self.fixture.preview),
            ("PUBLICATION_STATE", self.marker), ("UNIT_FILE", self.unit))]
        self.patches.append(mock.patch.object(PREVIEW, "http_auth_health", return_value=None))
        for patch in self.patches:
            patch.start()
        SUP.STATE.trusted_file.side_effect = self.synthetic_trust
        api = self.fixture.workspace / "apps/api"
        api.mkdir()
        (api / "server.py").write_text("synthetic public API source")
        (api / "store.py").write_text("synthetic public storage source")
        self.originals = {name: (self.fixture.preview / name).read_bytes() for name in PREVIEW.WEB_FILES.values()}
        for source in PREVIEW.WEB_FILES:
            (self.fixture.workspace / source).write_text("new synthetic " + source)
        self.config = {**self.fixture.config, "auto_publish_synthetic_preview": True}
        self.head, self.commands = fixtures.HEAD, []
        self.metadata = ("LoadState=loaded\nUser=1000\nGroup=1000\nNoNewPrivileges=yes\nFragmentPath=" + str(self.unit)
            + "\nDropInPaths=\nExecStartEx={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 "
            + str(self.fixture.workspace / "apps/api/server.py") + " ; flags= ; pid=1 ; }\n")

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.fixture.tearDown()

    def synthetic_trust(self, path, directory=False):
        if directory and path in self.fixture.directory.parents:
            return
        self.fixture.fixture_trust(path, directory)

    def engineering(self):
        paths = set(PREVIEW.WEB_FILES) | {"apps/api/server.py", "apps/api/store.py"}
        return {"goal_sha256": self.config["goal_sha256"], "git_head": self.head, "verified_engineering": True,
                "verification_source_current": True, "valid_gates": ["tests", "qa", "snapshot"],
                "source_hashes": {path: SUP.digest((self.fixture.workspace / path).read_bytes()) for path in paths},
                "production_clinical_accepted": False}

    def runtime(self):
        return {"active": 0, "ready": True, "observed_at": time.time()}

    def command(self, arguments, deadline):
        self.commands.append(arguments)
        self.assertGreater(deadline, time.monotonic())
        if arguments[0] == "git":
            self.assertEqual(arguments[:3], ["git", "-C", str(self.fixture.workspace)])
            return self.head if arguments[3:] == ["rev-parse", "HEAD"] else ""
        self.assertEqual(arguments[0], "systemctl")
        self.assertIn(PREVIEW.SERVICE, arguments)
        return self.metadata if arguments[1] == "show" else ""

    def publish(self, engineering=None, runtime=None, runtime_reader=None, source_matches=None, observe_only=False):
        return PREVIEW.publish(self.config, engineering or self.engineering(), runtime or self.runtime(), time.monotonic() + 55,
            SUP.STATE, self.command, runtime_reader or self.runtime,
            source_matches or SUP.EVIDENCE.EvidenceReader(self.fixture.workspace, SUP.STATE).source_matches, observe_only)

    def restarts(self):
        return [command for command in self.commands if command == ["systemctl", "restart", PREVIEW.SERVICE]]

    def test_default_disabled_and_observation_only_have_no_side_effects(self):
        self.config.pop("auto_publish_synthetic_preview")
        self.assertEqual(self.publish()["action"], "preview_disabled")
        self.config["auto_publish_synthetic_preview"] = True
        self.assertEqual(self.publish(observe_only=True)["action"], "preview_observe_only")
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.commands, [])

    def test_publish_copies_only_three_assets_and_restarts_fixed_unprivileged_service_once(self):
        private = self.fixture.workspace / "patient.sqlite"
        private.write_bytes(b"synthetic private sentinel")
        result = self.publish()
        self.assertEqual(result["action"], "preview_published")
        self.assertEqual(self.restarts(), [["systemctl", "restart", PREVIEW.SERVICE]])
        for source, name in PREVIEW.WEB_FILES.items():
            self.assertEqual((self.fixture.preview / name).read_bytes(), (self.fixture.workspace / source).read_bytes())
        self.assertEqual(private.read_bytes(), b"synthetic private sentinel")
        marker = json.loads(self.marker.read_text())
        self.assertEqual(marker["authorization"], "existing_owner_synthetic_preview")
        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)
        self.assertEqual(set(marker["web_hashes"]), set(PREVIEW.WEB_FILES.values()))

    def test_idempotent_source_does_not_restart_again_even_after_metadata_commit(self):
        self.publish()
        self.head = fixtures.NEXT_HEAD
        self.assertEqual(self.publish()["action"], "preview_already_current")
        self.assertEqual(len(self.restarts()), 1)

    def test_api_code_fingerprint_restarts_without_copying_or_importing_data(self):
        self.publish()
        (self.fixture.workspace / "apps/api/server.py").write_text("new verified synthetic API")
        self.head = fixtures.NEXT_HEAD
        self.assertTrue(self.publish()["service_restarted"])
        self.assertEqual(len(self.restarts()), 2)

    def test_active_work_unready_actors_and_failed_qa_never_publish(self):
        for runtime in ({"active": 1, "ready": True}, {"active": 0, "ready": False}):
            self.assertEqual(self.publish(runtime=runtime)["action"], "preview_active_work")
        engineering = self.engineering()
        engineering["valid_gates"].remove("qa")
        self.assertEqual(self.publish(engineering)["action"], "preview_evidence_pending")
        self.assertEqual(self.commands, [])
        self.assertFalse(self.marker.exists())

    def test_clinical_scope_unknown_destination_or_configuration_is_refused(self):
        engineering = self.engineering()
        engineering["production_clinical_accepted"] = True
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_clinical_scope_refused"):
            self.publish(engineering)
        for mutation in ({"preview_root": "/tmp/unprotected"}, {"preview_service": "privileged.service"},
                         {"preview_files": {"apps/web/app.js": "../sessions/auth.json"}}, {"auto_publish_synthetic_preview": 1}):
            config = {**self.config, **mutation}
            with self.assertRaisesRegex(SUP.SupervisionError, "invalid_preview_publication_configuration"):
                PREVIEW.validate_config(config, SUP.STATE)
        self.assertFalse(self.marker.exists())

    def test_source_hash_or_head_race_prevents_restart_and_marker(self):
        engineering = self.engineering()
        engineering["source_hashes"]["apps/web/app.js"] = "f" * 64
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_source_changed"):
            self.publish(engineering)
        engineering = self.engineering()
        engineering["git_head"] = fixtures.NEXT_HEAD
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_source_changed"):
            self.publish(engineering)
        self.assertEqual(self.restarts(), [])
        self.assertFalse(self.marker.exists())

    def test_late_source_change_or_activity_rolls_back_before_restart(self):
        reads = 0
        def changing_source(sources):
            nonlocal reads
            reads += 1
            if reads == 2:
                (self.fixture.workspace / "apps/web/app.js").write_text("unverified late change")
            return SUP.EVIDENCE.EvidenceReader(self.fixture.workspace, SUP.STATE).source_matches(sources)
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_source_changed"):
            self.publish(source_matches=changing_source)
        for name, value in self.originals.items():
            self.assertEqual((self.fixture.preview / name).read_bytes(), value)
        runtime_reads = iter([self.runtime(), self.runtime(), {**self.runtime(), "active": 1}])
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_activity_changed"):
            self.publish(runtime_reader=lambda: next(runtime_reads))
        for name, value in self.originals.items():
            self.assertEqual((self.fixture.preview / name).read_bytes(), value)
        self.assertEqual(self.restarts(), [])
        self.assertFalse(self.marker.exists())

    def test_copy_failure_restores_all_changed_public_bytes(self):
        original = PREVIEW.atomic_bytes
        calls = 0
        def failing_copy(directory, name, value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic copy error")
            original(directory, name, value)
        with mock.patch.object(PREVIEW, "atomic_bytes", side_effect=failing_copy), \
                self.assertRaisesRegex(SUP.SupervisionError, "preview_publication_failed"):
            self.publish()
        for name, value in self.originals.items():
            self.assertEqual((self.fixture.preview / name).read_bytes(), value)
        self.assertEqual(self.restarts(), [])
        self.assertFalse(self.marker.exists())

    def test_unknown_service_health_rolls_back_and_does_not_write_success_marker(self):
        original = self.command
        def unhealthy(arguments, deadline):
            if arguments[:2] == ["systemctl", "is-active"]:
                raise SUP.SupervisionError("observation_unavailable")
            return original(arguments, deadline)
        with mock.patch.object(self, "command", side_effect=unhealthy), \
                self.assertRaisesRegex(SUP.SupervisionError, "preview_service_health_unknown"):
            self.publish()
        for name, value in self.originals.items():
            self.assertEqual((self.fixture.preview / name).read_bytes(), value)
        self.assertFalse(self.marker.exists())

    def test_symlinks_secrets_or_unguarded_root_directories_are_refused(self):
        engineering = self.engineering()
        engineering["source_hashes"][".env"] = "f" * 64
        with self.assertRaisesRegex(SUP.SupervisionError, "artifact_scope"):
            self.publish(engineering)
        target = self.fixture.preview / "app.js"
        target.unlink()
        target.symlink_to(self.fixture.workspace / "apps/api/server.py")
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_unsafe_public_file"):
            self.publish()
        target.unlink()
        target.write_bytes(self.originals["app.js"])
        self.fixture.preview.chmod(0o777)
        with self.assertRaisesRegex(SUP.SupervisionError, "untrusted_control_file"):
            self.publish()
        self.assertEqual(self.restarts(), [])
        self.assertFalse(self.marker.exists())

    def test_privileged_unit_flags_hooks_or_root_user_are_refused(self):
        valid = self.metadata
        for metadata in (valid.replace("User=1000", "User=0"), valid.replace("flags= ;", "flags=fully-privileged ;"),
                         valid + "ExecStartPreEx=privileged hook\n", valid + "ExecConditionEx=privileged condition\n",
                         valid.replace("NoNewPrivileges=yes", "NoNewPrivileges=no")):
            self.metadata = metadata
            with self.assertRaisesRegex(SUP.SupervisionError, "preview_service_unguarded"):
                self.publish()
        self.assertEqual(self.restarts(), [])
        self.assertFalse(self.marker.exists())

    def test_symlink_source_parent_is_rejected_before_source_hash_reader_runs(self):
        engineering = self.engineering()
        web = self.fixture.workspace / "apps/web"
        held = self.fixture.workspace / "apps/web-held"
        web.rename(held)
        web.symlink_to(held, target_is_directory=True)
        reader = mock.Mock(return_value=True)
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_unsafe_public_file"):
            self.publish(engineering, source_matches=reader)
        reader.assert_not_called()
        self.assertEqual(self.restarts(), [])
        self.assertFalse(self.marker.exists())

    def test_parent_swapped_to_private_symlink_before_open_is_denied_before_any_bytes_are_read(self):
        for reader in (lambda path: PREVIEW.public_bytes(path, SUP.STATE), SUP.STATE.read_bytes):
            with self.subTest(reader=reader):
                web = self.fixture.workspace / "apps/web"
                held = self.fixture.workspace / "apps/web-held"
                private = self.fixture.directory / "private-sentinel"
                private.mkdir(exist_ok=True)
                (private / "app.js").write_bytes(b"synthetic private source sentinel")
                path = web / "app.js"
                original_open, original_fdopen = PREVIEW.os.open, PREVIEW.os.fdopen
                switched = False
                def swapping_open(name, flags, *args, race_path=path, race_web=web, race_held=held,
                                  race_private=private, open_impl=original_open, **kwargs):
                    nonlocal switched
                    if not switched and (name == "web" or str(name) == str(race_path)):
                        switched = True
                        race_web.rename(race_held)
                        race_web.symlink_to(race_private, target_is_directory=True)
                    return open_impl(name, flags, *args, **kwargs)
                with mock.patch.object(PREVIEW.os, "open", side_effect=swapping_open), \
                        mock.patch.object(PREVIEW.os, "fdopen", wraps=original_fdopen) as read_source, \
                        self.assertRaises(SUP.SupervisionError):
                    reader(path)
                self.assertTrue(switched)
                read_source.assert_not_called()
                web.unlink()
                held.rename(web)

    def test_stop_stale_runtime_and_insufficient_deadline_leave_preview_unchanged(self):
        stop = self.control / "STOP"
        stop.write_text("owner stop")
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_owner_stopped"):
            self.publish()
        stop.unlink()
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_runtime_stale"):
            self.publish(runtime_reader=lambda: {**self.runtime(), "observed_at": time.time() - 11})
        with self.assertRaisesRegex(SUP.SupervisionError, "preview_pass_timeout"):
            PREVIEW.publish(self.config, self.engineering(), self.runtime(), time.monotonic() + 5,
                SUP.STATE, self.command, self.runtime, lambda _: True)
        self.assertEqual(self.commands, [])
        self.assertFalse(self.marker.exists())


class PreviewHttpHealthTests(unittest.TestCase):
    def test_only_json_401_is_expected_and_body_is_never_read_or_cookies_sent(self):
        for status, content_type, expected in ((401, "application/json; charset=utf-8", True),
                                             (200, "application/json", False), (401, "text/html", False), (302, "application/json", False)):
            with self.subTest(status=status, content_type=content_type):
                response = mock.Mock(code=status, headers={"Content-Type": content_type})
                opener = mock.Mock()
                opener.open.return_value = response
                with mock.patch.object(PREVIEW.urllib.request, "build_opener", return_value=opener):
                    if expected:
                        PREVIEW.http_auth_health(time.monotonic() + 5, SUP.STATE)
                    else:
                        with self.assertRaisesRegex(SUP.SupervisionError, "preview_http_auth_health_failed"):
                            PREVIEW.http_auth_health(time.monotonic() + 5, SUP.STATE)
                request = opener.open.call_args.args[0]
                self.assertEqual(request.full_url, "http://127.0.0.1:8077/api/session")
                self.assertNotIn("Cookie", dict(request.header_items()))
                response.read.assert_not_called()
                response.close.assert_called_once()

    def test_http_error_401_is_success_but_transport_unknown_is_closed(self):
        error = urllib.error.HTTPError(PREVIEW.HEALTH_URL, 401, "Unauthorized", {"Content-Type": "application/json"}, None)
        opener = mock.Mock()
        opener.open.side_effect = error
        with mock.patch.object(PREVIEW.urllib.request, "build_opener", return_value=opener):
            PREVIEW.http_auth_health(time.monotonic() + 5, SUP.STATE)
        opener.open.side_effect = urllib.error.URLError("synthetic unknown transport")
        with mock.patch.object(PREVIEW.urllib.request, "build_opener", return_value=opener), \
                self.assertRaisesRegex(SUP.SupervisionError, "preview_http_auth_health_unknown"):
            PREVIEW.http_auth_health(time.monotonic() + 5, SUP.STATE)


if __name__ == "__main__":
    unittest.main()
