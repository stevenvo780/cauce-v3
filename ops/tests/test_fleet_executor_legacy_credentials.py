from __future__ import annotations

import copy
import hashlib
import http.server
import json
import pathlib
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fleet_executor_legacy_credentials as legacy_credentials
import fleet_provider_revoke as revoke
import test_fleet_executor as physical_fixtures
import test_fleet_executor_credentials as fixtures
from fleet_executor_legacy_credentials import capture_absence, remove_base_principals, validate_legacy_credentials
from fleet_executor_policy import SafeFailure
from fleet_executor_retirement import credential_references, remove_registry_principals

OPS = pathlib.Path(__file__).resolve().parents[1]


class LegacyCredentialRevocationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary_ca = tempfile.TemporaryDirectory(prefix='cauce-legacy-revoke-ca-', dir='/var/tmp')
        cls.ca_root = pathlib.Path(cls.temporary_ca.name)
        cls.ca, cls.ca_key = cls.ca_root / 'ca.crt', cls.ca_root / 'ca.key'
        cls.openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', cls.ca_key,
            '-out', cls.ca, '-subj', '/CN=disposable-legacy-ca', '-addext', 'basicConstraints=critical,CA:TRUE',
            '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
        cls.server_cert, cls.server_key = cls.issue_pair('server', 'serverAuth', 'IP:127.0.0.1')
        cls.pairs = {name: cls.issue_pair(name, 'clientAuth', 'URI:urn:cauce:legacy:' + name)
            for name in ('old-a', 'old-b', 'new-a', 'new-b')}

    @classmethod
    def tearDownClass(cls):
        cls.temporary_ca.cleanup()

    @classmethod
    def openssl(cls, *arguments):
        subprocess.run(['openssl', *map(str, arguments)], capture_output=True, check=True)

    @classmethod
    def issue_pair(cls, name, purpose, san):
        certificate, private, csr = [cls.ca_root / (name + suffix) for suffix in ('.crt', '.key', '.csr')]
        cls.openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', private, '-out', csr, '-subj', '/CN=' + name)
        extension = cls.ca_root / (name + '.ext')
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
            'extendedKeyUsage=' + purpose + '\nsubjectAltName=' + san + '\n')
        cls.openssl('x509', '-req', '-in', csr, '-CA', cls.ca, '-CAkey', cls.ca_key, '-set_serial',
            str(len(list(cls.ca_root.iterdir()))), '-days', '1', '-extfile', extension, '-out', certificate)
        private.chmod(0o400)
        return certificate, private

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-legacy-revoke-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        self.roots = {key: str(self.root / key) for key in ('identities', 'pki', 'tokens')}
        self.base = self.root / 'base'
        for directory in [self.base, *map(pathlib.Path, self.roots.values())]:
            directory.mkdir(mode=0o700)
        self.agent = {'tenant_id': 'Equipo_42', 'alias': 'legacy_a', 'runtime_key': 'physical-a', 'fleet_baseline': True}
        self.other = {**self.agent, 'alias': 'legacy_b', 'runtime_key': 'physical-b'}
        self.references = {}
        self.records = {}
        for namespace in ('old', 'new'):
            directory = self.base if namespace == 'old' else pathlib.Path(self.roots['identities'])
            records = {'mtls': [], 'token': []}
            for key, agent in (('a', self.agent), ('b', self.other)):
                label = namespace + '-' + key
                certificate, private = self.pairs[label]
                fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate.read_text())).hexdigest()
                token = self.root / (label + '.token')
                token.write_text(hashlib.sha256(label.encode()).hexdigest() + '\n')
                token.chmod(0o400)
                token_hash = hashlib.sha256(token.read_bytes().strip()).hexdigest()
                principal = {**{field: agent[field] for field in ('tenant_id', 'alias')}, 'channel': 'adapter',
                    'session_id': 'adapter-' + (agent['alias'] if namespace == 'old' else agent['runtime_key']),
                    'roles': ['adapter'], 'permissions': ['route', 'read']}
                mtls = {'certificate_sha256': fingerprint, 'expires_at': '2099-01-01T00:00:00Z', 'principal': principal}
                bearer = {'token_sha256': token_hash, 'expires_at': mtls['expires_at'], 'principal': principal}
                records['mtls'].append(mtls)
                records['token'].append(bearer)
                self.references[label] = {'phase': 'normal', 'certificate_path': str(certificate), 'key_path': str(private),
                    'certificate_fingerprint': fingerprint, 'token_path': str(token), 'token_sha256': token_hash}
            self.records[namespace] = records
            for kind, filename in (('mtls', 'mtls_identities.json'), ('token', 'token_hashes.json')):
                location = directory / filename
                location.write_text(json.dumps({'version': 1, 'identities': records[kind]}))
                location.chmod(0o400)
        self.policy = {'roots': self.roots, 'legacy_credentials': {'physical-a': {'tenant_id': self.agent['tenant_id'],
            'alias': self.agent['alias'], 'expected_absent': False, 'credentials': [self.references['old-a']],
            'registries': [{'kind': kind, 'path': str(self.base / filename), 'entries': [self.records['old'][kind][0]]}
                for kind, filename in (('mtls', 'mtls_identities.json'), ('token', 'token_hashes.json'))]}}}
        self.probes = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                kind = 'token' if self.path.endswith('/token') else 'mtls'
                digest = hashlib.sha256(self.connection.getpeercert(binary_form=True)).hexdigest()
                if kind == 'token':
                    digest = hashlib.sha256(self.headers.get('authorization', '').removeprefix('Bearer ').encode()).hexdigest()
                field = 'token_sha256' if kind == 'token' else 'certificate_sha256'
                name = 'token_hashes.json' if kind == 'token' else 'mtls_identities.json'
                entries = [entry for directory in (owner.base, pathlib.Path(owner.roots['identities']))
                    for entry in json.loads((directory / name).read_text())['identities'] if entry.get(field) == digest]
                status = 200 if len(entries) == 1 else 401
                owner.probes.append((kind, digest, status))
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'credential_accepted': True} if status == 200 else {'error': 'CREDENTIAL_REJECTED'}).encode())

            def log_message(self, _format, *_arguments):
                return

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.server_cert, self.server_key)
        context.load_verify_locations(self.ca)
        context.verify_mode = ssl.CERT_REQUIRED
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.transport = {'gateway_url': 'https://127.0.0.1:' + str(self.server.server_port), 'ca_certificate': str(self.ca)}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def packet(self, references):
        return {'account_id': None, 'identity': 'cauce-runtime:physical-a', 'agent': self.agent,
            'cauce_credentials': references, 'transport': self.transport}

    def test_baseline_without_inventory_or_unknown_empty_references_fail_closed(self):
        for agent in (self.agent, {key: value for key, value in self.agent.items() if key != 'fleet_baseline'}):
            with self.assertRaises(SafeFailure):
                credential_references({'roots': self.roots}, agent)
        with self.assertRaises(ValueError):
            revoke.revoke(self.packet({'identities_directory': self.roots['identities'], 'credentials': {}, 'fleet_baseline': True}))
        self.assertEqual(self.probes, [])

    def test_real_tls_rejection_removes_a_exactly_and_preserves_b_in_base_and_new(self):
        for namespace in ('old', 'new'):
            reference = self.references[namespace + '-a']
            context = ssl.create_default_context(cafile=str(self.ca))
            context.load_cert_chain(reference['certificate_path'], reference['key_path'])
            self.assertFalse(revoke.rejected(self.transport['gateway_url'], context, 'normal'))
            self.assertFalse(revoke.rejected(self.transport['gateway_url'], context, 'normal',
                pathlib.Path(reference['token_path']).read_text().strip()))
        self.assertEqual([status for _, _, status in self.probes], [200, 200, 200, 200])
        references = credential_references(self.policy, self.agent)
        references['credentials']['normal'] = {key: value for key, value in self.references['new-a'].items() if key != 'phase'}
        with self.assertRaises(SafeFailure):
            revoke.revoke(self.packet(references))
        remove_registry_principals(self.policy, self.agent, fixtures.load_script)
        self.assertEqual(revoke.revoke(self.packet(references)), {'revocation_verified': True})
        self.assertEqual([status for _, _, status in self.probes[4:]], [401, 401, 401, 401])
        for namespace, directory in (('old', self.base), ('new', pathlib.Path(self.roots['identities']))):
            for kind, filename in (('mtls', 'mtls_identities.json'), ('token', 'token_hashes.json')):
                self.assertEqual(json.loads((directory / filename).read_text())['identities'], [self.records[namespace][kind][1]])
            reference = self.references[namespace + '-b']
            context = ssl.create_default_context(cafile=str(self.ca))
            context.load_cert_chain(reference['certificate_path'], reference['key_path'])
            self.assertFalse(revoke.rejected(self.transport['gateway_url'], context, 'normal'))
            self.assertFalse(revoke.rejected(self.transport['gateway_url'], context, 'normal',
                pathlib.Path(reference['token_path']).read_text().strip()))
        self.assertEqual([status for _, _, status in self.probes[8:]], [200, 200, 200, 200])
        self.assertTrue(pathlib.Path(self.references['old-a']['key_path']).exists())
        remove_base_principals(self.policy, self.agent)
        self.assertEqual(revoke.revoke(self.packet(references)), {'revocation_verified': True})

    def test_changed_record_or_new_unknown_a_fingerprint_preserves_all_records(self):
        for mutation in ('principal', 'fingerprint', 'duplicate'):
            changed = copy.deepcopy(self.records['old']['token'])
            if mutation == 'principal':
                changed[0]['principal']['session_id'] = 'adapter-another'
            elif mutation == 'fingerprint':
                changed[0]['token_sha256'] = 'f' * 64
            else:
                changed.append(copy.deepcopy(changed[0]))
            filename = self.base / 'token_hashes.json'
            filename.chmod(0o600)
            filename.write_text(json.dumps({'version': 1, 'identities': changed}))
            filename.chmod(0o400)
            before = {name: (self.base / name).read_bytes() for name in ('mtls_identities.json', 'token_hashes.json')}
            with self.assertRaises(SafeFailure):
                remove_base_principals(self.policy, self.agent)
            self.assertEqual(before, {name: (self.base / name).read_bytes() for name in before})

    def test_explicit_absence_is_observed_against_base_and_new_authorities(self):
        legacy = self.policy['legacy_credentials']['physical-a']
        legacy.update(expected_absent=True, credentials=[])
        for registry in legacy['registries']:
            registry['entries'] = []
        validate_legacy_credentials(self.policy)
        references = credential_references(self.policy, self.agent)
        with self.assertRaises(SafeFailure):
            remove_base_principals(self.policy, self.agent)
        for directory, namespace in ((self.base, 'old'), (pathlib.Path(self.roots['identities']), 'new')):
            for kind, filename in (('mtls', 'mtls_identities.json'), ('token', 'token_hashes.json')):
                location = directory / filename
                location.chmod(0o600)
                location.write_text(json.dumps({'version': 1, 'identities': [self.records[namespace][kind][1]]}))
                location.chmod(0o400)
        self.assertEqual(revoke.revoke(self.packet(references)), {'revocation_verified': True})
        self.assertEqual(self.probes, [])
        absence = capture_absence(references, self.agent)
        self.assertEqual(len(absence), 4)
        for observation in absence:
            self.assertEqual(observation['sha256'], hashlib.sha256(pathlib.Path(observation['path']).read_bytes()).hexdigest())
        (self.base / 'token_hashes.json').unlink()
        with self.assertRaises(FileNotFoundError):
            revoke.revoke(self.packet(references))

    def test_changed_raw_fingerprint_or_missing_pin_fails_before_registry_changes(self):
        for mutate in ('fingerprint', 'principal', 'missing_token'):
            policy = copy.deepcopy(self.policy)
            legacy = policy['legacy_credentials']['physical-a']
            if mutate == 'fingerprint':
                legacy['credentials'][0]['certificate_fingerprint'] = 'a' * 64
            elif mutate == 'principal':
                legacy['registries'][0]['entries'][0]['principal']['tenant_id'] = 'Other'
            else:
                legacy['registries'][1]['entries'] = []
            with self.assertRaises(SafeFailure):
                remove_base_principals(policy, self.agent)
        with patch('fleet_executor_legacy_credentials.publish_json_document_cas', side_effect=SafeFailure('CAS changed')):
            with self.assertRaises(SafeFailure):
                remove_base_principals(self.policy, self.agent)
        self.assertEqual(json.loads((self.base / 'mtls_identities.json').read_text())['identities'], self.records['old']['mtls'])

    def test_noncooperative_registry_write_is_rejected_by_real_cas(self):
        publish = legacy_credentials.publish_json_document_cas

        def changed_before_publish(parent, lock, filename, document, original, **options):
            location = self.base / filename
            location.chmod(0o600)
            location.write_text(location.read_text() + '\n')
            location.chmod(0o400)
            publish(parent, lock, filename, document, original, **options)

        with patch.object(legacy_credentials, 'publish_json_document_cas', side_effect=changed_before_publish):
            with self.assertRaises(SafeFailure):
                remove_base_principals(self.policy, self.agent)
        for kind, filename in (('mtls', 'mtls_identities.json'), ('token', 'token_hashes.json')):
            self.assertEqual(json.loads((self.base / filename).read_text())['identities'], self.records['old'][kind])

    def test_unsafe_parent_and_inconsistent_baseline_fail_before_retirement(self):
        self.base.chmod(0o770)
        with self.assertRaises(SafeFailure):
            remove_base_principals(self.policy, self.agent)
        self.base.chmod(0o700)
        references = credential_references(self.policy, self.agent)
        references['fleet_baseline'] = False
        with self.assertRaisesRegex(ValueError, 'baseline authority differs'):
            revoke.revoke(self.packet(references))


class EmptyCompensationAuthorityTest(unittest.TestCase):
    setUp = physical_fixtures.PhysicalExecutorTest.setUp
    tearDown = physical_fixtures.PhysicalExecutorTest.tearDown
    run_step = physical_fixtures.PhysicalExecutorTest.run_step
    save_policy = physical_fixtures.PhysicalExecutorTest.save_policy

    def test_unknown_empty_compensation_does_not_report_revocation(self):
        self.agent.pop('fleet_baseline')
        result = self.run_step('compensate')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('revocation_verified', result.stdout)

    def test_new_reserved_identity_can_compensate_no_created_credentials(self):
        result = self.run_step('compensate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['evidence'], {'stopped_verified': True, 'revocation_verified': True})


if __name__ == '__main__':
    unittest.main()
