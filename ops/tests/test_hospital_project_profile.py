from __future__ import annotations

import copy
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# cauce:requiere none

ROOT = Path(__file__).resolve().parents[2]
STATE_SOURCE = ROOT / "ops/instances/hospital/praxis-supervision-state.py"
STATE_SPEC = importlib.util.spec_from_file_location("praxis_supervision_state_profile_test", STATE_SOURCE)
assert STATE_SPEC is not None and STATE_SPEC.loader is not None
STATE = importlib.util.module_from_spec(STATE_SPEC)
sys.modules[STATE_SPEC.name] = STATE
STATE_SPEC.loader.exec_module(STATE)

PROFILE_SOURCE = ROOT / "ops/instances/hospital/project-profile.py"
PROFILE_SPEC = importlib.util.spec_from_file_location("hospital_project_profile", PROFILE_SOURCE)
assert PROFILE_SPEC is not None and PROFILE_SPEC.loader is not None
PROFILE = importlib.util.module_from_spec(PROFILE_SPEC)
sys.modules[PROFILE_SPEC.name] = PROFILE
PROFILE_SPEC.loader.exec_module(PROFILE)


class HospitalProjectProfileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hospital-profile-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.profile = copy.deepcopy(PROFILE.DEFAULT)
        self.profile.update(
            company_id="praxis",
            project_name="Laboratorio Delta",
            tenant_id="EmpresaDelta",
            room_id="grp.delta",
            supervisor_alias="delta-watch",
            recipient_alias="jefe",
            participants=["jefe", "ingeniero"],
            postgres_container="delta-db-1",
            postgres_user="delta_user",
            postgres_database="delta_database",
            workspace=str(self.directory / "workspace"),
            actor_container="delta-engineer-1",
            actor_workspace="/srv/delta/project",
            acceptance_root=str(self.directory / "control"),
            state_path=str(self.directory / "control/state.json"),
            config_path=str(self.directory / "control/config.json"),
            issue_count=38,
            roadmap_count=217,
            deferred_issues=[],
            root_text="Continuar el objetivo autorizado de Delta con datos sinteticos.",
            preview=None,
            acceptance_origin={
                "kind": "authenticated-owner",
                "channel": "cauce.trusted-origin",
                "conversation_id": "delta-owner",
            },
        )

    def fixture_trust(self, path: Path, directory: bool = False):
        metadata = path.lstat()
        valid = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
        if (
            not path.is_relative_to(self.directory)
            or not valid
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o022
        ):
            raise STATE.SupervisionError("untrusted_control_file")

    def test_default_profile_validates_and_fingerprint_is_stable(self):
        self.assertEqual(PROFILE.DEFAULT["schema_version"], 1)
        self.assertEqual(PROFILE.DEFAULT["company_id"], "praxis")
        self.assertEqual(PROFILE.DEFAULT["project_name"], "Praxis")
        self.assertEqual(PROFILE.DEFAULT["tenant_id"], "Hospital")
        self.assertEqual(PROFILE.DEFAULT["room_id"], "grp.hospital")
        self.assertEqual(PROFILE.DEFAULT["acceptance_origin"]["conversation_id"], "0")
        validated_default = PROFILE.validate(copy.deepcopy(PROFILE.DEFAULT), STATE)
        self.assertEqual(validated_default["company_id"], "praxis")
        self.assertEqual(validated_default["tenant_id"], "Hospital")
        self.assertEqual(PROFILE.validate(self.profile, STATE)["tenant_id"], "EmpresaDelta")
        digest = PROFILE.fingerprint(self.profile)
        self.assertEqual(digest, PROFILE.fingerprint(copy.deepcopy(self.profile)))
        self.assertNotEqual(digest, PROFILE.fingerprint({**self.profile, "room_id": "grp.other"}))
        self.assertNotEqual(digest, PROFILE.fingerprint({**self.profile, "company_id": "other-company"}))

    def test_for_config_requires_matching_fingerprint(self):
        self.assertIs(PROFILE.for_config({}, STATE), PROFILE.DEFAULT)
        self.assertIs(PROFILE.for_config(None, STATE), PROFILE.DEFAULT)
        config = {"project_profile": self.profile, "project_profile_sha256": PROFILE.fingerprint(self.profile)}
        self.assertEqual(PROFILE.for_config(config, STATE)["project_name"], "Laboratorio Delta")
        config["project_profile_sha256"] = "0" * 64
        with self.assertRaisesRegex(STATE.SupervisionError, "project_profile_fingerprint_mismatch"):
            PROFILE.for_config(config, STATE)

    def test_load_reads_external_profile_and_rejects_ambiguity_and_tampering(self):
        path = self.directory / "project.json"
        path.write_text(json.dumps(self.profile))
        path.chmod(0o600)
        config = {"project_profile_file": str(path), "project_profile_sha256": PROFILE.fingerprint(self.profile)}
        with mock.patch.object(STATE, "trusted_file", side_effect=self.fixture_trust):
            self.assertEqual(PROFILE.load(config, STATE)["tenant_id"], "EmpresaDelta")
            self.assertEqual(config["project_profile"]["room_id"], "grp.delta")
            with self.assertRaisesRegex(STATE.SupervisionError, "ambiguous_project_profile"):
                PROFILE.load(config, STATE)
            path.write_text(json.dumps({**self.profile, "room_id": "grp.tampered"}))
            path.chmod(0o600)
            config = {"project_profile_file": str(path), "project_profile_sha256": PROFILE.fingerprint(self.profile)}
            with self.assertRaisesRegex(STATE.SupervisionError, "fingerprint_mismatch"):
                PROFILE.load(config, STATE)
            path.chmod(0o666)
            config = {"project_profile_file": str(path), "project_profile_sha256": PROFILE.fingerprint(self.profile)}
            with self.assertRaisesRegex(STATE.SupervisionError, "untrusted_control_file"):
                PROFILE.load(config, STATE)

    def test_unsafe_paths_unknown_keys_and_bounds_are_rejected(self):
        cases = [
            ({"workspace": "/srv/project/../secrets"}, "invalid_project_profile_path"),
            ({"actor_workspace": "/srv/credentials"}, "invalid_project_profile_path"),
            ({"config_path": "/var/lib/.env"}, "invalid_project_profile_path"),
            ({"state_path": "/var/lib/.git/state.json"}, "invalid_project_profile_path"),
            ({"acceptance_root": str(self.directory / "workspace/control")}, "invalid_project_profile_path"),
            ({"actor_uid": 0}, "invalid_project_profile_bounds"),
            ({"actor_gid": -1}, "invalid_project_profile_bounds"),
            ({"issue_count": 0}, "invalid_project_profile_bounds"),
            ({"company_id": "invalid company with spaces"}, "invalid_project_profile_scope"),
            ({"tenant_id": "quote'unsafe"}, "invalid_project_profile_scope"),
            ({"room_id": "grp space"}, "invalid_project_profile_scope"),
            ({"supervisor_alias": "invalid@alias"}, "invalid_project_profile_scope"),
            ({"recipient_alias": "not_in_participants"}, "invalid_project_profile_participants"),
            ({"participants": ["jefe", "jefe"]}, "invalid_project_profile_participants"),
            ({"participants": []}, "invalid_project_profile_participants"),
            ({"extra": "ignored"}, "invalid_project_profile"),
            ({"schema_version": 2}, "invalid_project_profile"),
            (
                {"notification": {"enabled": True, "egress_handle": "invalid handle"}},
                "invalid_project_profile_notification",
            ),
            (
                {"acceptance_origin": {"kind": "untrusted", "channel": "open", "conversation_id": "0"}},
                "invalid_project_profile_origin",
            ),
        ]
        for mutation, expected_error in cases:
            with self.subTest(mutation=mutation):
                with self.assertRaisesRegex(STATE.SupervisionError, expected_error):
                    PROFILE.validate({**self.profile, **mutation}, STATE)

    def test_preview_shape_requires_loopback_health_and_workspace_match(self):
        preview = copy.deepcopy(PROFILE.DEFAULT["preview"])
        value = {**self.profile, "preview": preview}
        preview.update(
            workspace=self.profile["workspace"],
            root=str(self.directory / "preview"),
            publication_state=str(self.directory / "control/published.json"),
            unit_file=str(self.directory / "delta-preview.service"),
            service="delta-preview.service",
        )
        self.assertEqual(PROFILE.validate(value, STATE)["preview"]["service"], "delta-preview.service")

        mismatched_ws = copy.deepcopy(value)
        mismatched_ws["preview"]["workspace"] = "/srv/other/workspace"
        with self.assertRaisesRegex(STATE.SupervisionError, "invalid_project_profile_preview"):
            PROFILE.validate(mismatched_ws, STATE)

        bad_service = copy.deepcopy(value)
        bad_service["preview"]["service"] = "not-matching.service"
        with self.assertRaisesRegex(STATE.SupervisionError, "invalid_project_profile_preview"):
            PROFILE.validate(bad_service, STATE)

        external_health = copy.deepcopy(value)
        external_health["preview"]["health_url"] = "http://example.invalid:8077/api/session"
        with self.assertRaisesRegex(STATE.SupervisionError, "invalid_project_profile_preview"):
            PROFILE.validate(external_health, STATE)

        health_with_query = copy.deepcopy(value)
        health_with_query["preview"]["health_url"] = "http://127.0.0.1:8077/api/session?param=1"
        with self.assertRaisesRegex(STATE.SupervisionError, "invalid_project_profile_preview"):
            PROFILE.validate(health_with_query, STATE)

        missing_source = copy.deepcopy(value)
        missing_source["preview"]["required_sources"] = ["apps/api/other.py"]
        with self.assertRaisesRegex(STATE.SupervisionError, "invalid_project_profile_preview"):
            PROFILE.validate(missing_source, STATE)

    def test_command_identity_uses_profile_scope_without_granting_host_git(self):
        (self.directory / "workspace").mkdir()
        self.assertEqual(PROFILE.command_identity(["docker", "ps"], self.profile, STATE.SupervisionError), {})
        self.assertEqual(
            PROFILE.isolated_command(["docker", "ps"], self.profile, STATE.SupervisionError), ["docker", "ps"]
        )

        with mock.patch.object(PROFILE.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(STATE.SupervisionError, "git_requires_actor_isolation"):
                PROFILE.isolated_command(
                    ["git", "-C", self.profile["workspace"], "status"], self.profile, STATE.SupervisionError
                )

        with (
            mock.patch.object(PROFILE.os, "geteuid", return_value=0),
            mock.patch.object(PROFILE.Path, "stat", return_value=mock.Mock(st_uid=1000)),
        ):
            isolated = PROFILE.isolated_command(
                ["git", "-C", self.profile["workspace"], "status"], self.profile, STATE.SupervisionError
            )
        self.assertIn("delta-engineer-1", isolated)
        self.assertIn("/srv/delta/project", isolated)
        self.assertIn("1000:1000", isolated)

    def test_preview_settings_and_validate_preview(self):
        preview = copy.deepcopy(PROFILE.DEFAULT["preview"])
        preview.update(
            workspace=self.profile["workspace"],
            root=str(self.directory / "preview"),
            publication_state=str(self.directory / "control/published.json"),
            unit_file=str(self.directory / "delta-preview.service"),
            service="delta-preview.service",
        )
        profile_with_preview = {**self.profile, "preview": preview}
        config = {
            "project_profile": profile_with_preview,
            "project_profile_sha256": PROFILE.fingerprint(profile_with_preview),
            "workspace": self.profile["workspace"],
            "preview_root": str(self.directory / "preview"),
            "preview_files": preview["files"],
            "auto_publish_synthetic_preview": True,
        }
        mock_state = SimpleNamespace(
            project_profile=lambda c: profile_with_preview, SupervisionError=STATE.SupervisionError
        )
        settings = PROFILE.preview_settings(config, mock_state, {})
        self.assertEqual(settings["service"], "delta-preview.service")
        self.assertEqual(settings["uid"], "1000")

        # validate_preview succeeds
        PROFILE.validate_preview(config, mock_state, lambda c, s: settings, PROFILE.PREVIEW_CONFIG_KEYS)

        # validate_preview disabled does not validate settings
        disabled_config = {**config, "auto_publish_synthetic_preview": False, "workspace": "/mismatched"}
        PROFILE.validate_preview(disabled_config, mock_state, lambda c, s: settings, PROFILE.PREVIEW_CONFIG_KEYS)

        # validate_preview with mismatch raises error
        bad_config = {**config, "workspace": "/mismatched"}
        with self.assertRaisesRegex(STATE.SupervisionError, "invalid_preview_publication_configuration"):
            PROFILE.validate_preview(bad_config, mock_state, lambda c, s: settings, PROFILE.PREVIEW_CONFIG_KEYS)

    def test_no_private_data_or_real_hospital_credentials(self):
        raw_json = json.dumps(PROFILE.DEFAULT)
        # Check no private IPs (excluding 127.0.0.1 or ::1)
        found_ips = [
            ip for ip in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw_json) if ip not in {"127.0.0.1", "0.0.0.0"}
        ]
        self.assertEqual(found_ips, [])
        # Check no email addresses
        self.assertEqual(re.findall(r"[\w.-]+@[\w.-]+\.\w+", raw_json), [])
        # Check no personal telegram id
        self.assertNotIn("6979524541", raw_json)
        self.assertEqual(PROFILE.DEFAULT["acceptance_origin"]["conversation_id"], "0")
        # Check no private user workspaces
        self.assertNotIn("/home/stev", raw_json)
        self.assertNotIn("/datos", raw_json)


if __name__ == "__main__":
    unittest.main()
