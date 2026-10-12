from __future__ import annotations

import copy
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
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
PROFILE_SPEC = importlib.util.spec_from_file_location("praxis_project_profile", PROFILE_SOURCE)
assert PROFILE_SPEC is not None and PROFILE_SPEC.loader is not None
PROFILE = importlib.util.module_from_spec(PROFILE_SPEC)
sys.modules[PROFILE_SPEC.name] = PROFILE
PROFILE_SPEC.loader.exec_module(PROFILE)


class ProjectProfileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="praxis-profile-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.profile = copy.deepcopy(PROFILE.DEFAULT)
        self.profile.update(
            project_name="Laboratorio Delta", tenant_id="EmpresaDelta", room_id="grp.delta",
            supervisor_alias="delta-watch", recipient_alias="jefe", participants=["jefe", "ingeniero"],
            postgres_container="delta-db-1", postgres_user="delta_user", postgres_database="delta_database",
            workspace=str(self.directory / "workspace"), actor_container="delta-engineer-1",
            actor_workspace="/srv/delta/project", acceptance_root=str(self.directory / "control"),
            state_path=str(self.directory / "control/state.json"),
            config_path=str(self.directory / "control/config.json"), issue_count=38, roadmap_count=217,
            deferred_issues=[], root_text="Continuar el objetivo autorizado de Delta con datos sinteticos.",
            preview=None,
            acceptance_origin={"kind": "authenticated-owner", "channel": "cauce.trusted-origin",
                               "conversation_id": "delta-owner"})

    def fixture_trust(self, path, directory=False):
        metadata = path.lstat()
        valid = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
        if (not path.is_relative_to(self.directory) or not valid
                or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022):
            raise STATE.SupervisionError("untrusted_control_file")

    def test_default_profile_validates_and_fingerprint_is_stable(self):
        self.assertEqual(PROFILE.validate(copy.deepcopy(PROFILE.DEFAULT), STATE)["tenant_id"], "Hospital")
        self.assertEqual(PROFILE.validate(self.profile, STATE)["tenant_id"], "EmpresaDelta")
        digest = PROFILE.fingerprint(self.profile)
        self.assertEqual(digest, PROFILE.fingerprint(copy.deepcopy(self.profile)))
        self.assertNotEqual(digest, PROFILE.fingerprint({**self.profile, "room_id": "grp.other"}))

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
        for mutation in ({"workspace": "/srv/project/../secrets"}, {"actor_workspace": "/srv/credentials"},
                         {"actor_uid": 0}, {"participants": ["jefe", "jefe"]}, {"tenant_id": "quote'unsafe"},
                         {"extra": "ignored"}, {"acceptance_root": str(self.directory / "workspace/control")}):
            with self.subTest(mutation=mutation):
                with self.assertRaises(STATE.SupervisionError):
                    PROFILE.validate({**self.profile, **mutation}, STATE)

    def test_preview_shape_requires_loopback_health_and_workspace_match(self):
        preview = copy.deepcopy(PROFILE.DEFAULT["preview"])
        value = {**self.profile, "preview": preview}
        preview.update(workspace=self.profile["workspace"], root=str(self.directory / "preview"),
                       publication_state=str(self.directory / "control/published.json"),
                       unit_file=str(self.directory / "delta-preview.service"), service="delta-preview.service")
        self.assertEqual(PROFILE.validate(value, STATE)["preview"]["service"], "delta-preview.service")
        preview["health_url"] = "http://example.invalid:8077/api/session"
        with self.assertRaises(STATE.SupervisionError):
            PROFILE.validate(value, STATE)

    def test_command_identity_uses_profile_scope_without_granting_host_git(self):
        (self.directory / "workspace").mkdir()
        self.assertEqual(PROFILE.command_identity(["docker", "ps"], self.profile, STATE.SupervisionError), {})
        self.assertEqual(PROFILE.isolated_command(["docker", "ps"], self.profile, STATE.SupervisionError), ["docker", "ps"])
        with mock.patch.object(PROFILE.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(STATE.SupervisionError, "git_requires_actor_isolation"):
                PROFILE.isolated_command(["git", "-C", self.profile["workspace"], "status"], self.profile, STATE.SupervisionError)
        with mock.patch.object(PROFILE.os, "geteuid", return_value=0):
            isolated = PROFILE.isolated_command(["git", "-C", self.profile["workspace"], "status"],
                                                self.profile, STATE.SupervisionError)
        self.assertIn("delta-engineer-1", isolated)
        self.assertIn("/srv/delta/project", isolated)
        self.assertIn("1000:1000", isolated)


if __name__ == "__main__":
    unittest.main()
