from __future__ import annotations

import copy
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops/cli'))
import fleet_executor_container as container  # noqa: E402
import fleet_provider_openclaw as openclaw  # noqa: E402


class ProviderImportLayoutTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-provider-import-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir(mode=0o700)
        self.policy = {'bundles': {'openclaw': {'directory': str(self.bundle)}}}
        self.mounts = container.runtime_mounts(self.policy, {'harness_id': 'openclaw'})
        self.assertEqual(set(self.mounts), {'/cauce/lifecycle', '/cauce/executor', str(self.bundle)})
        for destination, source in self.mounts.items():
            target = self.root / 'layout' / destination.lstrip('/')
            target.mkdir(parents=True)
            for filename in pathlib.Path(source).glob('*.py'):
                shutil.copy2(filename, target / filename.name)
        self.executor = self.root / 'layout/cauce/executor'
        self.profile, self.state = self.root / 'profile', self.root / 'state'
        self.profile.mkdir(mode=0o700)
        self.state.mkdir(mode=0o700)
        self.agent = {'harness_id': 'openclaw', 'runtime_user': pwd.getpwuid(os.getuid()).pw_name,
            'home_directory': str(self.root), 'runtime_key': 'isolated', 'state_directory': str(self.state),
            'primary_account_id': 'account-one', 'model_id': 'openai/approved-model', 'reasoning_effort': 'high'}
        self.driver = {'provider_id': 'openai', 'method_id': 'device-code', 'version': openclaw.VERSION,
            'auth_list_source': '/approved/auth-list.js', 'auth_list_sha256': openclaw.AUTH_LIST_SHA256,
            'node_command': '/approved/node', 'node_command_sha256': 'a' * 64,
            'bridge': '/approved/bridge.mjs', 'bridge_sha256': 'b' * 64}
        self.binding = {'provider': 'codex', 'path': str(self.profile), 'runtime_user': self.agent['runtime_user'],
            'command': '/approved/cli', 'command_sha256': 'c' * 64, 'identity': 'public-fixture', 'openclaw': self.driver}
        self.packet = {'profile_binding': self.binding, 'agent': self.agent}

    def run_layout(self, code: str, packet: dict | None = None):
        program = 'import json,sys;sys.path.insert(0,sys.argv[1]);packet=json.load(sys.stdin)\n' + code
        return subprocess.run([sys.executable, '-I', '-B', '-c', program, str(self.executor)],
            input=json.dumps(self.packet if packet is None else packet), text=True, capture_output=True, timeout=5,
            cwd=self.root, env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'PYTHONDONTWRITEBYTECODE': '1'})

    def test_openclaw_prepares_exact_private_configuration_in_declared_layout(self):
        code = 'from fleet_provider_openclaw import prepare;prepare(packet["profile_binding"],packet["agent"]);print("prepared")'
        for _ in range(2):
            result = self.run_layout(code)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'prepared')
        configuration = self.profile / 'openclaw.json'
        self.assertEqual(configuration.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(configuration.read_text())['auth'], {'order': {'openai': ['cauce:account-one']}})
        self.assertFalse((self.profile / 'auth.json').exists())
        self.assertFalse((self.root / 'layout/cauce/scripts').exists())

    def test_three_drivers_validate_environment_without_unmounted_scripts(self):
        for harness in ('openclaw', 'grok', 'muse'):
            packet = copy.deepcopy(self.packet)
            packet['agent']['harness_id'] = harness
            if harness != 'openclaw':
                packet['profile_binding'].pop('openclaw')
                packet['profile_binding']['provider'] = harness
                packet['agent']['model_id'] = 'approved-model'
                packet['agent']['reasoning_effort'] = None
            if harness == 'muse':
                packet['profile_binding']['muse'] = {'bridge': '/approved/muse-bridge', 'bridge_sha256': 'd' * 64}
            code = 'import fleet_provider_' + harness + ' as provider\nvalues=provider.environment(packet["profile_binding"],packet["agent"])\n'
            if harness != 'openclaw':
                code += 'args=provider.execution_arguments(packet["agent"],"/approved/prompt");assert "--model" in args\n'
            code += 'assert "fleet_executor_policy" not in sys.modules;print(json.dumps(values))'
            with self.subTest(harness=harness):
                result = self.run_layout(code, packet)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsInstance(json.loads(result.stdout), dict)
        self.assertFalse((self.root / 'layout/cauce/scripts').exists())

    def test_shared_path_reexport_preserves_function_exception_and_message(self):
        import fleet_executor_policy
        import fleet_policy_paths
        self.assertIs(fleet_executor_policy.SafeFailure, fleet_policy_paths.SafeFailure)
        self.assertIs(fleet_executor_policy.path, fleet_policy_paths.path)
        for value in (None, 1, 'relative', '/wrong/../path', '/wrong//path', '/path\n'):
            with self.subTest(value=value), self.assertRaisesRegex(fleet_executor_policy.SafeFailure, '^noncanonical policy path$'):
                fleet_policy_paths.path(value)
        for value in ('/', '/canonical/profile'):
            self.assertEqual(fleet_policy_paths.path(value), pathlib.Path(value))

    def test_public_container_entrypoints_import_without_scripts_or_policy(self):
        code = '''import importlib,pathlib,runpy
for name in ('fleet_provider_identity', 'fleet_provider_probe', 'fleet_provider_revoke',
             'fleet_executor_view', 'fleet_executor_profiles'):
    importlib.import_module(name)
runpy.run_path(str(pathlib.Path(sys.argv[1]) / 'fleet-provider-hook.py'), run_name='isolated_import')
assert 'fleet_executor_policy' not in sys.modules
assert 'fleet_runtime_materialization' not in sys.modules
print('public helper imports accepted')
'''
        result = self.run_layout(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'public helper imports accepted')

    def test_openclaw_definition_still_rejects_noncanonical_paths(self):
        code = '''from fleet_provider_openclaw import validate_definition
try:
    validate_definition(packet['profile_binding']['openclaw'], 'codex')
except ValueError:
    print('rejected')
else:
    raise AssertionError('invalid path accepted')
'''
        for value in ('relative/bridge', '/approved/../bridge', '/approved//bridge', '/approved/bridge\n'):
            packet = copy.deepcopy(self.packet)
            packet['profile_binding']['openclaw']['bridge'] = value
            with self.subTest(value=value):
                result = self.run_layout(code, packet)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'rejected')

    def test_owned_profile_still_rejects_symlink_public_mode_and_foreign_owner(self):
        code = '''import pathlib
import fleet_provider_openclaw as provider
if packet.get('foreign_owner'):
    current = provider.os.geteuid()
    provider.os.geteuid = lambda: current + 1
try:
    provider.owned_directory(pathlib.Path(packet['profile_binding']['path']))
except (ValueError, OSError):
    print('rejected')
else:
    raise AssertionError('unsafe owned directory accepted')
'''
        link = self.root / 'profile-link'
        link.symlink_to(self.profile, target_is_directory=True)
        variants = [{**self.packet, 'profile_binding': {**self.binding, 'path': str(link)}},
            {**self.packet, 'foreign_owner': True}]
        for packet in variants:
            result = self.run_layout(code, packet)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.profile.chmod(0o777)
        result = self.run_layout(code)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'rejected')

    def test_existing_public_configuration_is_not_accepted_as_private(self):
        code = 'from fleet_provider_openclaw import prepare;prepare(packet["profile_binding"],packet["agent"])'
        first = self.run_layout(code)
        self.assertEqual(first.returncode, 0, first.stderr)
        configuration = self.profile / 'openclaw.json'
        body = configuration.read_bytes()
        configuration.chmod(0o644)
        rejected = self.run_layout(code)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('private configuration identity changed', rejected.stderr)
        self.assertEqual(configuration.read_bytes(), body)


if __name__ == '__main__':
    unittest.main()
