from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import ssl
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'cli' / 'fleet-authority-issuer.py'
spec = importlib.util.spec_from_file_location('fleet_authority_issuer', SOURCE)
issuer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(issuer)


class FleetAuthorityIssuerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signer = tempfile.TemporaryDirectory(prefix='cauce-authority-ca-', dir='/var/tmp')
        cls.ca = pathlib.Path(cls.signer.name)
        cls.execute('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=authority-fixture',
                    '-keyout', cls.ca / 'ca.key', '-out', cls.ca / 'ca.crt', '-addext', 'basicConstraints=critical,CA:TRUE')
        (cls.ca / 'ca.key').chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.signer.cleanup()

    @staticmethod
    def execute(*args):
        return subprocess.run(['/usr/bin/openssl', *map(str, args)], capture_output=True, check=True).stdout

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-authority-test-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.registries = {}
        for name in ('base_mtls', 'base_token', 'fleet_mtls', 'fleet_token'):
            directory = self.root / name
            directory.mkdir(mode=0o700)
            location = directory / ('mtls_identities.json' if name.endswith('mtls') else 'token_hashes.json')
            location.write_text(json.dumps({'version': 1, 'identities': []}))
            location.chmod(0o600)
            self.registries[name] = str(location)
        self.policy = {'version': 1, 'state_root': str(self.state), 'registries': self.registries,
                       'signer': {'certificate': str(self.ca / 'ca.crt'), 'key': str(self.ca / 'ca.key'),
                                  'certificate_sha256': hashlib.sha256((self.ca / 'ca.crt').read_bytes()).hexdigest(),
                                  'key_sha256': hashlib.sha256((self.ca / 'ca.key').read_bytes()).hexdigest()}}
        self.scope = {'operation_id': '71000000-0000-4000-8000-000000000001', 'host_id': 'host-a',
                      'scope_sha256': 'a' * 64, 'runtime_key': 'runtime-a'}
        self.agent = {'tenant_id': 'Steven', 'alias': 'agent_a'}
        self.other = {'tenant_id': 'Steven', 'alias': 'agent_b'}
        self.key, self.csr = self.root / 'worker.key', self.root / 'worker.csr'
        self.execute('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-runtime-a',
                     '-keyout', self.key, '-out', self.csr)

    def tearDown(self):
        self.temporary.cleanup()

    def packet(self, action, **extra):
        return {'action': action, 'scope': self.scope, 'agent': self.agent, **extra}

    def issue(self, **extra):
        csr = self.csr.read_text()
        request = self.packet('issue', phase='bootstrap', csr_pem=csr,
                              csr_sha256=hashlib.sha256(csr.encode()).hexdigest(), idempotency_key='fixture-issue')
        request.update(extra)
        return issuer.perform(self.policy, request)

    def test_canonical_csr_real_certificate_private_journal_and_lost_response(self):
        issued = self.issue()
        certificate = self.root / 'issued.crt'
        certificate.write_text(issued['certificate_pem'])
        self.execute('verify', '-purpose', 'sslclient', '-CAfile', self.ca / 'ca.crt', certificate)
        self.assertEqual(self.execute('x509', '-in', certificate, '-pubkey', '-noout'),
                         self.execute('pkey', '-in', self.key, '-pubout'))
        self.assertEqual(self.issue(), issued)
        self.assertEqual(hashlib.sha256(ssl.PEM_cert_to_DER_cert(issued['certificate_pem'])).hexdigest(),
                         issued['certificate_sha256'])
        self.assertEqual(hashlib.sha256(issued['token'].encode()).hexdigest(), issued['token_sha256'])
        for journal in self.state.glob('*.json'):
            self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
        self.assertFalse(any('PRIVATE KEY' in path.read_text() for path in self.state.glob('*.json')))

    def test_changed_csr_or_idempotency_conflicts_without_rotation(self):
        self.issue()
        with self.assertRaises(issuer.AuthorityError):
            self.issue(idempotency_key='different-request')
        self.execute('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-runtime-a',
                     '-keyout', self.root / 'different.key', '-out', self.csr)
        with self.assertRaises(issuer.AuthorityError):
            self.issue()

    def test_foreign_subject_or_requested_extension_is_rejected(self):
        for subject, extension in (('/CN=agent-runtime-b', []), ('/CN=agent-runtime-a', ['-addext', 'subjectAltName=DNS:foreign.example'])):
            self.execute('req', '-new', '-key', self.key, '-subj', subject, '-out', self.csr, *extension)
            with self.assertRaises(issuer.AuthorityError):
                self.issue()
        self.assertEqual(list(self.state.glob('*.json')), [])

    def test_inventory_cas_revoke_preserves_other_principal_and_observes_all_authorities(self):
        issued = self.issue()
        for name, location in self.registries.items():
            field = 'certificate_sha256' if name.endswith('mtls') else 'token_sha256'
            value = 'c' * 64
            document = json.loads(pathlib.Path(location).read_text())
            document['identities'].append({field: value, 'principal': {**self.other, 'session_id': 'adapter-b'}, 'expires_at': '2099-01-01T00:00:00Z'})
            pathlib.Path(location).write_text(json.dumps(document))
        inventory = issuer.perform(self.policy, self.packet('inventory'))
        expected = [{key: row[key] for key in ('id', 'sha256')} for row in inventory['authorities']]
        receipt = issuer.perform(self.policy, self.packet('revoke', expected_inventory=expected))
        self.assertTrue(all(not row['matching_records'] for row in receipt['authorities']))
        self.assertEqual(len(receipt['authorities']), 4)
        self.assertEqual(issuer.perform(self.policy, self.packet('revoke', expected_inventory=expected)), receipt)
        for location in self.registries.values():
            document = json.loads(pathlib.Path(location).read_text())
            self.assertEqual(len(document['identities']), 1)
            self.assertEqual(document['identities'][0]['principal']['alias'], 'agent_b')
        with self.assertRaises(issuer.AuthorityError):
            self.issue()
        self.assertTrue(issued['certificate_pem'])

    def test_live_base_record_is_inventoried_and_owner_policy_is_strict(self):
        document = {'version': 1, 'identities': [{'certificate_sha256': 'e' * 64, 'principal': {**self.agent, 'session_id': 'legacy'},
                                                  'expires_at': '2099-01-01T00:00:00Z'}]}
        pathlib.Path(self.registries['base_mtls']).write_text(json.dumps(document))
        observed = issuer.perform(self.policy, self.packet('inventory'))
        self.assertEqual(len(observed['authorities'][0]['matching_records']), 1)
        for invalid in (True, -1, '1000', 2 ** 32):
            with self.assertRaises(issuer.AuthorityError):
                issuer.perform({**self.policy, 'base_registry_owner_uid': invalid}, self.packet('inventory'))
        issuer.perform({**self.policy, 'base_registry_owner_uid': os.geteuid() + 1}, self.packet('inventory'))
        pathlib.Path(self.registries['base_mtls']).chmod(0o620)
        with self.assertRaises(issuer.AuthorityError):
            issuer.perform(self.policy, self.packet('inventory'))

    def test_policy_owner_mapping_separates_fleet_and_base_registries(self):
        euid = os.geteuid()
        for owner in (euid, euid + 1000):
            _, registries, owners = issuer.policy_paths({**self.policy, 'base_registry_owner_uid': owner})
            for name, location in registries.items():
                expected = frozenset({euid, owner}) if name.startswith('base_') else frozenset({euid})
                self.assertEqual(owners[location], expected, name)

    def test_revoke_on_read_only_base_registry_keeps_mode_and_ownership(self):
        location = pathlib.Path(self.registries['base_mtls'])
        document = {'version': 1, 'identities': [
            {'certificate_sha256': 'e' * 64, 'principal': {**self.agent, 'session_id': 'legacy'}, 'expires_at': '2099-01-01T00:00:00Z'},
            {'certificate_sha256': 'd' * 64, 'principal': {**self.other, 'session_id': 'adapter-b'}, 'expires_at': '2099-01-01T00:00:00Z'}]}
        location.write_text(json.dumps(document))
        location.chmod(0o400)
        before = location.stat()
        inventory = issuer.perform(self.policy, self.packet('inventory'))
        expected = [{key: row[key] for key in ('id', 'sha256')} for row in inventory['authorities']]
        with mock.patch.object(issuer.os, 'fchown', wraps=os.fchown) as fchown:
            issuer.perform(self.policy, self.packet('revoke', expected_inventory=expected))
        self.assertTrue(fchown.called)
        for call in fchown.call_args_list:
            self.assertEqual(call.args[1:], (before.st_uid, before.st_gid))
        after = location.stat()
        self.assertEqual((stat.S_IMODE(after.st_mode), after.st_uid, after.st_gid), (0o400, before.st_uid, before.st_gid))
        remaining = json.loads(location.read_text())['identities']
        self.assertEqual([row['principal']['alias'] for row in remaining], ['agent_b'])

    def test_stale_inventory_or_reappearing_credentials_does_not_credit_absence(self):
        self.issue()
        inventory = issuer.perform(self.policy, self.packet('inventory'))
        expected = [{key: row[key] for key in ('id', 'sha256')} for row in inventory['authorities']]
        location = pathlib.Path(self.registries['base_mtls'])
        location.write_text(location.read_text() + '\n')
        before = {name: pathlib.Path(path).read_bytes() for name, path in self.registries.items()}
        with self.assertRaises(issuer.AuthorityError):
            issuer.perform(self.policy, self.packet('revoke', expected_inventory=expected))
        self.assertEqual(before, {name: pathlib.Path(path).read_bytes() for name, path in self.registries.items()})
        with self.assertRaises(issuer.AuthorityError):
            issuer.perform(self.policy, self.packet('verify_absent'))

    def test_reappearing_target_is_preserved_and_refused_after_completed_revocation(self):
        self.issue()
        inventory = issuer.perform(self.policy, self.packet('inventory'))
        expected = [{key: row[key] for key in ('id', 'sha256')} for row in inventory['authorities']]
        issuer.perform(self.policy, self.packet('revoke', expected_inventory=expected))
        location = pathlib.Path(self.registries['fleet_mtls'])
        location.write_text(json.dumps({'version': 1, 'identities': inventory['authorities'][2]['matching_records']}))
        before = location.read_bytes()
        with self.assertRaises(issuer.AuthorityError):
            issuer.perform(self.policy, self.packet('revoke', expected_inventory=expected))
        self.assertEqual(location.read_bytes(), before)

    def test_issued_registry_removal_and_changed_signer_do_not_reissue(self):
        self.issue()
        location = pathlib.Path(self.registries['fleet_mtls'])
        location.write_text(json.dumps({'version': 1, 'identities': []}))
        with self.assertRaises(issuer.AuthorityError):
            self.issue()
        self.policy['signer']['key_sha256'] = '0' * 64
        self.scope = {**self.scope, 'operation_id': '71000000-0000-4000-8000-000000000002'}
        with self.assertRaises(issuer.AuthorityError):
            self.issue()

    def test_missing_or_symlink_authority_does_not_return_empty_success(self):
        location = pathlib.Path(self.registries['base_token'])
        location.unlink()
        with self.assertRaises((issuer.AuthorityError, OSError)):
            issuer.perform(self.policy, self.packet('verify_absent'))
        location.symlink_to(self.registries['fleet_token'])
        with self.assertRaises((issuer.AuthorityError, OSError)):
            issuer.perform(self.policy, self.packet('inventory'))


if __name__ == '__main__':
    unittest.main()
