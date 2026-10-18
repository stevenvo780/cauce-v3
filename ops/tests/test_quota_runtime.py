import copy
import importlib.util
import json
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
        native = '/home/node/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime, 'docker', return_value=native.encode()), \
                patch.object(runtime.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as execute:
            plan = runtime.login_plan(self.policy, self.document)
        self.assertEqual(plan['command'], [native, 'login', '--device-auth'])
        self.assertEqual(execute.call_args.args[0][-3:], ['/usr/bin/test', '-x', '/home/node/.local/bin/codex'])
        self.assertEqual(plan['account_scope'], 'fixture-account')
        self.assertEqual(plan['container_binding']['container_id'], self.observed['Id'])

    def test_foreign_profile_volume_is_not_removed(self):
        labels = runtime.labels(self.policy, self.environment)
        observed = copy.deepcopy(self.observed)
        observed.update({'Config': {'User': '1000:1000', 'Labels': labels}, 'Mounts': [
            {'Destination': '/home/node', 'Type': 'volume', 'Name': self.environment['container_name'] + '-profile', 'RW': True},
            {'Destination': '/cauce/executor', 'Type': 'bind', 'Source': str(runtime.EXECUTOR_SOURCE), 'RW': False},
            {'Destination': '/cauce/lifecycle', 'Type': 'bind', 'Source': str(runtime.LIFECYCLE_SOURCE), 'RW': False}],
            'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'NetworkMode': 'fixture-network', 'Memory': 512 * 1024 * 1024,
                           'PidsLimit': 128, 'Tmpfs': dict(runtime.TMPFS), 'CapDrop': ['ALL'], 'CapAdd': list(runtime.CAPABILITIES), 'SecurityOpt': ['no-new-privileges']}})
        with patch.object(runtime, 'docker', return_value=json.dumps([{'Labels': {'cauce.quota.company': 'foreign'}}]).encode()) as execute:
            with self.assertRaises(runtime.SafeFailure):
                runtime.validate(self.policy, self.environment, observed)
        self.assertEqual(execute.call_args.args[0:2], ('volume', 'inspect'))

    def test_failed_new_creation_rolls_back_new_resources(self):
        for failure in (runtime.SafeFailure('unusable CLI'), subprocess.TimeoutExpired(['docker', 'exec'], 40)):
            with self.subTest(failure=type(failure)), patch.object(runtime, 'inspect_container', return_value=None), \
                    patch.object(runtime, 'docker', return_value=b''), patch.object(runtime, 'create_runtime', side_effect=failure), \
                    patch.object(runtime, 'remove') as remove:
                with self.assertRaises(type(failure)):
                    runtime.create(self.policy, self.environment)
            remove.assert_called_once_with(self.policy, self.environment)

    def test_auth_verification_requires_a_successful_request_and_provider_account_identity(self):
        verified = {'fuente': 'wham-http', 'error': None, 'extra': {'account_id': 'remote-subscription'}}
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime, 'query_observation', return_value=verified):
            self.assertEqual(runtime.verify_authentication(self.policy,self.document),
                             {'authenticated_verified': True, 'account_identity': 'remote-subscription'})
        grok_document = copy.deepcopy(self.document)
        grok_document['environment']['provider'] = 'grok'
        grok_policy = copy.deepcopy(self.policy)
        grok_policy['quota_environments']['providers'] = ['grok']
        grok_policy['bundles'] = {'grok': dict(self.policy['bundles']['codex'])}
        grok_report = {'ok': True, 'account_id': 'grok:' + 'b' * 64}
        local_report = {'ok': True, 'account_id': 'grok-local:' + 'c' * 64}
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime, 'query_observation', return_value=grok_report):
            self.assertEqual(runtime.verify_authentication(grok_policy, grok_document),
                             {'authenticated_verified': True, 'account_identity': grok_report['account_id']})
        with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                patch.object(runtime, 'query_observation', return_value=local_report):
            self.assertEqual(runtime.verify_authentication(grok_policy, grok_document),
                             {'authenticated_verified': True, 'account_identity': local_report['account_id']})
        for identity in ('principal-raw', 'user@example.invalid', 'grok:' + 'b' * 63):
            with patch.object(runtime, 'inspect_container', return_value=self.observed), patch.object(runtime, 'validate'), \
                    patch.object(runtime, 'query_observation', return_value={'ok': True, 'account_id': identity}):
                with self.assertRaises(runtime.SafeFailure):
                    runtime.verify_authentication(grok_policy, grok_document)
        retired = copy.deepcopy(self.document)
        retired['environment']['provider'] = 'gemini'
        retired_policy = copy.deepcopy(self.policy)
        retired_policy['quota_environments']['providers'] = ['gemini']
        with self.assertRaises(runtime.SafeFailure) as caught:
            runtime.packet(retired_policy, retired)
        self.assertIn('no executor', str(caught.exception))
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

if __name__ == '__main__':
    unittest.main()
