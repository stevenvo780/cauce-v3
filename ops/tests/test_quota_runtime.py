import copy
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'cli'))
runtime = importlib.import_module('quota_runtime')
bundle_digest = importlib.import_module('fleet_executor_runtime').bundle_digest
normalize_cli_snapshot = importlib.import_module('quota_snapshot').normalize_cli_snapshot


class QuotaRuntimeTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        bundle = pathlib.Path(temporary.name)
        shutil.copytree(ROOT.parent / 'packages/adapter-sdk/descriptors', bundle / 'packages/adapter-sdk/dist/descriptors')
        self.policy = {'host_id': 'fixture-host', 'executor_user': 'fixture-user', 'roots': {'runtime': '/fixture/runtime'},
                       'bundles': {'codex': {'directory': str(bundle), 'digest': bundle_digest(str(bundle)),
                                            'executable': '/usr/local/bin/codex', 'executable_sha256': 'a' * 64, 'argv': []}},
                       'quota_environments': {'image': 'sha256:' + 'a' * 64, 'network': 'fixture-network', 'providers': ['codex']}}
        self.document = {'operation_id': '2c647dc7-e3f3-4287-af89-7a6597e5a40c', 'action': 'authenticate', 'consent': True,
                         'environment': {'id': '1c647dc7-e3f3-4287-af89-7a6597e5a40c', 'company_id': 'fixture-company',
                                         'account_id': 'fixture-account', 'host_id': 'fixture-host', 'provider': 'codex',
                                         'container_name': 'cauce-quota-1c647dc7e3f34287af897a6597e5a40c'}}
        self.environment = self.document['environment']
        self.observed = {'Id': 'fixture-container', 'Image': self.policy['quota_environments']['image'],
                         'State': {'Running': True, 'StartedAt': '2026-01-01T00:00:00Z'}}

    def test_rejects_shell_input_foreign_scope_and_missing_consent(self):
        for mutate in [lambda doc: doc.update(command='bash'), lambda doc: doc.update(consent=False),
                       lambda doc: doc['environment'].update(host_id='foreign-host'),
                       lambda doc: doc['environment'].update(container_name='existing-shared-container')]:
            document = copy.deepcopy(self.document)
            mutate(document)
            with self.assertRaises(runtime.SafeFailure):
                runtime.packet(self.policy, document)

    def test_login_uses_updated_cli_and_never_runs_a_shell(self):
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as execute:
            plan = runtime.login_plan(self.policy, self.document)
        self.assertEqual(plan['command'], ['/home/node/.local/bin/codex', 'login', '--device-auth'])
        self.assertEqual(execute.call_args.args[0][-3:], ['/usr/bin/test', '-x', '/home/node/.local/bin/codex'])
        self.assertEqual(plan['account_scope'], 'fixture-account')
        self.assertEqual(plan['container_binding']['container_id'], self.observed['Id'])

    def test_login_falls_back_only_when_updated_binary_is_absent(self):
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            self.assertEqual(runtime.login_plan(self.policy, self.document)['command'][0], '/usr/local/bin/codex')

    def test_ready_requires_a_functional_cli_version_command(self):
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), \
                patch.object(runtime, 'docker', return_value=b'codex-cli 1.2.3\n') as execute:
            result = runtime.create(self.policy,self.environment)
        self.assertEqual(result['cli_version'], 'codex-cli 1.2.3')
        self.assertTrue(result['runtime_verified'])
        self.assertEqual(execute.call_args.args[-2:], ('/usr/local/bin/codex', '--version'))
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), \
                patch.object(runtime, 'docker', return_value=b''):
            with self.assertRaises(runtime.SafeFailure):
                runtime.create(self.policy,self.environment)

    def test_foreign_profile_volume_is_not_removed(self):
        labels = runtime.labels(self.policy, self.environment)
        observed = copy.deepcopy(self.observed)
        observed.update({'Config': {'User': '1000:1000', 'Labels': labels}, 'Mounts': [
            {'Destination': '/home/node', 'Type': 'volume', 'Name': self.environment['container_name'] + '-profile', 'RW': True},
            {'Destination': '/cauce/executor', 'Type': 'bind', 'Source': str(runtime.EXECUTOR_SOURCE), 'RW': False}],
            'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'NetworkMode': 'fixture-network', 'Memory': 512 * 1024 * 1024,
                           'PidsLimit': 128, 'CapDrop': ['ALL'], 'CapAdd': list(runtime.CAPABILITIES), 'SecurityOpt': ['no-new-privileges']}})
        with patch.object(runtime, 'docker', return_value=json.dumps([{'Labels': {'cauce.quota.company': 'foreign'}}]).encode()) as execute:
            with self.assertRaises(runtime.SafeFailure):
                runtime.validate(self.policy, self.environment, observed)
        self.assertEqual(execute.call_args.args[0:2], ('volume', 'inspect'))

    def test_query_failure_is_not_a_successful_effect(self):
        document = {**self.document, 'action': 'query'}
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, stdout=b'{}')):
            with self.assertRaises(runtime.SafeFailure):
                runtime.perform(self.policy, document)

    def test_codex_error_exit_ingests_an_error_observation(self):
        document = {**self.document, 'action': 'query'}
        body = json.dumps({'error': 'HTTP 429', 'ventanas': []}).encode()
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, stdout=body)) as execute:
            report = runtime.perform(self.policy, document)
        self.assertEqual(report['observation_status'], 'error')
        self.assertFalse(report['provider_report']['ok'])
        self.assertEqual(report['provider_report']['note'], 'rate_limited')
        self.assertEqual(execute.call_args.args[0][-1], '--refresh-own-session')

    def test_descriptors_are_pinned_and_unavailable_providers_never_claim_readiness(self):
        self.policy['quota_environments']['providers'] = ['codex', 'gemini']
        self.assertEqual(runtime.capabilities(self.policy), {'providers': ['codex'],
            'actions': {'codex': ['create', 'authenticate', 'query', 'update_cli', 'delete']}})
        descriptor = pathlib.Path(self.policy['bundles']['codex']['directory']) / 'packages/adapter-sdk/dist/descriptors/codex.json'
        descriptor.write_text(descriptor.read_text() + '\n')
        self.assertEqual(runtime.capabilities(self.policy), {'providers': [], 'actions': {}})
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime.subprocess, 'run') as execute:
            with self.assertRaises(runtime.SafeFailure):
                runtime.perform(self.policy, {**self.document, 'action': 'query'})
        execute.assert_not_called()

    def test_auth_verification_requires_a_successful_request_and_provider_account_identity(self):
        verified = {'fuente': 'wham-http', 'error': None, 'extra': {'account_id': 'remote-subscription'}}
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime, 'query_observation', return_value=verified):
            self.assertEqual(runtime.verify_authentication(self.policy,self.document),
                             {'authenticated_verified': True, 'account_identity': 'remote-subscription'})
        for report in [{'error': 'HTTP 429', 'extra': {'account_id': 'remote-subscription'}},
                       {'ok': True, 'email': 'local-only@fixture.invalid'},
                       {'fuente': 'wham-http', 'error': None, 'extra': {}}]:
            with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                    patch.object(runtime, 'query_observation', return_value=report):
                with self.assertRaises(runtime.SafeFailure):
                    runtime.verify_authentication(self.policy,self.document)

    def test_normalization_preserves_limits_and_strips_private_identity(self):
        report = normalize_cli_snapshot('codex', {'ok': True, 'email': 'private@fixture.invalid', 'extra': {'access_token': 'fixture-secret'},
            'ventanas': [{'clave': 'spark:5h', 'key': '5h', 'limitId': 'spark', 'model': 'codex-spark', 'usado_pct': 12,
                          'windowMinutes': 300, 'reset_at': None}]}, 'fixture-account')
        window = report['provider_report']['windows'][0]
        self.assertEqual((window['group_key'], window['model'], window['account_id']), ('spark', 'codex-spark', 'fixture-account'))
        self.assertIsNone(window['reset_at'])
        self.assertNotIn('fixture-secret', json.dumps(report))
        self.assertNotIn('private@fixture.invalid', json.dumps(report))
        error = normalize_cli_snapshot('codex', {'error': 'HTTP 429', 'ventanas': []}, 'fixture-account')
        self.assertEqual(error['observation_status'], 'error')
        self.assertEqual(error['provider_report']['windows'], [])

    def test_existing_executor_dispatches_quota_without_the_agent_protocol(self):
        spec = importlib.util.spec_from_file_location('fleet_executor_entry', ROOT / 'cli' / 'fleet-executor.py')
        executor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(executor)
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(self.document).encode()))
        stdout = io.StringIO()
        with patch.object(executor, 'load_policy', return_value=self.policy), patch.object(runtime, 'perform', return_value={'awaiting_auth': True}) as effect, \
                patch.object(sys, 'argv', ['fleet-executor.py', '--policy', '/fixture/policy.json', '--quota']), \
                patch.object(sys, 'stdin', stdin), patch.object(sys, 'stdout', stdout), patch.object(executor.signal, 'signal'):
            self.assertEqual(executor.main(), 0)
        effect.assert_called_once_with(self.policy, self.document)
        self.assertEqual(json.loads(stdout.getvalue()), {'awaiting_auth': True})

    def test_private_policy_validates_quota_allowlist_and_requires_a_verified_descriptor(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            roots = {field: str(root / field) for field in ['state', 'runtime', 'pki', 'tokens', 'identities']}
            for path in roots.values():
                os.mkdir(path, 0o700)
            import pwd
            policy = {'schemaVersion': 1, 'host_id': 'fixture-host', 'executor_user': pwd.getpwuid(os.geteuid()).pw_name,
                      'roots': roots, 'native': [], 'containers': {}, 'bundles': {}, 'profiles': {}, 'hooks': {},
                      'quota_environments': {'image': 'sha256:' + 'a' * 64, 'network': 'fixture-network', 'providers': ['gemini']}}
            filename = root / 'policy.json'
            filename.write_text(json.dumps(policy))
            filename.chmod(0o600)
            response = subprocess.run([sys.executable, str(ROOT / 'cli' / 'fleet-executor.py'), '--policy', str(filename), '--capabilities'],
                                      capture_output=True, text=True, timeout=15, check=True)
            self.assertEqual(json.loads(response.stdout)['quota_environments'], {'providers': [], 'actions': {}})
            policy['quota_environments']['providers'] = ['unknown-provider']
            filename.write_text(json.dumps(policy))
            rejected = subprocess.run([sys.executable, str(ROOT / 'cli' / 'fleet-executor.py'), '--policy', str(filename), '--capabilities'],
                                      capture_output=True, text=True, timeout=15)
            self.assertNotEqual(rejected.returncode, 0)


if __name__ == '__main__':
    unittest.main()
