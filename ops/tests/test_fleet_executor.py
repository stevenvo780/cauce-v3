from __future__ import annotations

import copy
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import sys
import tempfile
import unittest
import uuid

OPS = pathlib.Path(__file__).resolve().parents[1]
CLI = OPS / 'cli/fleet-executor.py'
sys.path.insert(0, str(OPS / 'container-runtime'))
from cauce_container_base import bundle_digest  # noqa: E402


class PhysicalExecutorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-physical-executor-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        self.user = pwd.getpwuid(os.geteuid()).pw_name
        self.roots = {name: self.root / name for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
        for directory in self.roots.values():
            directory.mkdir(mode=0o700)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir(mode=0o700)
        self.worker = self.bundle / 'worker.py'
        self.worker.write_text('import time\ntime.sleep(60)\n')
        self.executable = pathlib.Path(sys.executable).resolve()
        self.policy_file = self.root / 'policy.json'
        self.policy = {'schemaVersion': 1, 'host_id': 'fixture-host', 'executor_user': self.user,
            'roots': {name: str(path) for name, path in self.roots.items()},
            'native': [{'runtime_user': self.user, 'systemd_user': self.user, 'home_directory': str(self.root),
                        'state_root': str(self.roots['runtime'])}], 'containers': {}, 'profiles': {}, 'hooks': {},
            'bundles': {'codex': {'directory': str(self.bundle), 'digest': bundle_digest(str(self.bundle)),
                'executable': str(self.executable), 'executable_sha256': hashlib.sha256(self.executable.read_bytes()).hexdigest(),
                'argv': [str(self.worker)]}}}
        self.save_policy()
        self.agent = {'tenant_id': 'Equipo_42', 'alias': 'shared_alias', 'harness_id': 'codex', 'enabled': False,
            'fleet_baseline': False,
            'runtime_key': 'physical-one', 'primary_room_id': 'room: one', 'lifecycle_state': 'provisioning',
            'host_id': 'fixture-host', 'runtime_mode': 'native', 'container_name': 'host:fixture-host',
            'runtime_user': self.user, 'home_directory': str(self.root), 'state_directory': str(self.roots['runtime'] / 'physical-one'),
            'systemd_user': self.user}
        self.member = {'tenant_id': 'Equipo_42', 'alias': 'shared_alias', 'room_id': 'room: one', 'role': 'observer', 'enabled': False}
        self.context = {'operation_id': str(uuid.uuid4()), 'request': {'kind': 'create',
            'target': {'resource': 'agent', 'tenant_id': 'Equipo_42', 'alias': 'shared_alias'},
            'expected_revision': 0, 'idempotency_key': 'fixture-operation', 'parameters': {'runtime_key': 'physical-one',
                'harness_id': 'codex', 'primary_room_id': 'room: one', 'memberships': [{'room_id': 'room: one', 'role': 'observer'}],
                'placement': {'host_id': 'fixture-host', 'mode': 'native', 'runtime_user': self.user,
                    'systemd_user': self.user, 'home_directory': str(self.root), 'state_directory': self.agent['state_directory']}}},
            'fenced_targets': [], 'previous_agents': [], 'desired_memberships': [{**self.member, 'enabled': True}],
            'snapshot': {'agents': [self.agent], 'memberships': [self.member], 'rolePolicies': [{'role': 'observer'}]}}

    def save_policy(self):
        self.policy_file.write_text(json.dumps(self.policy))
        self.policy_file.chmod(0o600)

    def tearDown(self):
        if CLI.exists():
            self.run_step('stop', timeout=20)
        self.temporary.cleanup()

    def run_step(self, step, context=None, timeout=20):
        return subprocess.run([sys.executable, str(CLI), '--policy', str(self.policy_file), '--step', step],
            input=json.dumps(self.context if context is None else context), capture_output=True, text=True, timeout=timeout)

    def test_artifacts_write_only_external_bootstrap_generation_and_hash_real_bytes(self):
        result = self.run_step('artifacts')
        self.assertEqual(result.returncode, 0, result.stderr)
        evidence = json.loads(result.stdout)['evidence']
        receipt = json.loads((self.roots['state'] / 'desired-fleet.json').read_bytes())
        self.assertEqual(evidence['artifact_sha256'], receipt['generation'])
        generation = self.roots['state'] / 'generations' / receipt['generation']
        snapshot = json.loads((generation / 'flota.json').read_bytes())
        self.assertFalse(snapshot['bootstrap']['physical-one']['enabled'])
        self.assertEqual(snapshot['fleet'], {})
        self.assertFalse((self.roots['state'] / 'applied-fleet.json').exists())
        self.assertTrue((generation / 'bootstrap/manifests/physical-one.yaml').exists())

    def test_unapproved_user_or_ui_command_never_writes_artifacts(self):
        for mutation in ('user', 'command'):
            context = copy.deepcopy(self.context)
            if mutation == 'user':
                context['request']['parameters']['placement']['runtime_user'] = 'nobody'
            else:
                context['request']['parameters']['command'] = ['sh', '-c', 'touch /bad']
            result = self.run_step('artifacts', context)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.roots['state'] / 'desired-fleet.json').exists())
            self.assertNotIn('touch /bad', result.stderr)

    def test_policy_symlink_and_group_write_are_rejected(self):
        original = self.root / 'original.json'
        self.policy_file.rename(original)
        self.policy_file.symlink_to(original)
        self.assertNotEqual(self.run_step('artifacts').returncode, 0)
        self.policy_file.unlink()
        original.rename(self.policy_file)
        self.policy_file.chmod(0o660)
        self.assertNotEqual(self.run_step('artifacts').returncode, 0)
        self.assertFalse((self.roots['state'] / 'desired-fleet.json').exists())

    def test_missing_auth_hook_returns_awaiting_auth_and_never_verified(self):
        result = self.run_step('authenticate')
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertTrue(receipt['awaiting_auth'])
        self.assertEqual(receipt['evidence'], {})
        verify = self.run_step('verify')
        self.assertNotEqual(verify.returncode, 0)
        self.assertNotIn('provider_verified', verify.stdout)

    def test_native_runtime_starts_from_no_process_then_stops_under_exact_identity(self):
        self.configure_signer()
        artifacts = self.run_step('artifacts')
        self.assertEqual(artifacts.returncode, 0, artifacts.stderr)
        self.assertEqual(self.run_step('credentials').returncode, 0)
        runtime = self.run_step('runtime')
        self.assertEqual(runtime.returncode, 0, runtime.stderr)
        metadata = self.roots['runtime'] / '.control' / 'physical-one' / 'cauce-v3-adapter.json'
        document = json.loads(metadata.read_bytes())
        self.assertEqual((document['alias'], document['wireAlias'], document['tenantId']),
                         ('physical-one', 'shared_alias', 'Equipo_42'))
        self.assertEqual(document['runtimeUid'], os.getuid())
        pid = document['pid']
        self.assertTrue(pathlib.Path(f'/proc/{pid}').exists())
        repeat = self.run_step('runtime')
        self.assertEqual(repeat.returncode, 0, repeat.stderr)
        self.assertEqual(json.loads(metadata.read_bytes())['pid'], pid)
        stopped = self.run_step('stop')
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertTrue(json.loads(stopped.stdout)['evidence']['stopped_verified'])
        self.assertFalse(pathlib.Path(f'/proc/{pid}').exists())

    def configure_hooks(self, wrong_nonce=False):
        profile = self.root / 'provider-profile'
        profile.mkdir(mode=0o700)
        self.policy['profiles']['fixture-account'] = {'provider': 'codex', 'path': str(profile),
            'identity': 'fixture-identity', 'runtime_user': self.user}
        self.context['request']['parameters']['primary_account_id'] = 'fixture-account'
        self.agent['primary_account_id'] = 'fixture-account'
        driver = self.root / 'driver.py'
        driver.write_text('import json,sys\np=json.load(sys.stdin)\nr={k:p[k] for k in ("nonce","account_id")}\n'
            'r.update({k:p["agent"][k] for k in ("tenant_id","alias","runtime_key")})\n'
            'r["identity"]=p["profile_binding"]["identity"]\n'
            'if "phase" in p:r["phase"]=p["phase"]\n'
            + ('r["nonce"]="wrong"\n' if wrong_nonce else '')
            + 'r.update(authenticated=True,profile_verified=True,provider_verified=True,bootstrap_verified=True,roundtrip_verified=True)\n'
              'print(json.dumps(r))\n')
        pinned = hashlib.sha256(self.executable.read_bytes()).hexdigest()
        for step in ('authenticate', 'profile', 'verify'):
            self.policy['hooks'][step] = {'executable': str(self.executable), 'sha256': pinned,
                'argv': [str(driver)], 'files': {str(driver): hashlib.sha256(driver.read_bytes()).hexdigest()}, 'user': self.user}
        self.save_policy()

    def configure_signer(self):
        ca, key = self.root / 'ca.crt', self.root / 'ca.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '10',
            '-keyout', str(key), '-out', str(ca), '-subj', '/CN=disposable-executor-ca',
            '-addext', 'basicConstraints=critical,CA:TRUE'], capture_output=True, check=True)
        key.chmod(0o400)
        self.policy['signer'] = {'certificate': str(ca), 'key': str(key)}
        self.policy['transport'] = {'bootstrap_url': 'https://bootstrap.fixture.invalid',
            'gateway_url': 'https://gateway.fixture.invalid', 'ca_certificate': str(ca), 'network': 'none'}
        self.save_policy()

    def test_hook_exit_zero_with_wrong_nonce_does_not_verify_provider(self):
        self.configure_hooks(wrong_nonce=True)
        result = self.run_step('authenticate')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('provider_verified', result.stdout)

    def test_hook_script_changed_after_policy_approval_is_not_executed(self):
        self.configure_hooks()
        driver = self.root / 'driver.py'
        driver.write_text(driver.read_text() + '\nprint("untrusted fixture")\n')
        result = self.run_step('authenticate')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('untrusted fixture', result.stdout + result.stderr)

    def test_admission_requires_full_verify_and_keeps_normal_credentials_separate(self):
        self.configure_hooks()
        self.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime', 'authenticate', 'profile'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        premature = self.run_step('admission')
        self.assertNotEqual(premature.returncode, 0)
        self.assertFalse((self.roots['state'] / 'applied-fleet.json').exists())
        verified = self.run_step('verify')
        self.assertEqual(verified.returncode, 0, verified.stderr)
        admitted = self.run_step('admission')
        self.assertEqual(admitted.returncode, 0, admitted.stderr)
        receipt = json.loads((self.roots['state'] / 'applied-fleet.json').read_bytes())
        snapshot = json.loads((self.roots['state'] / 'generations' / receipt['generation'] / 'flota.json').read_bytes())
        self.assertTrue(snapshot['fleet']['physical-one']['enabled'])
        self.assertEqual(snapshot['fleet']['physical-one']['role'], 'observer')
        bootstrap = self.roots['tokens'] / 'bootstrap/physical-one.token'
        normal = self.roots['tokens'] / 'normal/physical-one.token'
        self.assertNotEqual(bootstrap.read_bytes(), normal.read_bytes())
        records = json.loads((self.roots['identities'] / 'token_hashes.json').read_bytes())['identities']
        self.assertEqual({row['principal']['channel'] for row in records}, {'bootstrap', 'adapter'})
        expiry = {row['principal']['channel']: datetime.datetime.fromisoformat(row['expires_at'].replace('Z', '+00:00')) for row in records}
        self.assertGreater((expiry['adapter'] - expiry['bootstrap']).days, 5)
        metadata = self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        pid = json.loads(metadata.read_bytes())['pid']
        replay = self.run_step('admission')
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(json.loads(metadata.read_bytes())['pid'], pid)
        self.assertEqual(json.loads(replay.stdout)['evidence'], json.loads(admitted.stdout)['evidence'])
        self.assertFalse(self.context['snapshot']['agents'][0]['enabled'])


if __name__ == '__main__':
    unittest.main()
