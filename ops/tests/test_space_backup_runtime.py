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
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import space_backup_local
import space_backup_runtime
import test_fleet_executor as fixtures
import test_fleet_executor_rebind as container_fixtures

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
        repeated = self.exported()
        self.assertEqual({key: value for key, value in repeated.items() if key != 'metrics'},
                         {key: value for key, value in receipt.items() if key != 'metrics'})
        self.assertGreater(receipt['metrics']['peak_rss_kib'], 0)
        self.assertGreater(repeated['metrics']['peak_rss_kib'], 0)
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
            output.truncate(space_backup_local.space_archive.MAX_FILE + 1)
        result = self.invoke('export')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'error': 'LIMIT_EXCEEDED'})
        self.assertFalse(list(self.state.glob('space-backup-*')))
        (self.space / 'projects/large.txt').unlink()
        for index in range(9):
            with (self.space / 'data' / str(index)).open('wb') as output:
                output.truncate(space_backup_local.space_archive.MAX_TOTAL // 8)
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

    def test_generation_and_policy_are_rechecked_after_each_container_action(self):
        policy = {**self.policy, 'containers': {}}
        agent = {**self.claim['agent_snapshot'], 'runtime_mode': 'container', '_placement': {'python': sys.executable}}
        first = {'container_id': 'a' * 64, 'generation': 'b' * 64}
        changed = {**first, 'generation': 'c' * 64}
        response = subprocess.CompletedProcess([], 0, stdout=b'{}', stderr=b'')
        for action in ('export', 'read', 'remove'):
            request = {'action': action, 'claim': self.claim, **({'offset': 0} if action == 'read' else {})}
            with self.subTest(action=action), mock.patch.object(space_backup_runtime, 'load_policy', return_value=policy), \
                    mock.patch.object(space_backup_runtime, 'approve_agent', return_value=agent), \
                    mock.patch.object(space_backup_runtime, 'read_container_binding', side_effect=[(agent, first), (agent, changed)]), \
                    mock.patch.object(space_backup_runtime.subprocess, 'run', return_value=response):
                with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'container was replaced'):
                    space_backup_runtime.execute(self.policy_file, request)
        def effect(*args, **kwargs):
            self.policy_file.write_bytes(self.policy_file.read_bytes() + b'\n')
            return response
        with mock.patch.object(space_backup_runtime, 'load_policy', return_value=policy), \
                mock.patch.object(space_backup_runtime, 'approve_agent', return_value=agent), \
                mock.patch.object(space_backup_runtime, 'read_container_binding', return_value=(agent, first)), \
                mock.patch.object(space_backup_runtime.subprocess, 'run', side_effect=effect):
            with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'policy changed before the receipt'):
                space_backup_runtime.execute(self.policy_file, {'action': 'export', 'claim': self.claim})


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


class SpaceBackupContainerTest(container_fixtures.ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.docker = container_fixtures.FakeDocker()
        patch = mock.patch.object(container_fixtures.container, 'docker', self.docker)
        patch.start()
        self.addCleanup(patch.stop)
        self.observed = self.docker.add(self.name, container_fixtures.container.expected_labels(self.policy, self.agent),
            self.mounts(self.new), running=True)
        self.observed['Image'] = 'sha256:' + 'e' * 64
        self.observed['Config']['Image'] = self.observed['Image']

    def test_previous_image_reads_current_or_trusted_previous_helpers_without_mutation(self):
        for release in (self.new, self.old):
            with self.subTest(release=release.name):
                self.observed['Mounts'] = self.mounts(release)
                approved, binding = space_backup_runtime.read_container_binding(self.policy, self.agent)
                self.assertEqual(approved['_placement']['image'], container_fixtures.IMAGE)
                self.assertEqual(binding['container_id'], self.observed['Id'])
                self.assertEqual(binding['generation'], hashlib.sha256(
                    (self.observed['Id'] + '\0' + self.observed['State']['StartedAt']).encode()).hexdigest())
        self.assertEqual([call[0] for call in self.docker.calls], ['ps', 'inspect', 'exec', 'ps', 'inspect', 'exec'])
        self.assertTrue(all('/usr/bin/getent' in call for call in self.docker.calls if call[0] == 'exec'))

    def test_mutable_or_mismatched_creation_image_fails_before_user_or_export(self):
        for image in ('cauce-agent:latest', 'sha256:' + 'f' * 64, None):
            with self.subTest(image=image):
                self.observed['Config']['Image'] = image
                with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'immutable matching digest'):
                    space_backup_runtime.read_container_binding(self.policy, self.agent)
        self.assertTrue(all(call[0] in {'ps', 'inspect'} for call in self.docker.calls))

    def test_foreign_ownership_isolation_and_mounts_still_fail(self):
        original = copy.deepcopy(self.observed)
        for key in original['Config']['Labels']:
            with self.subTest(label=key):
                self.observed['Config']['Labels'][key] = 'foreign'
                with self.assertRaises(space_backup_runtime.SafeFailure):
                    space_backup_runtime.read_container_binding(self.policy, self.agent)
                self.observed['Config']['Labels'] = copy.deepcopy(original['Config']['Labels'])
        for section, key, value in (('HostConfig', 'ReadonlyRootfs', False), ('HostConfig', 'Privileged', True)):
            with self.subTest(field=key):
                self.observed[section][key] = value
                with self.assertRaises(space_backup_runtime.SafeFailure):
                    space_backup_runtime.read_container_binding(self.policy, self.agent)
                self.observed[section][key] = original[section][key]
        for source in ('/var/tmp/foreign/ops/container-runtime', str(self.old / 'ops/container-runtime')):
            with self.subTest(source=source):
                next(row for row in self.observed['Mounts'] if row['Destination'] == '/cauce/lifecycle')['Source'] = source
                with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'mounts differ'):
                    space_backup_runtime.read_container_binding(self.policy, self.agent)
        self.observed['Mounts'] = self.mounts(self.old)
        (self.old / 'ops/container-runtime/cauce-container-runtime.py').chmod(0o666)
        with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'trusted'):
            space_backup_runtime.read_container_binding(self.policy, self.agent)

    def test_runtime_owner_and_stopped_generation_are_required(self):
        for row in (b'nobody:x:0:0:nobody:/nonexistent:/bin/false\n',
                    b'nobody:x:65534:65534:nobody:/foreign:/bin/false\n'):
            def docker(*arguments, passwd=row):
                return passwd if '/usr/bin/getent' in arguments else self.docker(*arguments)
            with self.subTest(passwd=row), mock.patch.object(container_fixtures.container, 'docker', side_effect=docker):
                with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'execution user or home'):
                    space_backup_runtime.read_container_binding(self.policy, self.agent)
        self.observed['State']['Running'] = False
        with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'not observed running'):
            space_backup_runtime.read_container_binding(self.policy, self.agent)


class LegacyContainerApprovalTest(unittest.TestCase):
    snapshot = {'company_id': 'company-x', 'tenant_id': 'Equipo_42', 'alias': 'legado', 'runtime_key': 'legado-rt',
                'host_id': 'host-x', 'harness_id': 'codex', 'runtime_mode': 'legacy-container',
                'container_name': 'ws-legado', 'runtime_user': 'dev', 'home_directory': None,
                'state_directory': '/home/dev/state/legado-rt', 'systemd_user': None}

    def test_sin_vinculacion_compartida_aprobada_no_hay_copia(self):
        with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'not approved'):
            space_backup_runtime.approve_legacy_container({'shared_containers': {}}, dict(self.snapshot))

    def test_con_vinculacion_aprobada_convierte_a_contenedor_y_rellena_desde_la_politica(self):
        policy = {'shared_containers': {'ws-legado': {'home_directory': '/home/dev', 'systemd_user': 'dev'}}}
        binding = {'container_id': 'a' * 64, 'generation': '1'}
        with mock.patch.object(space_backup_runtime, 'read_container_binding',
                               return_value=({'runtime_mode': 'container'}, binding)) as called:
            approved, result = space_backup_runtime.approve_legacy_container(policy, dict(self.snapshot))
        converted = called.call_args.args[1]
        self.assertEqual(converted['runtime_mode'], 'container')
        self.assertEqual(converted['home_directory'], '/home/dev')
        self.assertEqual(converted['systemd_user'], 'dev')
        self.assertEqual(converted['state_directory'], '/home/dev/state/legado-rt')
        self.assertEqual((approved, result), ({'runtime_mode': 'container'}, binding))

    def test_backup_only_generation_ignores_the_order_docker_lists_mounts_in(self):
        row = {'backup_only': True, 'runtime_user': 'dev', 'systemd_user': 'dev', 'home_directory': '/home/dev'}
        policy = {'host_id': 'host-x', 'shared_containers': {'ws-legado': row}}
        mounts = [{'Type': 'bind', 'Source': '/srv/a', 'Destination': '/workspace', 'RW': True},
                  {'Type': 'bind', 'Source': '/srv/b', 'Destination': '/home/dev/.claude', 'RW': True},
                  {'Type': 'volume', 'Source': '/srv/c', 'Destination': '/home/dev/.local', 'RW': True}]
        observed = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'RestartCount': 0, 'Mounts': mounts,
                    'HostConfig': {'Privileged': False, 'PidMode': '', 'CapAdd': []},
                    'State': {'Running': True, 'Pid': 17, 'StartedAt': 'generation-one'}}
        with mock.patch.object(container_fixtures.container, 'inspect_container', return_value=observed):
            approved, binding = space_backup_runtime.approve_legacy_container(policy, self.snapshot)
            observed['Mounts'] = list(reversed(mounts))
            self.assertEqual(space_backup_runtime.read_container_binding(policy, approved)[1], binding)
            observed['Mounts'] = [*mounts[:2], {**mounts[2], 'Source': '/srv/other'}]
            self.assertNotEqual(space_backup_runtime.read_container_binding(policy, approved)[1], binding)

    def test_backup_only_observes_identity_and_rejects_foreign_user_home_state_and_container_isolation(self):
        row = {'backup_only': True, 'runtime_user': 'dev', 'systemd_user': 'dev', 'home_directory': '/home/dev'}
        policy = {'host_id': 'host-x', 'shared_containers': {'ws-legado': row}}
        observed = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'RestartCount': 0, 'Mounts': [],
                    'HostConfig': {'Privileged': False, 'PidMode': '', 'CapAdd': []},
                    'State': {'Running': True, 'Pid': 17, 'StartedAt': 'generation-one'}}
        with mock.patch.object(container_fixtures.container, 'inspect_container', return_value=observed):
            approved, binding = space_backup_runtime.approve_legacy_container(policy, self.snapshot)
            self.assertEqual(approved['_placement']['ownership'], 'backup-only')
            self.assertEqual(binding['container_id'], observed['Id'])
            self.assertEqual(space_backup_runtime.read_container_binding(policy, approved)[1], binding)
            for field, value in [('host_id', 'foreign-host'), ('runtime_user', 'root'), ('home_directory', '/home/other'),
                                 ('state_directory', '/home/dev/state/sibling'), ('systemd_user', 'root')]:
                with self.subTest(field=field), self.assertRaises(space_backup_runtime.SafeFailure):
                    space_backup_runtime.approve_legacy_container(policy, {**self.snapshot, field: value})
            observed['State']['StartedAt'] = 'generation-two'
            self.assertNotEqual(space_backup_runtime.read_container_binding(policy, approved)[1], binding)
            observed['HostConfig']['Privileged'] = True
            with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'isolation differs'):
                space_backup_runtime.approve_legacy_container(policy, self.snapshot)
            observed['HostConfig'] = {'Privileged': True, 'PidMode': '', 'CapAdd': ['ALL']}
            privileged = {'shared_containers': {'ws-legado': {**row, 'privileged_container': True}}, 'host_id': 'host-x'}
            self.assertEqual(space_backup_runtime.approve_legacy_container(privileged, self.snapshot)[1]['container_id'], observed['Id'])
            observed['HostConfig']['PidMode'] = 'host'
            with self.assertRaisesRegex(space_backup_runtime.SafeFailure, 'isolation differs'):
                space_backup_runtime.approve_legacy_container(privileged, self.snapshot)
        import fleet_executor_legacy
        fleet_executor_legacy.validate_backup_container({**row, 'privileged_container': True})
        for value in (False, 'yes', None):
            with self.subTest(privileged_container=value), self.assertRaises(ValueError):
                fleet_executor_legacy.validate_backup_container({**row, 'privileged_container': value})


class SpaceBackupFailureTest(unittest.TestCase):
    def test_failure_diagnostics_redact_before_truncation_and_keep_closed_bounded_schema(self):
        private = ('-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY----- '
            'Bearer synthetic-value password="private value" token=synthetic-token '
            'https://private.invalid/credential?key=private C:\\private\\file /private/hidden '
            'private@example.invalid ' + 'x' * 500 + '/private/very-long-path/' + 'y' * 500)
        record = space_backup_local.failure_record('ValueError', 'useful reason\x00 ' + private, 'runtime')
        self.assertEqual(set(record), {'event', 'stage', 'cause_type', 'cause_message'})
        self.assertEqual(record['cause_type'], 'ValueError')
        self.assertTrue(record['cause_message'].startswith('useful reason'))
        for value in ('private-value', 'synthetic-value', 'private value', 'synthetic-token', 'private.invalid',
                      'C:\\private', '/private', 'private@example', 'x' * 33, 'y' * 33):
            self.assertNotIn(value, record['cause_message'])
        self.assertLessEqual(len(record['cause_message']), 384)
        self.assertLessEqual(len(json.dumps(record).encode()), 1024)
        unicode_record = space_backup_local.failure_record('Error', '\U0001f512' * 500, 'runtime')
        self.assertLessEqual(len(json.dumps(unicode_record).encode()), 1024)

    def test_local_diagnostics_propagate_without_raw_stderr_or_command_arguments(self):
        error = PermissionError(13, 'Permission denied', '/private/hidden')
        record = space_backup_local.exception_record(error, 'local')
        self.assertEqual(record['cause_message'], 'Permission denied')
        self.assertEqual(space_backup_runtime.local_failure(json.dumps(record).encode()), record)
        for raw in (b'raw stderr /private/hidden', json.dumps({**record, 'extra': 'private'}).encode(),
                    json.dumps({**record, 'stage': 'foreign'}).encode(), b'x' * 1025):
            self.assertIsNone(space_backup_runtime.local_failure(raw))
        for error in (subprocess.CalledProcessError(1, ['private-command'], stderr='private-stderr'),
                      subprocess.TimeoutExpired(['private-command'], 1), TimeoutError('private-timeout')):
            diagnostic = space_backup_local.exception_record(error, 'runtime')
            self.assertNotIn('private', diagnostic['cause_message'])
        with self.assertRaises(ValueError):
            space_backup_local.failure_record('Error', 'reason', 'foreign')


if __name__ == '__main__':
    unittest.main()
