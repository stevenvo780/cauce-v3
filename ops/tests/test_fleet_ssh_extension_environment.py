from __future__ import annotations

import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

CLI = pathlib.Path(__file__).resolve().parents[1] / "cli"
sys.path.insert(0, str(CLI))
import fleet_executor_runtime as runtime  # noqa: E402
import fleet_provider_identity as identity  # noqa: E402


class SshExtensionEnvironmentTest(unittest.TestCase):
    def test_prepare_ssh_writes_private_config_and_known_hosts(self):
        with tempfile.TemporaryDirectory() as raw:
            profile = pathlib.Path(raw)
            receipt = identity.prepare_ssh(profile, ["ops@example.test"])
            directory = profile / "ssh"
            self.assertEqual(set(receipt), {"fingerprint", "public_key", "hosts"})
            config = (directory / "config").read_text()
            self.assertEqual(config, (
                "Host *\n"
                f"  IdentityFile {directory}/id_ed25519\n"
                "  IdentitiesOnly yes\n"
                f"  UserKnownHostsFile {directory}/known_hosts\n"
                "  StrictHostKeyChecking accept-new\n"))
            for name in ("config", "known_hosts", "id_ed25519"):
                self.assertEqual(stat.S_IMODE((directory / name).lstat().st_mode), 0o600, name)
            (directory / "known_hosts").write_text("kept\n")
            identity.prepare_ssh(profile, ["ops@example.test"])
            self.assertEqual((directory / "known_hosts").read_text(), "kept\n")
            self.assertEqual(len([p for p in directory.iterdir() if p.name.endswith(".tmp")]), 0)

    def test_prepare_ssh_refuses_symlinked_known_hosts(self):
        with tempfile.TemporaryDirectory() as raw:
            profile = pathlib.Path(raw)
            (profile / "ssh").mkdir()
            os.symlink("/nonexistent-target", profile / "ssh" / "known_hosts")
            with self.assertRaises(identity.ProviderProofError):
                identity.prepare_ssh(profile, ["ops@example.test"])

    def test_environment_only_with_ssh_extension(self):
        with_ssh = {"extensions": [{"type": "ssh", "hosts": ["ops@example.test"]}]}
        values = identity.ssh_environment(with_ssh, "/profiles/a/h")
        self.assertEqual(values, {"CAUCE_SSH_CONFIG": "/profiles/a/h/ssh/config",
                                  "GIT_SSH_COMMAND": "ssh -F /profiles/a/h/ssh/config"})
        self.assertEqual(identity.ssh_environment({"extensions": []}, "/profiles/a/h"), {})
        self.assertEqual(identity.ssh_environment({}, "/profiles/a/h"), {})

    def test_provider_environment_carries_ssh_variables(self):
        agent = {"extensions": [{"type": "ssh", "hosts": ["ops@example.test"]}]}
        with patch.object(runtime, "provider_base_environment", return_value={"OPENCLAW_HOME": "/x"}), \
                patch("fleet_executor_templates.resolve_profile", return_value={"path": "/home/node/.cauce-profiles/a/h"}), \
                patch.object(runtime, "path", side_effect=lambda value: pathlib.Path(value)):
            values = runtime.provider_environment({}, agent)
        self.assertEqual(values["CAUCE_SSH_CONFIG"], "/home/node/.cauce-profiles/a/h/ssh/config")
        self.assertEqual(values["GIT_SSH_COMMAND"], "ssh -F /home/node/.cauce-profiles/a/h/ssh/config")
        self.assertEqual(values["OPENCLAW_HOME"], "/x")


if __name__ == "__main__":
    unittest.main()
