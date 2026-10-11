import json
import pathlib
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from harness_operations import HarnessOperationFailure, lifecycle_plan, provider_command, resolve_operation


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
        self.assertEqual(provider_command('claude', 'quota', str(self.root)), ['node', '/usr/local/bin/leer-cuota.mjs'])
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('fake', 'authenticate', str(self.root))
        with self.assertRaises(HarnessOperationFailure):
            provider_command('hermes', 'quota', str(self.root))

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
        with self.assertRaises(OSError):
            resolve_operation('codex', 'execute', str(self.root))

    def test_refuses_symlink_or_writable_package_directories(self):
        directory = self.root / 'packages/adapter-sdk/dist'
        directory.chmod(0o777)
        with self.assertRaises(HarnessOperationFailure):
            resolve_operation('codex', 'execute', str(self.root))
        directory.chmod(0o755)
        target = directory.with_name('original-dist')
        directory.rename(target)
        directory.symlink_to(target)
        with self.assertRaises(OSError):
            resolve_operation('codex', 'execute', str(self.root))


if __name__ == '__main__':
    unittest.main()
