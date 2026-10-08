from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), OPS / 'scripts' / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BootstrapCredentialsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fleet-bootstrap-credentials-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        self.tokens, self.identities, self.pki = [self.root / name for name in ('tokens', 'identities', 'pki')]
        for directory in (self.tokens, self.identities, self.pki):
            directory.mkdir(mode=0o700)
        self.snapshot = self.root / 'snapshot.json'
        self.snapshot.write_text(json.dumps({'fleet': {}, 'bootstrap': {'physical-one': {
            'tenant': 'Equipo_42', 'alias': 'shared_alias', 'enabled': False, 'admission': False,
            'lifecycleState': 'provisioning'}}}))
        self.issue = load_script('issue-alias-token.py')
        self.register = load_script('register-agent-identity.py')

    def tearDown(self):
        self.temporary.cleanup()

    def token_cli(self):
        return subprocess.run([sys.executable, str(OPS / 'scripts/issue-alias-token.py'),
            '--alias', 'physical-one', '--tokens-dir', str(self.tokens), '--identities-dir', str(self.identities),
            '--flota-json', str(self.snapshot), '--bootstrap', '--idempotent'], capture_output=True, text=True)

    def test_bootstrap_token_uses_physical_file_and_exact_wire_principal_without_route(self):
        first = self.token_cli()
        self.assertEqual(first.returncode, 0, first.stderr)
        token = self.tokens / 'physical-one.token'
        before = token.stat().st_ino
        record = json.loads((self.identities / 'token_hashes.json').read_bytes())['identities'][0]
        self.assertEqual(record['principal'], {'tenant_id': 'Equipo_42', 'alias': 'shared_alias',
            'session_id': 'bootstrap-physical-one', 'channel': 'bootstrap', 'roles': [], 'permissions': []})
        self.assertEqual(record['token_sha256'], hashlib.sha256(token.read_text().strip().encode()).hexdigest())
        second = self.token_cli()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(token.stat().st_ino, before)
        self.assertEqual(len(json.loads((self.identities / 'token_hashes.json').read_bytes())['identities']), 1)

    def test_crash_token_without_registry_is_reused_and_wrong_principal_rejected(self):
        token = self.tokens / 'physical-one.token'
        token.write_text('a' * 64 + '\n')
        token.chmod(0o400)
        before = token.stat().st_ino
        replay = self.token_cli()
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(token.stat().st_ino, before)
        registry = self.identities / 'token_hashes.json'
        data = json.loads(registry.read_bytes())
        data['identities'][0]['principal']['tenant_id'] = 'Other'
        registry.chmod(0o600)
        registry.write_text(json.dumps(data))
        registry.chmod(0o400)
        conflict = self.token_cli()
        self.assertNotEqual(conflict.returncode, 0)
        self.assertEqual(token.stat().st_ino, before)
        self.assertEqual(json.loads(registry.read_bytes()), data)

    def test_exact_certificate_fingerprint_does_not_authorize_another_principal(self):
        self.snapshot.write_text(json.dumps({'fleet': {'physical-one': {'tenant': 'Equipo_42', 'enabled': True}}}))
        cert = self.pki / 'agent-physical-one.crt'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', str(self.root / 'throwaway.key'), '-out', str(cert), '-subj', '/CN=agent-physical-one'],
            capture_output=True, check=True)
        cert.chmod(0o444)
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
        registry = self.identities / 'mtls_identities.json'
        record = {'certificate_sha256': fingerprint, 'expires_at': '2030-01-01T00:00:00Z',
            'principal': {'tenant_id': 'Other', 'alias': 'shared_alias', 'channel': 'adapter',
                'session_id': 'adapter-shared_alias', 'roles': ['adapter'], 'permissions': ['route', 'read']}}
        registry.write_text(json.dumps({'version': 1, 'identities': [record]}))
        registry.chmod(0o400)
        with self.assertRaises(self.register.RegisterIdentityError):
            self.register.register('physical-one', self.pki, self.identities, self.snapshot, 1)

    def test_exact_certificate_replay_rejects_expired_or_duplicate_registry_record(self):
        self.snapshot.write_text(json.dumps({'fleet': {'physical-one': {'tenant': 'Equipo_42', 'enabled': True}}}))
        cert = self.pki / 'agent-physical-one.crt'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
            '-keyout', str(self.root / 'throwaway.key'), '-out', str(cert), '-subj', '/CN=agent-physical-one'],
            capture_output=True, check=True)
        cert.chmod(0o444)
        self.register.register('physical-one', self.pki, self.identities, self.snapshot, 1)
        registry = self.identities / 'mtls_identities.json'
        original = json.loads(registry.read_bytes())
        for mutation in ('expired', 'duplicate'):
            document = json.loads(json.dumps(original))
            if mutation == 'expired':
                document['identities'][0]['expires_at'] = '2000-01-01T00:00:00Z'
            else:
                document['identities'].append(document['identities'][0].copy())
            registry.chmod(0o600)
            registry.write_text(json.dumps(document))
            registry.chmod(0o400)
            with self.assertRaises(self.register.RegisterIdentityError):
                self.register.register('physical-one', self.pki, self.identities, self.snapshot, 1)


if __name__ == '__main__':
    unittest.main()

class BootstrapCertificateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='fleet-bootstrap-ca-', dir='/var/tmp')
        cls.root = pathlib.Path(cls.temporary.name)
        cls.ca, cls.key = cls.root / 'ca.crt', cls.root / 'ca.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
            '-keyout', str(cls.key), '-out', str(cls.ca), '-subj', '/CN=disposable-bootstrap-ca',
            '-addext', 'basicConstraints=critical,CA:TRUE'], capture_output=True, check=True)
        cls.key.chmod(0o400)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fleet-bootstrap-pair-', dir='/var/tmp')
        self.path = pathlib.Path(self.temp.name)
        self.snapshot = self.path / 'snapshot.json'
        self.snapshot.write_text(json.dumps({'fleet': {}, 'bootstrap': {'physical-one': {
            'tenant': 'Equipo_42', 'alias': 'shared_alias', 'enabled': False, 'admission': False,
            'lifecycleState': 'provisioning', 'room': 'room: one'}}}))
        self.manifest = self.path / 'manifest.yaml'
        self.manifest.write_text('metadata:\n  name: physical-one\nspec:\n  tenant: Equipo_42\n  alias: shared_alias\n  room: "room: one"\n  bootstrap: true\n  admission: false\n')
        self.output = self.path / 'pki'
        self.output.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def provision(self):
        return subprocess.run(['bash', str(OPS / 'scripts/provision-agent-identity.sh'),
            '--bootstrap-manifest', str(self.manifest), '--snapshot', str(self.snapshot),
            'physical-one', str(self.output)], capture_output=True, text=True,
            env={**os.environ, 'CAUCE_CLIENT_CA_CERT': str(self.ca), 'CAUCE_CLIENT_CA_KEY': str(self.key),
                 'PATH': f'{pathlib.Path(sys.executable).parent}:' + os.environ['PATH']})

    def test_bootstrap_pair_is_atomic_replayable_and_physical_in_san(self):
        first = self.provision()
        self.assertEqual(first.returncode, 0, first.stderr)
        pair = self.output / 'physical-one'
        certificate = pair / 'agent-physical-one.crt'
        private = pair / 'agent-physical-one.key'
        self.assertTrue(private.exists())
        before = private.stat().st_ino
        description = subprocess.run(['openssl', 'x509', '-in', str(certificate), '-noout', '-ext', 'subjectAltName'],
            capture_output=True, text=True, check=True).stdout
        self.assertIn('URI:urn:cauce:runtime:physical-one', description)
        second = self.provision()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(private.stat().st_ino, before)
        self.assertNotIn(private.read_text(), first.stdout + first.stderr)

    def test_wrong_manifest_identity_cannot_issue_bootstrap_pair(self):
        self.manifest.write_text(self.manifest.read_text().replace('Equipo_42', 'Other'))
        result = self.provision()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.output / 'physical-one').exists())
