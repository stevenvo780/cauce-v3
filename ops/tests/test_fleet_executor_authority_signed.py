from __future__ import annotations

import hashlib
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_authority as authority
from fleet_executor_policy import SafeFailure
from host_channel_client import ensure_key, save_private


class SignedAuthorityPolicyTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='signed-authority-policy-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        self.identity = self.root / 'identity'
        self.identity.mkdir(mode=0o700)
        public = ensure_key(self.identity)
        save_private(self.identity / 'identity.json', {'enrollment_id': '51000000-0000-4000-8000-000000000001',
            'company_id': 'fixture-company', 'host_id': 'fixture-host', 'gateway': 'https://fixture.invalid',
            'state': 'enrolled', 'key_fingerprint': hashlib.sha256(public).hexdigest(), 'executor_ready': False})
        self.ca = self.root / 'ca-public.crt'
        self.ca.write_text('PUBLIC_CA_FIXTURE')
        self.configuration = {'identity_directory': str(self.identity), 'host_id': 'fixture-host', 'ca_certificate': str(self.ca)}

    def tearDown(self):
        self.temporary.cleanup()

    def test_enrolled_identity_selects_signed_transport_without_a_socket_or_local_signer(self):
        self.assertEqual(authority.validate_authority(self.configuration, 'fixture-host'), self.configuration)

    def test_private_identity_modes_host_and_fingerprint_are_required_without_fallback(self):
        for filename in ('identity.json', 'private.pem'):
            os.chmod(self.identity / filename, 0o644)
            with self.assertRaises(SafeFailure):
                authority.validate_authority(self.configuration, 'fixture-host')
            os.chmod(self.identity / filename, 0o600)
        with self.assertRaises(SafeFailure):
            authority.validate_authority({**self.configuration, 'host_id': 'other-host'}, 'fixture-host')
        save_private(self.identity / 'identity.json', {'state': 'revoked'})
        with self.assertRaises(SafeFailure):
            authority.validate_authority(self.configuration, 'fixture-host')


if __name__ == '__main__':
    unittest.main()
