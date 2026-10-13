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
        (self.space / 'data/.env').write_text('SYNTHETIC=1')
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
            text=True, capture_output=True, timeout=120)

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
            self.assertEqual({item['path'] for item in manifest['omissions']}, {'config/auth.json', 'data/.env'})
            self.assertIn('data/sessions.sqlite', zipped.namelist())
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

    def test_symlinks_are_declared_omissions_without_exporting_their_targets(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        payload = b'External target bytes must stay outside the space backup.\n'
        target = outside / 'outside-only.txt'
        target.write_bytes(payload)
        links = {'projects/link': self.root, 'projects/space-link': self.space,
                 'projects/outside-link': outside, 'data/outside-file-link': target}
        for path, destination in links.items():
            (self.space / path).symlink_to(destination)
        receipt = self.exported()
        archive = self.state / f"space-backup-{self.claim['id']}-1.zip"
        with zipfile.ZipFile(archive) as zipped:
            manifest_raw = zipped.read('space-manifest.json')
            self.assertEqual(hashlib.sha256(manifest_raw).hexdigest(), receipt['manifest_sha256'])
            manifest = json.loads(manifest_raw)
            self.assertEqual({item['path']: item['reason'] for item in manifest['omissions']},
                             {'config/auth.json': 'sensitive_path', 'data/.env': 'sensitive_path',
                              **{path: 'special_file' for path in links}})
            for path in links:
                self.assertFalse(any(name == path or name.startswith(path + '/') for name in zipped.namelist()), path)
            self.assertFalse(any(payload in zipped.read(item) for item in zipped.infolist()))
            self.assertEqual(zipped.read('projects/work.txt'), (self.space / 'projects/work.txt').read_bytes())

    def test_group_writable_space_cannot_export(self):
        self.space.chmod(0o770)
        self.assertNotEqual(self.invoke('export').returncode, 0)
        self.assertFalse(list(self.state.glob('space-backup-*')))

    def test_top_level_layout_symlink_aborts_export_without_backup_artifacts(self):
        projects = self.space / 'projects'
        outside = self.root / 'outside-projects'
        expected = (projects / 'work.txt').read_bytes()
        projects.rename(outside)
        projects.symlink_to(outside, target_is_directory=True)
        result = self.invoke('export')
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertFalse(list(self.state.glob('space-backup-*')))
        self.assertEqual((outside / 'work.txt').read_bytes(), expected)

    def test_file_or_total_size_limit_is_explicit_and_removes_partial_archive(self):
        with (self.space / 'projects/large.txt').open('wb') as output:
            output.truncate(128 * 1024 * 1024 + 1)
        result = self.invoke('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'error': 'LIMIT_EXCEEDED'})
        self.assertFalse(list(self.state.glob('space-backup-*')))
        (self.space / 'projects/large.txt').unlink()
        for index in range(9):
            with (self.space / 'data' / str(index)).open('wb') as output:
                output.truncate(128 * 1024 * 1024)
        result = self.invoke('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'error': 'LIMIT_EXCEEDED'})
        self.assertFalse(list(self.state.glob('space-backup-*')))

    def test_large_project_jsonl_exports_validates_and_restores_with_exact_bytes_and_manifest(self):
        source = self.space / 'data/project-leads.jsonl'
        line = b'{"source":"synthetic","lead":"fixture"}\n'
        block = line * (1024 * 1024 // len(line))
        expected_hash = hashlib.sha256()
        with source.open('wb') as output:
            for _ in range(97):
                output.write(block)
                expected_hash.update(block)
        size = source.stat().st_size
        self.assertGreaterEqual(size, 96 * 1024 * 1024)
        receipt = self.exported()
        self.assertGreater(receipt['bytes'], 32 * 1024 * 1024)
        archive = self.state / f"space-backup-{self.claim['id']}-1.zip"
        checked = subprocess.run([sys.executable, str(VALIDATE)], input=json.dumps({'archive': str(archive),
            'identity': self.identity, 'manifest_sha256': receipt['manifest_sha256']}), capture_output=True, text=True, timeout=120)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        last_offset = receipt['bytes'] - min(64 * 1024, receipt['bytes'])
        last = self.invoke('read', offset=last_offset)
        self.assertEqual(last.returncode, 0, last.stderr)
        self.assertEqual(len(base64.b64decode(json.loads(last.stdout)['data'], validate=True)), receipt['bytes'] - last_offset)
        destination = self.root / 'restored-large-space'
        arguments = [sys.executable, str(fixtures.OPS / 'cli/space_archive.py'), 'restore', '--archive', str(archive), '--directory', str(destination)]
        for field, value in self.identity.items():
            arguments.extend(['--' + field.replace('_', '-'), value])
        restored = subprocess.run(arguments, capture_output=True, text=True, timeout=120)
        self.assertEqual(restored.returncode, 0, restored.stderr)
        result = json.loads(restored.stdout)
        self.assertEqual(result['identity'], self.identity)
        self.assertEqual(result['manifest_sha256'], receipt['manifest_sha256'])
        target = destination / 'data/project-leads.jsonl'
        self.assertEqual(target.stat().st_size, size)
        actual_hash = hashlib.sha256()
        with target.open('rb') as incoming:
            while chunk := incoming.read(1024 * 1024):
                actual_hash.update(chunk)
        self.assertEqual(actual_hash.hexdigest(), expected_hash.hexdigest())
        self.assertFalse((destination / 'config/auth.json').exists())
        self.assertTrue((destination / 'data/sessions.sqlite').exists())
        self.assertFalse((destination / 'data/.env').exists())

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
