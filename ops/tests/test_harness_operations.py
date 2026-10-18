import hashlib
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from harness_operations import (
    HarnessOperationFailure,
    descriptor_names,
    fleet_module,
    lifecycle_plan,
    operation_capabilities,
    provider_command,
    read_descriptor,
    resolve_operation,
)


class HarnessOperationsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        source = pathlib.Path(__file__).resolve().parents[2] / 'packages/adapter-sdk/descriptors'
        shutil.copytree(source, self.root / 'packages/adapter-sdk/dist/descriptors')

    def tearDown(self):
        self.temporary.cleanup()

    def test_bundled_catalog_resolves_each_typed_lifecycle_recipe(self):
        for operation, recipe in {'install': 'runtime-package', 'authenticate': 'provider-login', 'execute': 'native-execution',
                                  'update': 'provider-update', 'quota': 'quota-collector'}.items():
            result = resolve_operation('codex', operation, str(self.root))
            self.assertEqual(result['recipe'], recipe)
            self.assertEqual(len(result['descriptor_sha256']), 64)
        self.assertEqual(lifecycle_plan('codex', 'execute', str(self.root))['driver'], 'fleet-runtime')

    def test_commands_are_closed_and_fake_does_not_claim_provider_auth(self):
        self.assertEqual(provider_command('codex', 'authenticate', str(self.root)), ['/usr/local/bin/codex', 'login', '--device-auth'])
        self.assertEqual(provider_command('claude', 'quota', str(self.root)), ['/usr/local/bin/node', '/usr/local/bin/leer-cuota.mjs'])
        self.assertEqual(provider_command('codex', 'quota', str(self.root)), ['/usr/local/bin/codex-http-probe.py', '/home/node/.codex'])
        self.assertEqual(provider_command('codex', 'update', str(self.root))[-1], '@openai/codex')
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('fake', 'authenticate', str(self.root))
        with self.assertRaises(HarnessOperationFailure):
            provider_command('hermes', 'quota', str(self.root))

    def rewrite(self, harness, mutate):
        path = self.root / f'packages/adapter-sdk/dist/descriptors/{harness}.json'
        value = json.loads(path.read_text())
        mutate(value)
        path.write_text(json.dumps(value))
        return path

    def test_changing_descriptor_argv_changes_the_command(self):
        self.rewrite('codex', lambda value: value['provider'].update(
            authenticate_argv=['/usr/local/bin/codex', 'login', '--with-api-key']))
        self.assertEqual(provider_command('codex', 'authenticate', str(self.root)),
                         ['/usr/local/bin/codex', 'login', '--with-api-key'])

    def test_relative_or_shell_argv_is_rejected_with_field_and_reason(self):
        self.rewrite('codex', lambda value: value['provider'].update(authenticate_argv=['codex', 'login']))
        with self.assertRaisesRegex(HarnessOperationFailure, r'provider\.authenticate_argv\[0\]: must be an absolute'):
            provider_command('codex', 'authenticate', str(self.root))
        self.rewrite('codex', lambda value: value['provider'].update(
            authenticate_argv=['/usr/local/bin/codex', 'login;id']))
        with self.assertRaisesRegex(HarnessOperationFailure, r'provider\.authenticate_argv\[1\]: contains shell'):
            provider_command('codex', 'authenticate', str(self.root))
        self.rewrite('codex', lambda value: value['provider'].update(
            authenticate_argv=['/usr/local/bin/codex', 'login'], update_package='@openai/codex;id'))
        with self.assertRaisesRegex(HarnessOperationFailure, r'provider\.update_package: must be an npm'):
            provider_command('codex', 'update', str(self.root))

    def test_honest_descriptors_declare_only_implemented_operations(self):
        expected = {'hermes': {'install', 'execute'}, 'opencode': {'install', 'execute'},
                    'fake': {'install', 'execute'}, 'fake2': {'install', 'execute'},
                    'grok': {'install', 'execute', 'authenticate', 'quota'},
                    'muse': {'install', 'execute', 'authenticate'}, 'openclaw': {'install', 'execute', 'authenticate'},
                    'claude': {'install', 'execute', 'authenticate', 'update', 'quota'},
                    'codex': {'install', 'execute', 'authenticate', 'update', 'quota'}}
        self.assertEqual(descriptor_names(str(self.root)), frozenset(expected))
        for harness, operations in expected.items():
            descriptor, _ = read_descriptor(str(self.root), harness)
            self.assertEqual(set(descriptor['operations']), operations, harness)
        with self.assertRaisesRegex(HarnessOperationFailure, 'operations.update: operation is not declared'):
            provider_command('grok', 'update', str(self.root))
        self.assertEqual(fleet_module('grok', str(self.root)), 'fleet_provider_grok')
        self.assertIsNone(fleet_module('codex', str(self.root)))
        with self.assertRaisesRegex(HarnessOperationFailure, 'fleet-driven'):
            provider_command('openclaw', 'authenticate', str(self.root))

    def test_new_descriptor_appears_without_touching_runtime_lists(self):
        path = self.root / 'packages/adapter-sdk/dist/descriptors/fake2.json'
        path.write_text(json.dumps({'schema_version': 1, 'harness': 'fake2',
            'operations': {'install': 'runtime-package', 'execute': 'native-execution'},
            'context': {'native_document': 'AGENTS.md', 'max_bytes': 65536}}))
        self.assertIn('fake2', descriptor_names(str(self.root)))
        self.assertEqual(resolve_operation('fake2', 'execute', str(self.root))['recipe'], 'native-execution')

    def test_shared_descriptor_corpus_matches_python_expectations(self):
        corpus = pathlib.Path(__file__).resolve().parents[2] / 'packages/adapter-sdk/test/fixtures/descriptors'
        manifest = json.loads((corpus / 'corpus.json').read_text())
        target = self.root / 'packages/adapter-sdk/dist/descriptors/fake2.json'
        for case in manifest['cases']:
            with self.subTest(case=case['file']):
                target.write_bytes((corpus / case['file']).read_bytes())
                if case['python'] == 'ok':
                    read_descriptor(str(self.root), 'fake2')
                else:
                    with self.assertRaises(HarnessOperationFailure) as raised:
                        read_descriptor(str(self.root), 'fake2')
                    self.assertTrue(str(raised.exception).startswith(case['python'] + ':'), str(raised.exception))

    def test_operation_capabilities_report_reasons_per_operation(self):
        capabilities = operation_capabilities('grok', str(self.root))
        self.assertTrue(capabilities['quota']['available'])
        self.assertFalse(capabilities['update']['available'])
        self.assertIn('operations.update', capabilities['update']['reason'])
        capabilities = operation_capabilities('openclaw', str(self.root))
        self.assertFalse(capabilities['authenticate']['available'])
        self.assertIn('fleet-driven', capabilities['authenticate']['reason'])

    def test_refuses_arbitrary_descriptor_commands_and_identity_changes(self):
        path = self.root / 'packages/adapter-sdk/dist/descriptors/codex.json'
        value = json.loads(path.read_text())
        value['operations']['execute'] = 'sh -c arbitrary'
        path.write_text(json.dumps(value))
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('codex', 'execute', str(self.root))
        value['operations']['execute'] = 'native-execution'
        value['harness'] = 'claude'
        path.write_text(json.dumps(value))
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('codex', 'execute', str(self.root))

    def test_refuses_symlink_and_writable_descriptors(self):
        path = self.root / 'packages/adapter-sdk/dist/descriptors/codex.json'
        path.chmod(0o666)
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('codex', 'execute', str(self.root))
        path.unlink()
        path.symlink_to(self.root / 'packages/adapter-sdk/dist/descriptors/claude.json')
        with self.assertRaisesRegex(HarnessOperationFailure, r'descriptors/codex\.json: cannot open'):
            resolve_operation('codex', 'execute', str(self.root))

    def test_descriptor_pin_must_match_the_bytes_read(self):
        path = self.root / 'packages/adapter-sdk/dist/descriptors/codex.json'
        pin = hashlib.sha256(path.read_bytes()).hexdigest()
        descriptor, fingerprint = read_descriptor(str(self.root), 'codex', expected_sha256=pin)
        self.assertEqual(fingerprint, pin)
        self.assertEqual(descriptor['harness'], 'codex')
        self.assertEqual(resolve_operation('codex', 'quota', str(self.root), expected_sha256=pin)['descriptor_sha256'], pin)
        self.assertEqual(provider_command('codex', 'quota', str(self.root), expected_sha256=pin),
                         ['/usr/local/bin/codex-http-probe.py', '/home/node/.codex'])
        for wrong in ('0' * 64, 'A' * 64, 'a' * 63, 'sha256:' + pin):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(HarnessOperationFailure,
                    r'^approved harness descriptor changed$'):
                read_descriptor(str(self.root), 'codex', expected_sha256=wrong)
        capabilities = operation_capabilities('codex', str(self.root), expected_sha256='0' * 64)
        self.assertTrue(all(not row['available'] for row in capabilities.values()))
        path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaisesRegex(HarnessOperationFailure, r'^approved harness descriptor changed$'):
            resolve_operation('codex', 'quota', str(self.root), expected_sha256=pin)
        with self.assertRaisesRegex(HarnessOperationFailure, r'^approved harness descriptor changed$'):
            provider_command('codex', 'quota', str(self.root), expected_sha256=pin)

    def test_refuses_symlink_or_writable_package_directories(self):
        directory = self.root / 'packages/adapter-sdk/dist'
        directory.chmod(0o777)
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('codex', 'execute', str(self.root))
        directory.chmod(0o755)
        target = directory.with_name('original-dist')
        directory.rename(target)
        directory.symlink_to(target)
        with self.assertRaisesRegex(HarnessOperationFailure, r'descriptors: cannot open'):
            resolve_operation('codex', 'execute', str(self.root))


if __name__ == '__main__':
    unittest.main()
