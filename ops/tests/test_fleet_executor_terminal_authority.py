from __future__ import annotations

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor_authority as authority_fixture
from test_fleet_authority_issuer import FleetAuthorityIssuerTest, issuer


class TerminalAuthorityTest(unittest.TestCase):
    setUpClass = classmethod(FleetAuthorityIssuerTest.setUpClass.__func__)
    tearDownClass = classmethod(FleetAuthorityIssuerTest.tearDownClass.__func__)
    execute = staticmethod(FleetAuthorityIssuerTest.execute)
    setUp = FleetAuthorityIssuerTest.setUp
    tearDown = FleetAuthorityIssuerTest.tearDown
    packet = FleetAuthorityIssuerTest.packet

    def configure_terminal(self):
        directory = self.root / 'pty'
        directory.mkdir(mode=0o700)
        location = directory / 'pty_agent_identities.json'
        self.target = {**self.agent, 'fingerprint_sha256': 'A' * 64, 'expires_at': '2099-01-01T00:00:00Z'}
        self.foreign = {**self.agent, 'tenant_id': 'Other', 'fingerprint_sha256': 'B' * 64,
                        'expires_at': '2099-01-01T00:00:00Z'}
        location.write_text(json.dumps({'version': 1, 'agents': [self.target, self.foreign]}))
        location.chmod(0o600)
        self.registries['pty'] = str(location)
        return location

    def test_terminal_revoke_is_resumable_and_preserves_same_alias_in_another_tenant(self):
        location = self.configure_terminal()
        observed = issuer.perform(self.policy, self.packet('inventory'))
        self.assertEqual(observed['authorities'][-1]['matching_records'], [self.target])
        pins = [{key: row[key] for key in ('id', 'sha256')} for row in observed['authorities']]
        request = self.packet('revoke', expected_inventory=pins)
        first = issuer.perform(self.policy, request)
        self.assertEqual(first, issuer.perform(self.policy, request))
        self.assertEqual(first['authorities'][-1]['matching_records'], [])
        self.assertEqual(json.loads(location.read_text())['agents'], [self.foreign])
        self.assertEqual(issuer.perform(self.policy, self.packet('verify_absent')), first)

    def test_relocation_preserves_terminal_and_cannot_change_preservation_on_replay(self):
        location = self.configure_terminal()
        observed = issuer.perform(self.policy, self.packet('inventory', preserve_terminal=True))
        self.assertTrue(observed['authorities'][-1]['preserved'])
        pins = [{key: row[key] for key in ('id', 'sha256')} for row in observed['authorities']]
        issuer.perform(self.policy, self.packet('revoke', expected_inventory=pins, preserve_terminal=True))
        self.assertEqual(json.loads(location.read_text())['agents'], [self.target, self.foreign])
        with self.assertRaises(issuer.AuthorityError):
            issuer.perform(self.policy, self.packet('revoke', expected_inventory=pins))

    def test_terminal_inventory_rejects_fingerprint_shared_with_foreign_identity(self):
        location = self.configure_terminal()
        self.foreign['fingerprint_sha256'] = self.target['fingerprint_sha256'].lower()
        location.write_text(json.dumps({'version': 1, 'agents': [self.target, self.foreign]}))
        with self.assertRaises(issuer.AuthorityError):
            issuer.perform(self.policy, self.packet('inventory'))


class TerminalRequiredAuthorityTest(unittest.TestCase):
    setUpClass = classmethod(authority_fixture.CentralAuthorityAdapterTest.setUpClass.__func__)
    tearDownClass = classmethod(authority_fixture.CentralAuthorityAdapterTest.tearDownClass.__func__)
    setUp = authority_fixture.CentralAuthorityAdapterTest.setUp
    tearDown = authority_fixture.CentralAuthorityAdapterTest.tearDown

    def test_purge_without_terminal_authority_does_not_prepare_or_revoke(self):
        self.registries.pop('pty')
        journal = {}
        with self.assertRaisesRegex(authority_fixture.SafeFailure, 'requires the configured terminal relay authority'):
            authority_fixture.adapter.revoke(self.policy, {**self.context, 'request': {'kind': 'purge'}},
                                             self.agent, journal, lambda: None)
        self.assertEqual(journal, {})
        self.assertEqual(list((self.root / 'central').glob('*.json')), [])


if __name__ == '__main__':
    unittest.main()
