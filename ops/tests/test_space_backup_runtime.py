from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import sys
import unittest
import uuid
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures

CLI = fixtures.OPS / 'cli/space_backup_runtime.py'
VALIDATE = fixtures.OPS / 'cli/space_backup_validate.py'


class SpaceBackupRuntimeTest(unittest.TestCase):
    save_policy = fixtures.PhysicalExecutorTest.save_policy

    def setUp(self):
        fixtures.PhysicalExecutorTest.setUp(self)
        self.home = pwd.getpwuid(os.geteuid()).pw_dir
        self.agent['home_directory'] = self.home
        self.policy['native'][0]['home_directory'] = self.home
        self.save_policy()
        self.state = pathlib.Path(self.agent['state_directory'])
        self.state.mkdir(mode=0o700)
        self.space = self.state / 'space'
        self.space.mkdir(mode=0o700)
        for name in ('context', 'directives', 'projects', 'config', 'data', 'logs', 'tmp'):
            (self.space / name).mkdir(mode=0o700)
        self.identity = {'company_id': 'company-x', 'tenant_id': self.agent['tenant_id'],
                         'alias': self.agent['alias'], 'runtime_key': self.agent['runtime_key']}
        (self.space / 'config/context-state.json').write_text(json.dumps(self.identity))
        (self.space / 'projects/work.txt').write_bytes(b'ordinary project data\n' * 5000)
        (self.space / 'context/mission.md').write_text('Synthetic mission for the disposable space.')
        (self.space / 'config/auth.json').symlink_to('/not-accessible/credential')
        (self.space / 'data/sessions.sqlite').write_bytes(b'synthetic confidential session')
        (self.space / 'logs/output.log').write_text('not backed up')
        fields = {'tenant_id', 'alias', 'runtime_key', 'host_id', 'harness_id', 'runtime_mode', 'container_name',
                  'runtime_user', 'home_directory', 'state_directory', 'systemd_user'}
        self.claim = {'id': str(uuid.uuid4()), 'claim_token': str(uuid.uuid4()), 'claim_epoch': 1,
                      'company_id': self.identity['company_id'], 'tenant_id': self.agent['tenant_id'],
                      'alias': self.agent['alias'], 'host_id': self.agent['host_id'],
                      'agent_snapshot': {'company_id': self.identity['company_id'], **{key: self.agent[key] for key in fields}},
                      'policy_sha256': hashlib.sha256(self.policy_file.read_bytes()).hexdigest()}

    def tearDown(self):
        self.temporary.cleanup()

    def invoke(self, action, claim=None, **fields):
        return subprocess.run([sys.executable, str(CLI), '--policy', str(self.policy_file)],
            input=json.dumps({'action': action, 'claim': self.claim if claim is None else claim, **fields}),
            text=True, capture_output=True, timeout=20)

    def exported(self):
        response = self.invoke('export')
        self.assertEqual(response.returncode, 0, response.stderr)
        return json.loads(response.stdout)

    def test_exact_owner_exports_manifest_and_chunks_with_secret_exclusions_and_no_repeated_write(self):
        receipt = self.exported()
        reconstructed = b''
        while len(reconstructed) < receipt['bytes']:
            result = self.invoke('read', offset=len(reconstructed))
            self.assertEqual(result.returncode, 0, result.stderr)
            chunk = json.loads(result.stdout)
            self.assertEqual(chunk['offset'], len(reconstructed))
            reconstructed += base64.b64decode(chunk['data'], validate=True)
        self.assertEqual(len(reconstructed), receipt['bytes'])
        self.assertEqual(hashlib.sha256(reconstructed).hexdigest(), receipt['sha256'])
        archive = self.state / f"space-backup-{self.claim['id']}-1.zip"
        before = archive.stat()
        self.assertEqual(self.exported(), receipt)
        self.assertEqual(archive.stat().st_mtime_ns, before.st_mtime_ns)
        with zipfile.ZipFile(archive) as zipped:
            manifest_raw = zipped.read('space-manifest.json')
            self.assertEqual(hashlib.sha256(manifest_raw).hexdigest(), receipt['manifest_sha256'])
            manifest = json.loads(manifest_raw)
            self.assertEqual(manifest['identity'], self.identity)
            self.assertEqual({item['path'] for item in manifest['omissions']}, {'config/auth.json', 'data/sessions.sqlite'})
            self.assertNotIn('logs/output.log', zipped.namelist())
            self.assertEqual(zipped.read('projects/work.txt'), (self.space / 'projects/work.txt').read_bytes())
        checked = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({'archive': str(archive),
            'identity': self.identity, 'manifest_sha256': receipt['manifest_sha256']}), capture_output=True, text=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(json.loads(checked.stdout), {'verified': True})
        self.assertEqual(self.invoke('remove').returncode, 0)
        self.assertFalse(archive.exists())

    def test_changed_policy_and_foreign_scope_or_placement_fail_before_export(self):
        for field, value in [('alias', 'different'), ('host_id', 'other-host')]:
            claim = copy.deepcopy(self.claim)
            claim[field] = value
            self.assertNotEqual(self.invoke('export', claim).returncode, 0)
        claim = copy.deepcopy(self.claim)
        claim['agent_snapshot']['state_directory'] = str(self.root / 'foreign-state')
        self.assertNotEqual(self.invoke('export', claim).returncode, 0)
        self.policy['hooks']['unused'] = {}
        self.save_policy()
        self.assertNotEqual(self.invoke('export').returncode, 0)
        self.assertFalse(list(self.state.glob('space-backup-*')))

    def test_symlink_or_group_writable_space_cannot_export(self):
        (self.space / 'projects/link').symlink_to(self.root)
        self.assertNotEqual(self.invoke('export').returncode, 0)
        (self.space / 'projects/link').unlink()
        self.space.chmod(0o770)
        self.assertNotEqual(self.invoke('export').returncode, 0)
        self.assertFalse(list(self.state.glob('space-backup-*')))

    def test_file_or_total_size_limit_is_explicit_and_removes_partial_archive(self):
        (self.space / 'projects/large.txt').write_bytes(b'x' * (16 * 1024 * 1024 + 1))
        result = self.invoke('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'error': 'LIMIT_EXCEEDED'})
        self.assertFalse(list(self.state.glob('space-backup-*')))
        (self.space / 'projects/large.txt').unlink()
        for name in ('a', 'b', 'c'):
            (self.space / 'data' / name).write_bytes(b'x' * (12 * 1024 * 1024))
        result = self.invoke('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'error': 'LIMIT_EXCEEDED'})
        self.assertFalse(list(self.state.glob('space-backup-*')))

    def test_foreign_context_manifest_and_tampered_private_archive_fail(self):
        (self.space / 'config/context-state.json').write_text(json.dumps({**self.identity, 'company_id': 'foreign'}))
        self.assertNotEqual(self.invoke('export').returncode, 0)
        (self.space / 'config/context-state.json').write_text(json.dumps(self.identity))
        self.exported()
        archive = self.state / f"space-backup-{self.claim['id']}-1.zip"
        archive.write_bytes(b'not an archive')
        self.assertNotEqual(self.invoke('export').returncode, 0)

    def test_input_commands_and_paths_are_closed_and_policy_symlinks_rejected(self):
        for action, extra in [('shell', {}), ('export', {'source': '/tmp/foreign'}), ('read', {'offset': -1})]:
            self.assertNotEqual(self.invoke(action, **extra).returncode, 0)
        copy_path = self.root / 'actual-policy.json'
        self.policy_file.rename(copy_path)
        self.policy_file.symlink_to(copy_path)
        self.assertNotEqual(self.invoke('export').returncode, 0)


class SpaceRootEnvironmentTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    tearDown = fixtures.PhysicalExecutorTest.tearDown
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer
    run_step = fixtures.PhysicalExecutorTest.run_step

    def test_approved_sdk_environment_derives_space_root_from_materialized_state(self):
        self.configure_signer()
        self.assertEqual(self.run_step('artifacts').returncode, 0)
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_runtime import sdk_environment
        environment = sdk_environment(self.policy, self.agent, True, self.context['operation_id'])
        self.assertEqual(environment['CAUCE_SPACE_ROOT'], self.agent['state_directory'] + '/space')


if __name__ == '__main__':
    unittest.main()
