from __future__ import annotations

import base64
import copy
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
import fleet_executor_authority as adapter  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402


class CentralAuthorityAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('fixture_central_issuer', OPS / 'cli/fleet-authority-issuer.py')
        cls.issuer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.issuer)
        cls.ca_directory = tempfile.TemporaryDirectory(prefix='central-adapter-ca-', dir='/var/tmp')
        root = pathlib.Path(cls.ca_directory.name)
        cls.ca, cls.ca_key = root / 'ca.crt', root / 'ca.key'
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
            '-keyout', str(cls.ca_key), '-out', str(cls.ca), '-subj', '/CN=central-adapter-fixture',
            '-addext', 'basicConstraints=critical,CA:TRUE'], check=True, capture_output=True)
        cls.ca_key.chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.ca_directory.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='central-adapter-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        roots = {}
        for name in ('state', 'runtime', 'pki', 'tokens', 'identities', 'central'):
            directory = self.root / name
            directory.mkdir(mode=0o700)
            roots[name] = str(directory)
        self.registries = {}
        for name in adapter.AUTHORITIES:
            directory = self.root / name
            directory.mkdir(mode=0o700)
            filename = directory / ('mtls_identities.json' if name.endswith('mtls') else 'token_hashes.json')
            filename.write_text(json.dumps({'version': 1, 'identities': []}))
            filename.chmod(0o600)
            self.registries[name] = str(filename)
        self.central = {'version': 1, 'state_root': roots['central'], 'registries': self.registries,
            'signer': {'certificate': str(self.ca), 'key': str(self.ca_key),
                'certificate_sha256': hashlib.sha256(self.ca.read_bytes()).hexdigest(),
                'key_sha256': hashlib.sha256(self.ca_key.read_bytes()).hexdigest()}}
        self.agent = {'runtime_key': 'physical-a', 'tenant_id': 'Equipo_42', 'alias': 'wire_a', 'host_id': 'host-a', 'fleet_baseline': False}
        self.scope = {'operation_id': '51000000-0000-4000-8000-000000000001', 'host_id': 'host-a',
            'scope_sha256': 'a' * 64, 'prepared_revision': 1, 'worker_id': 'worker-a',
            'claim_token': '51000000-0000-4000-8000-000000000002', 'claim_epoch': 1}
        self.context = {'operation_id': self.scope['operation_id'], 'fleet_scope': self.scope}
        self.socket = self.root / 'authority.sock'
        self.policy = {'host_id': 'host-a', 'roots': roots, 'authority': {'socket_path': str(self.socket),
            'owner_uid': os.geteuid(), 'host_id': 'host-a', 'ca_certificate': str(self.ca)}}
        self.snapshot = self.root / 'flota.json'
        self.snapshot.write_text(json.dumps({'bootstrap': {'physical-a': {'tenant': 'Equipo_42', 'alias': 'wire_a',
            'enabled': False, 'admission': False, 'lifecycleState': 'provisioning'}}, 'fleet': {}}))
        self.manifest = self.root / 'manifest.yaml'
        self.manifest.write_text('metadata:\n  name: physical-a\nspec:\n  tenant: Equipo_42\n  alias: wire_a\n  bootstrap: true\n  admission: false\n')
        self.requests, self.mutate, self.drop, self.denied = [], None, False, False
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fixture.requests.append(copy.deepcopy(body))
                try:
                    expected = {**fixture.scope, 'runtime_key': 'physical-a'}
                    if self.path != '/authority' or body['scope'] != expected or fixture.denied:
                        raise ValueError('scope expired or changed')
                    packet = {**body, 'scope': {name: body['scope'][name] for name in
                        ('operation_id', 'host_id', 'scope_sha256', 'runtime_key')},
                        'agent': {name: fixture.agent[name] for name in ('tenant_id', 'alias')}}
                    output = fixture.issuer.perform(fixture.central, packet)
                    if fixture.mutate:
                        output = fixture.mutate(output)
                    if fixture.drop:
                        fixture.drop = False
                        self.close_connection = True
                        return
                    encoded = json.dumps(output).encode()
                    self.send_response(200)
                except Exception:
                    encoded = b'{"error":"AUTHORITY_REVOKED"}'
                    self.send_response(409)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, *_args):
                pass

        self.server = socketserver.UnixStreamServer(str(self.socket), Handler)
        self.socket.chmod(0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def prepare(self):
        return adapter.prepare(self.policy, self.context, self.agent, self.snapshot, self.manifest, bootstrap=True)

    def test_real_certificate_is_verified_and_preserved_without_remote_private_signer(self):
        proof = self.prepare()
        pair = self.root / 'pki/bootstrap/physical-a'
        private = pair / 'agent-physical-a.key'
        before = private.read_bytes(), private.stat().st_ino
        self.assertEqual(self.prepare(), proof)
        self.assertEqual((private.read_bytes(), private.stat().st_ino), before)
        self.assertNotIn('PRIVATE KEY', json.dumps(self.requests))
        self.assertFalse((self.root / 'ca.key').exists())
        self.assertEqual([row['action'] for row in self.requests], ['issue', 'inventory'])
        self.assertEqual(proof['certificate_fingerprint'], hashlib.sha256(
            adapter.ssl.PEM_cert_to_DER_cert((pair / 'agent-physical-a.crt').read_text())).hexdigest())

    def test_lost_reply_reuses_exact_persisted_key_csr_and_idempotency_after_new_claim(self):
        self.drop = True
        with self.assertRaises(SafeFailure):
            self.prepare()
        first = copy.deepcopy(self.requests[-1])
        private = self.root / 'pki/bootstrap/physical-a/agent-physical-a.key'
        before = private.read_bytes(), private.stat().st_ino
        self.scope.update(claim_epoch=2, claim_token='51000000-0000-4000-8000-000000000003', worker_id='replacement')
        proof = self.prepare()
        second = self.requests[-1]
        for field in ('csr_pem', 'csr_sha256', 'idempotency_key'):
            self.assertEqual(first[field], second[field])
        self.assertEqual((private.read_bytes(), private.stat().st_ino), before)
        self.assertTrue(proof['certificate_fingerprint'])

    def test_forged_response_pin_and_expired_scope_never_publish_a_certificate(self):
        self.mutate = lambda result: {**result, 'token_sha256': '0' * 64}
        with self.assertRaises(SafeFailure):
            self.prepare()
        certificate = self.root / 'pki/bootstrap/physical-a/agent-physical-a.crt'
        self.assertFalse(certificate.exists())
        self.mutate, self.denied = None, True
        with self.assertRaises(SafeFailure):
            self.prepare()
        self.assertFalse(certificate.exists())

    def test_socket_owner_mode_and_foreign_host_are_denied_before_a_request(self):
        self.socket.chmod(0o660)
        with self.assertRaises(SafeFailure):
            self.prepare()
        self.socket.chmod(0o600)
        for change in ({'host_id': 'host-b'}, {'owner_uid': os.geteuid() + 1}):
            altered = copy.deepcopy(self.policy)
            altered['authority'].update(change)
            with self.assertRaises(SafeFailure):
                adapter.prepare(altered, self.context, self.agent, self.snapshot, self.manifest, bootstrap=True)
        self.assertEqual(self.requests, [])


    def test_reuse_in_a_subsequent_operation_requires_fresh_exact_inventory(self):
        proof = self.prepare()
        self.scope.update(operation_id='51000000-0000-4000-8000-000000000004', prepared_revision=2)
        self.context['operation_id'] = self.scope['operation_id']
        self.assertEqual(self.prepare(), proof)
        filename = pathlib.Path(self.registries['fleet_mtls'])
        document = json.loads(filename.read_bytes())
        document['identities'][0]['principal']['permissions'].append('admin')
        filename.write_text(json.dumps(document))
        with self.assertRaises(SafeFailure):
            self.prepare()
        self.assertEqual(sum(row['action'] == 'issue' for row in self.requests), 1)

    def test_central_revoke_is_cas_bound_and_lost_reply_replays_after_new_claim(self):
        self.prepare()
        journal, saves = {}, []
        self.drop = True
        original = adapter.call
        def dropping(configuration, scope, action, **fields):
            if action == 'inventory':
                self.drop = False
            elif action == 'revoke':
                self.drop = True
            return original(configuration, scope, action, **fields)
        with mock.patch.object(adapter, 'call', side_effect=dropping), self.assertRaises(SafeFailure):
            adapter.revoke(self.policy, self.context, self.agent, journal, lambda: saves.append(copy.deepcopy(journal)))
        expected = journal['central_revocations']['physical-a']['expected_inventory']
        self.scope.update(claim_epoch=2, worker_id='replacement', claim_token='51000000-0000-4000-8000-000000000003')
        reference = adapter.revoke(self.policy, self.context, self.agent, journal, lambda: None)
        self.assertEqual(expected, [row for row in self.requests if row['action'] == 'revoke'][-1]['expected_inventory'])
        self.assertTrue(journal['central_revocations']['physical-a']['complete'])
        self.assertEqual(adapter.verify_absence(reference, self.agent, self.context['operation_id']), reference['absence'])
        self.assertEqual(self.requests[-1]['action'], 'verify_absent')
        self.assertTrue(saves)

    def test_inventory_change_before_cas_and_reappearance_are_rejected(self):
        self.prepare()
        filename = pathlib.Path(self.registries['fleet_token'])
        before = filename.read_bytes()
        original = adapter.call
        def changed(configuration, scope, action, **fields):
            if action == 'revoke':
                filename.write_bytes(before + b'\n')
            return original(configuration, scope, action, **fields)
        journal = {}
        with mock.patch.object(adapter, 'call', side_effect=changed), self.assertRaises(SafeFailure):
            adapter.revoke(self.policy, self.context, self.agent, journal, lambda: None)
        filename.write_bytes(before)
        reference = adapter.revoke(self.policy, self.context, self.agent, journal, lambda: None)
        filename.write_bytes(before)
        for action in (lambda: adapter.verify_absence(reference, self.agent, self.context['operation_id']),
                       lambda: adapter.revoke(self.policy, self.context, self.agent, journal, lambda: None)):
            with self.assertRaises(SafeFailure):
                action()

    def test_forged_absence_receipt_and_foreign_scope_fail(self):
        self.prepare()
        forged = {'configuration': self.policy['authority'], 'scope': {**self.scope, 'runtime_key': 'physical-a'},
            'absence': {'authorities': [{'id': name, 'sha256': '0' * 64, 'matching_records': []} for name in adapter.AUTHORITIES]}}
        with self.assertRaises(SafeFailure):
            adapter.verify_absence(forged, self.agent, self.context['operation_id'])
        with self.assertRaises(SafeFailure):
            adapter.verify_absence({**forged, 'absence': True}, self.agent, self.context['operation_id'])
        with self.assertRaises(SafeFailure):
            adapter.verify_absence(forged, {**self.agent, 'host_id': 'host-b'}, self.context['operation_id'])

    def test_hook_uses_fresh_central_absence_and_never_reads_local_registries(self):
        import fleet_provider_revoke
        self.prepare()
        reference = adapter.revoke(self.policy, self.context, self.agent, {}, lambda: None)
        packet = {'operation_id': self.context['operation_id'], 'agent': self.agent, 'account_id': None,
            'identity': 'cauce-runtime:physical-a', 'transport': {'gateway_url': 'https://fixture.invalid'},
            'cauce_credentials': {'central': reference, 'credentials': {}, 'fleet_baseline': False,
                'identities_directory': '/must-not-read'}}
        with mock.patch.object(fleet_provider_revoke, 'checked_reference', side_effect=AssertionError('local authority read')):
            self.assertEqual(fleet_provider_revoke.revoke(packet), {'revocation_verified': True})
        self.assertEqual(self.requests[-1]['action'], 'verify_absent')
        self.denied = True
        with self.assertRaises(SafeFailure):
            fleet_provider_revoke.revoke(packet)

    def test_certificate_pair_subject_san_ca_and_expiry_are_checked(self):
        self.prepare()
        pair = self.root / 'pki/bootstrap/physical-a'
        key = pair / 'agent-physical-a.key'
        for subject, san, days, foreign_key in (('other', 'physical-a', 1, False),
                ('physical-a', 'other', 1, False), ('physical-a', 'physical-a', 0, False),
                ('physical-a', 'physical-a', 1, True)):
            signing_key = key
            if foreign_key:
                signing_key = self.root / 'other.key'
                signing_key.write_bytes(adapter.openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048'))
            csr = self.root / 'other.csr'
            csr.write_bytes(adapter.openssl('req', '-new', '-key', str(signing_key), '-subj', '/CN=agent-' + subject))
            extensions = ('basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:cauce:runtime:' + san + '\n')
            certificate = adapter.openssl('x509', '-req', '-in', str(csr), '-CA', str(self.ca), '-CAkey', str(self.ca_key),
                '-set_serial', '0x1234', '-days', str(days), '-extfile', '/dev/stdin', input_data=extensions.encode())
            with self.assertRaises(ValueError):
                adapter.validate_certificate(self.policy['authority'], pair, 'physical-a', certificate.decode())
        altered = copy.deepcopy(self.policy['authority'])
        altered['ca_certificate'] = str(pair / 'agent-physical-a.crt')
        with self.assertRaises(ValueError):
            adapter.validate_certificate(altered, pair, 'physical-a', (pair / 'agent-physical-a.crt').read_text())

    def test_key_csr_missing_or_changed_material_never_rotates(self):
        self.drop = True
        with self.assertRaises(SafeFailure):
            self.prepare()
        pair = self.root / 'pki/bootstrap/physical-a'
        private = pair / 'agent-physical-a.key'
        before = private.read_bytes()
        request = pair / '.authority-request.json'
        request.chmod(0o600)
        request.write_bytes(b'{}')
        with self.assertRaises(SafeFailure):
            self.prepare()
        self.assertEqual(private.read_bytes(), before)
        private.unlink()
        with self.assertRaises(SafeFailure):
            self.prepare()
        self.assertFalse(private.exists())



    def test_bootstrap_view_uses_central_ca_and_actual_validity_without_relaxing_local_pair_proof(self):
        from fleet_executor_pki import pair_proof
        from fleet_executor_view import payload_for
        self.prepare()
        pair = self.root / 'pki/bootstrap/physical-a'
        with self.assertRaises(ValueError):
            pair_proof(pair, 'physical-a', self.ca)
        self.policy['transport'] = {'ca_certificate': '/must-not-read-transport-ca'}
        receipt = {'generation': 'a' * 64, 'files': []}
        with mock.patch('fleet_runtime_materialization.load_desired_fleet', return_value=receipt):
            payload = payload_for(self.policy, self.agent, True)
        self.assertEqual(base64.b64decode(payload['files']['ca.crt']), self.ca.read_bytes())
        self.assertEqual(base64.b64decode(payload['files']['agent.key']), (pair / 'agent-physical-a.key').read_bytes())

    def test_policy_rejects_nonprivate_central_configuration_and_any_local_signer(self):
        import test_fleet_executor as fixtures
        from fleet_executor_policy import load_policy
        fixture = fixtures.PhysicalExecutorTest()
        fixture.setUp()
        try:
            fixture.policy['authority'] = {**self.policy['authority'], 'host_id': fixture.policy['host_id']}
            fixture.save_policy()
            self.assertEqual(load_policy(fixture.policy_file)['authority'], fixture.policy['authority'])
            fixture.policy_file.chmod(0o644)
            with self.assertRaises(SafeFailure):
                load_policy(fixture.policy_file)
            fixture.policy['signer'] = {'certificate': str(self.ca), 'key': str(self.ca_key)}
            fixture.save_policy()
            with self.assertRaises(SafeFailure):
                load_policy(fixture.policy_file)
        finally:
            fixture.tearDown()

    def executor_context(self):
        return {**self.context, 'request': {'kind': 'retire', 'target': {'resource': 'agent',
            'tenant_id': self.agent['tenant_id'], 'alias': self.agent['alias']}, 'parameters': {},
            'expected_revision': 1, 'idempotency_key': 'fixture-central-operation'},
            'fenced_targets': [], 'previous_agents': [], 'desired_memberships': []}

    def test_executor_prepares_central_credentials_without_any_local_signer(self):
        from fleet_executor_steps import Executor
        generation = self.root / 'generation'
        (generation / 'bootstrap/manifests').mkdir(parents=True)
        (generation / 'flota.json').write_bytes(self.snapshot.read_bytes())
        (generation / 'bootstrap/manifests/physical-a.yaml').write_bytes(self.manifest.read_bytes())
        executor = Executor(self.policy, self.executor_context())
        proof = executor.prepare_credentials(self.agent, generation, bootstrap=True)
        self.assertEqual(proof['certificate_fingerprint'], executor.journal['bootstrap_credentials'])
        self.assertEqual(self.requests[-1]['action'], 'issue')
        for name in adapter.AUTHORITIES:
            self.assertNotIn(str(pathlib.Path(self.registries[name]).parent), self.policy['roots'].values())

    def test_executor_revoke_purge_compensation_use_central_authority_without_local_registry_mutation(self):
        import fleet_executor_steps as steps
        import fleet_provider_revoke
        self.prepare()
        self.policy['transport'] = {'gateway_url': 'https://fixture.invalid', 'ca_certificate': str(self.ca)}
        executor = steps.Executor(self.policy, self.executor_context())
        executor.journal['stopped'] = True
        calls = []
        def hook(policy, context, agent, references):
            calls.append(copy.deepcopy(references))
            return fleet_provider_revoke.revoke({'operation_id': context['operation_id'], 'account_id': None,
                'identity': 'cauce-runtime:' + agent['runtime_key'], 'agent': agent,
                'transport': policy['transport'], 'cauce_credentials': references})
        with mock.patch.object(steps, 'scoped_agents', return_value=[self.agent]), \
                mock.patch.object(steps, 'stop'), mock.patch.object(steps, 'remove_runtime_credentials'), \
                mock.patch.object(steps, 'remove_registry_principals', side_effect=AssertionError('local authority write')), \
                mock.patch.object(steps, 'invoke_revoke', side_effect=hook), \
                mock.patch.object(fleet_provider_revoke, 'rejected', return_value=True):
            self.assertTrue(executor.revoke()['revocation_verified'])
            self.assertEqual(self.requests[-1]['action'], 'verify_absent')
            self.scope.update(claim_epoch=2, claim_token='51000000-0000-4000-8000-000000000003', worker_id='replacement')
            self.assertTrue(executor.revoke()['revocation_verified'])
            self.assertEqual(len(calls), 1)
            self.assertTrue(executor.compensate()['revocation_verified'])
            self.assertTrue(executor.compensate()['revocation_verified'])
            self.assertEqual(self.requests[-1]['action'], 'verify_absent')
            executor.context['request']['kind'] = 'purge'
            with mock.patch.object(steps, 'purge_runtime') as purge:
                self.assertTrue(executor.purge()['revocation_verified'])
                self.assertEqual(purge.call_count, 1)
            self.assertEqual(self.requests[-1]['action'], 'verify_absent')


class GlobalGroupMembershipTest(unittest.TestCase):
    def test_two_hosts_materialize_identical_global_restoration_and_pin_it_for_replay(self):
        import test_fleet_executor as fixtures
        from fleet_executor_policy import validate_payload
        from fleet_executor_steps import Executor
        fixture = fixtures.PhysicalExecutorTest()
        fixture.setUp()
        try:
            context = copy.deepcopy(fixture.context)
            context['request'].update(kind='restore', parameters={}, target={'resource': 'room', 'tenant_id': 'Equipo_42', 'room_id': 'room: shared'})
            context['snapshot']['memberships'][0]['enabled'] = True
            context['snapshot']['agents'][0].update(enabled=True, lifecycle_state='ready')
            second = {**context['snapshot']['agents'][0], 'alias': 'second_alias', 'runtime_key': 'physical-two', 'host_id': 'host-b',
                'container_name': 'host:host-b', 'state_directory': str(fixture.roots['runtime'] / 'physical-two')}
            context['snapshot']['agents'].append(second)
            context['snapshot']['memberships'].append({**fixture.member, 'alias': 'second_alias', 'enabled': True})
            extra = [{**fixture.member, 'room_id': 'room: shared'}, {**fixture.member, 'room_id': 'room: shared', 'alias': 'second_alias'}]
            context['snapshot']['memberships'] += extra
            global_intent = [{**row, 'enabled': True} for row in extra]
            context['global_desired_memberships'] = global_intent
            digests, snapshots = [], []
            for index in range(2):
                local = copy.deepcopy(context)
                local['desired_memberships'] = [global_intent[index]]
                validate_payload(local)
                state = fixture.root / ('state-' + str(index))
                state.mkdir(mode=0o700)
                policy = {**fixture.policy, 'roots': {**fixture.policy['roots'], 'state': str(state)}}
                executor = Executor(policy, local)
                executor.artifacts()
                result = executor.admit_memberships()
                digests.append(result['artifact_sha256'])
                snapshots.append((state / 'generations' / result['artifact_sha256'] / 'flota.json').read_bytes())
                changed = copy.deepcopy(local)
                changed['global_desired_memberships'][1]['enabled'] = False
                with self.assertRaises(SafeFailure):
                    Executor(policy, changed)
            self.assertEqual(digests[0], digests[1])
            self.assertEqual(snapshots[0], snapshots[1])
        finally:
            fixture.tearDown()

    def test_global_intent_rejects_other_operations_targets_duplicates_and_foreign_members(self):
        import test_fleet_executor as fixtures
        from fleet_executor_policy import validate_payload
        fixture = fixtures.PhysicalExecutorTest()
        fixture.setUp()
        try:
            context = copy.deepcopy(fixture.context)
            context['request'].update(kind='restore', parameters={}, target={'resource': 'room', 'tenant_id': 'Equipo_42', 'room_id': 'room: one'})
            context['global_desired_memberships'] = copy.deepcopy(context['desired_memberships'])
            validate_payload(context)
            for change in ('kind', 'foreign', 'duplicate', 'local', 'bound'):
                altered = copy.deepcopy(context)
                if change == 'kind':
                    altered['request']['kind'] = 'stop'
                elif change == 'foreign':
                    altered['global_desired_memberships'][0]['room_id'] = 'another room'
                elif change == 'duplicate':
                    altered['global_desired_memberships'] *= 2
                elif change == 'local':
                    altered['desired_memberships'][0]['role'] = 'admin'
                else:
                    altered['global_desired_memberships'] *= 1001
                with self.assertRaises(SafeFailure):
                    validate_payload(altered)
        finally:
            fixture.tearDown()


if __name__ == '__main__':
    unittest.main()
