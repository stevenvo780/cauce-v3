from __future__ import annotations

import configparser
import json
import time
import unittest
from unittest import mock

import test_praxis_supervision as fixtures

# cauce:requiere none

SUP, PREVIEW = fixtures.SUP, fixtures.SUP.PREVIEW


class PreviewPublicationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()
        self.fixture.preview.chmod(0o755)
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

    def test_active_work_unready_actors_and_failed_qa_never_publish(self):
        for runtime in ({"active": 1, "ready": True}, {"active": 0, "ready": False}):
            self.assertEqual(self.publish(runtime=runtime)["action"], "preview_active_work")
        engineering = self.engineering()
        engineering["valid_gates"].remove("qa")
        self.assertEqual(self.publish(engineering)["action"], "preview_evidence_pending")
        self.assertEqual(self.commands, [])
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
                self.assertEqual(opener.open.call_count, 1)

class PreviewServiceSandboxTests(unittest.TestCase):
    def test_root_controller_can_write_only_private_state_and_fixed_public_preview(self):
        path = fixtures.ROOT / "ops/instances/hospital/praxis-supervision.service"
        unit = configparser.ConfigParser(interpolation=None)
        unit.read(path)
        service = unit["Service"]
        self.assertEqual(set(service["ReadWritePaths"].split()), {
            "/var/lib/praxis-supervision", "/opt/hospital-agent/runtime/praxis-preview/web"})
        self.assertEqual(service["ProtectSystem"], "strict")
        self.assertEqual(service["ProtectHome"], "true")
        self.assertEqual(service["NoNewPrivileges"], "true")
        self.assertEqual(service["User"], "root")


if __name__ == "__main__":
    unittest.main()
