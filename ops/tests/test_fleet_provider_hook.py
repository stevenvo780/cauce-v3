from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch

CLI = pathlib.Path(__file__).resolve().parents[1] / "cli"
sys.path.insert(0, str(CLI))
sys.path.insert(0, str(CLI.parent / "scripts"))
import fleet_provider_identity as identity  # noqa: E402
import fleet_provider_probe as probe  # noqa: E402
import fleet_provider_revoke as revoke  # noqa: E402
from fleet_executor_registry import publish_gateway_registry  # noqa: E402

SPEC = importlib.util.spec_from_file_location("fleet_provider_hook", CLI / "fleet-provider-hook.py")
hook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hook)

SCRIPT = """#!/usr/bin/python3
import json,sys
if 'app-server' in sys.argv:
 for line in sys.stdin:
  value=json.loads(line)
  if value.get('id')==1: print(json.dumps({'id':1,'result':{}}),flush=True)
  if value.get('id')==2: print(json.dumps({'id':2,'result':{'account':{'type':'chatgpt','email':'approved@test.invalid'}}}),flush=True)
else:
 prompt=sys.argv[-1]
 marker=prompt.split('únicamente ',1)[1].split('.',1)[0]
 print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':marker}}))
"""


class ProviderHookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fleet-provider-proof-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.command = self.root / "approved-provider"
        self.command.write_text(SCRIPT)
        self.command.chmod(0o700)
        self.packet = {
            "operation_id": "00000000-0000-4000-8000-000000000001",
            "step": "authenticate",
            "agent": {
                "tenant_id": "Steven",
                "alias": "proof",
                "runtime_key": "proof",
                "harness_id": "codex",
                "runtime_mode": "native",
                "runtime_user": "fixture",
                "home_directory": str(self.root),
                "state_directory": str(self.root),
            },
            "account_id": "approved",
            "identity": "approved@test.invalid",
            "nonce": "a" * 64,
            "profile_binding": {
                "provider": "codex",
                "path": str(self.root),
                "identity": "approved@test.invalid",
                "runtime_user": "fixture",
                "command": str(self.command),
                "command_sha256": hashlib.sha256(self.command.read_bytes()).hexdigest(),
            },
        }

    def test_absolute_pinned_provider_identity_and_real_process_nonce(self):
        with patch.dict("os.environ", {"PATH": "/usr/bin:/bin"}):
            self.assertTrue(identity.authenticated_provider(self.packet))

    def test_wrong_account_fails_before_functional_call(self):
        self.packet["identity"] = "different@test.invalid"
        with patch.object(identity, "command_output", side_effect=AssertionError("no functional call allowed")):
            self.assertFalse(identity.authenticated_provider(self.packet))

    def test_changed_provider_executable_does_not_authenticate(self):
        self.command.write_text(SCRIPT + '\nprint("changed")\n')
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_missing_pin_and_raw_code_zero_are_not_provider_proof(self):
        self.packet["profile_binding"].pop("command_sha256")
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_provider_pin_rejects_symlink_ancestor(self):
        link = self.root / "linked"
        link.symlink_to(self.root, target_is_directory=True)
        self.packet["profile_binding"]["command"] = str(link / self.command.name)
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_command_output_is_bounded_while_process_runs(self):
        with self.assertRaisesRegex(identity.ProviderProofError, "output exceeded"):
            identity.command_output(["/usr/bin/python3", "-c", "import os; os.write(1, b'x'*300000)"], self.packet)

    def test_command_timeout_stops_process_group(self):
        pid_file = self.root / "child-pid"
        script = "import subprocess,pathlib,time; p=subprocess.Popen(['/usr/bin/sleep','60']); pathlib.Path(__import__('sys').argv[1]).write_text(str(p.pid)); time.sleep(60)"
        with self.assertRaisesRegex(identity.ProviderProofError, "timed out"):
            identity.command_output(["/usr/bin/python3", "-c", script, str(pid_file)], self.packet, timeout=1)
        status = pathlib.Path("/proc") / pid_file.read_text() / "stat"
        self.assertTrue(not status.exists() or status.read_text().split(") ", 1)[1].startswith("Z "))

    def test_profile_ack_is_bound_to_exact_descriptor_and_measured_documents(self):
        self.packet["step"] = "profile"
        self.packet["transport"] = {
            "bootstrap_url": "https://fixture.invalid",
            "gateway_url": "https://fixture.invalid",
        }
        profile = {key: self.packet["agent"][key] for key in ("tenant_id", "alias", "runtime_key", "harness_id")}
        profile.update(
            operation_id=self.packet["operation_id"],
            phase="bootstrap",
            account_id="approved",
            model_id=None,
            profile_revision=1,
        )
        descriptor = {
            **profile,
            "action": "profile",
            "nonce": self.packet["nonce"],
            "probe_id": "fixture",
            "documents": [{"name": "AGENTS.md", "sha256": "b" * 64, "native_revision": None}],
        }
        proof = {
            **profile,
            "nonce": self.packet["nonce"],
            "documents": descriptor["documents"],
            "reply": None,
            "harness_started": False,
        }
        proof.pop("tenant_id")
        proof.pop("alias")
        receipt = {"probe": descriptor, "state": "succeeded", "proof": proof}
        with patch.object(probe, "credential_context"), patch.object(probe, "request", side_effect=[profile, receipt]):
            self.assertEqual(probe.probe(self.packet), {"profile_verified": True})
        receipt["proof"] = {**proof, "nonce": "c" * 64}
        with patch.object(probe, "credential_context"), patch.object(probe, "request", side_effect=[profile, receipt]):
            with self.assertRaisesRegex(probe.ProbeError, "proof changed"):
                probe.probe(self.packet)

    def test_unapproved_hook_identity_is_rejected(self):
        self.packet["profile_binding"]["runtime_user"] = "different"
        with self.assertRaisesRegex(ValueError, "identity changed"):
            hook.validate(self.packet)

    def test_only_specific_credential_rejection_counts_as_revocation(self):
        for status, body, expected in [
            (403, {"error": "forbidden"}, False),
            (401, {"error": "unauthorized"}, False),
            (503, {"error": "CREDENTIAL_PROBE_UNAVAILABLE"}, False),
            (200, {"credential_accepted": True}, False),
            (401, {"error": "CREDENTIAL_REJECTED"}, True),
        ]:
            with patch.object(revoke.http.client, "HTTPSConnection") as connection:
                response = connection.return_value.getresponse.return_value
                response.status = status
                response.read.return_value = json.dumps(body).encode()
                self.assertEqual(
                    revoke.rejected("https://fixture.invalid", ssl.create_default_context(), "bootstrap"), expected
                )
                self.assertEqual(connection.return_value.request.call_args.args[1], "/v3/bootstrap/credentials/mtls")
        with patch.object(revoke.http.client, "HTTPSConnection") as connection:
            connection.return_value.getresponse.side_effect = ssl.SSLError("certificate required")
            with self.assertRaises(ssl.SSLError):
                revoke.rejected("https://fixture.invalid", ssl.create_default_context(), "bootstrap")

    def test_registry_view_contains_only_digests_and_tracks_atomic_replacement(self):
        source, target = self.root / "private", self.root / "gateway"
        source.mkdir(mode=0o700)
        target.mkdir(mode=0o755)
        policy = {"roots": {"identities": str(source)}, "transport": {"registry_directory": str(target)}}
        entry = {
            "certificate_sha256": "a" * 64,
            "principal": {"tenant_id": "Steven", "alias": "proof"},
            "expires_at": "2099-01-01T00:00:00Z",
        }
        file = source / "mtls_identities.json"
        file.write_text(json.dumps({"version": 1, "identities": [entry]}))
        file.chmod(0o600)
        publish_gateway_registry(policy)
        first_inode = (target / file.name).stat().st_ino
        self.assertEqual(json.loads((target / file.name).read_text())["identities"], [entry])
        file.write_text(json.dumps({"version": 1, "identities": []}))
        publish_gateway_registry(policy)
        self.assertNotEqual((target / file.name).stat().st_ino, first_inode)
        self.assertEqual(json.loads((target / file.name).read_text())["identities"], [])

    def test_registry_view_rejects_raw_secrets_and_destination_symlinks(self):
        source, target = self.root / "private", self.root / "gateway"
        source.mkdir(mode=0o700)
        target.mkdir(mode=0o755)
        policy = {"roots": {"identities": str(source)}, "transport": {"registry_directory": str(target)}}
        file = source / "mtls_identities.json"
        file.write_text(json.dumps({"version": 1, "identities": [{"token": "PRIVATE_FIXTURE"}]}))
        file.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "digests and principals"):
            publish_gateway_registry(policy)
        file.write_text(json.dumps({"version": 1, "identities": []}))
        (target / file.name).symlink_to(file)
        with self.assertRaisesRegex(ValueError, "replaced"):
            publish_gateway_registry(policy)


if __name__ == "__main__":
    unittest.main()
