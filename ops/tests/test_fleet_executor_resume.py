from __future__ import annotations

import copy
import json
import pathlib
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
import fleet_executor_container as runtime  # noqa: E402
import fleet_executor_image as image  # noqa: E402
import fleet_executor_maintenance as maintenance  # noqa: E402
import fleet_executor_resume as resume  # noqa: E402
import fleet_executor_runtime as sdk  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402


class ResumeProofTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='h13b-resume-proof-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.bundle_root = self.root / 'release-b' / 'adapter'
        self.bin = self.bundle_root / 'src' / 'bin'
        self.bin.mkdir(parents=True)
        for entry in ('codex.js', 'shared-session.js'):
            (self.bin / entry).write_text('export {};\n')
        self.bundle = {'directory': str(self.bundle_root), 'argv': [str(self.bin / 'codex.js')],
                       'executable': '/usr/bin/node', 'shared_tui': True}
        self.policy = {'roots': {'state': str(self.root)}, 'host_id': 'host', 'executor_user': 'owner'}
        self.agent = {'runtime_key': 'canary-one', 'alias': 'wire_alias', 'tenant_id': 'tenant',
                      'runtime_mode': 'container', 'harness_id': 'codex', 'container_name': 'zz-canary-one',
                      'home_directory': '/home/dev', 'state_directory': '/state/canary-one',
                      'model_id': 'selected-model', 'reasoning_effort': 'high',
                      '_placement': {'image': 'sha256:' + 'b' * 64, 'state_root': '/state', 'profile_root': '/profiles'}}
        self.observed = {'Id': 'a' * 64, 'Mounts': [
            {'Type': 'volume', 'Name': self.agent['container_name'] + suffix, 'Destination': target, 'RW': True}
            for suffix, target in (('-state', '/state'), ('-provider-profiles', '/profiles'))]}
        labels = runtime.expected_labels(self.policy, self.agent)
        self.volumes = {row['Name']: {'Name': row['Name'], 'Labels': {**labels,
            **({'cauce.fleet.volume': 'provider-profiles'} if row['Destination'] == '/profiles' else {})}}
            for row in self.observed['Mounts']}
        self.binds = {'/cauce/executor': str(self.root / 'release-b' / 'cli'), str(self.bundle_root): str(self.bundle_root)}
        (self.root / 'release-b' / 'cli').mkdir()
        self.result = json.dumps({'resumable': True, 'fingerprint': 'c' * 64}).encode()
        self.calls = []
        self.run_error = None
        self.cleanup_error = False
        self.interrupt_run = False
        self.timeouts = []
        for patch in (mock.patch.object(runtime, 'docker', side_effect=self.docker),
                      mock.patch.object(runtime, 'checked_command', side_effect=self.command),
                      mock.patch.object(runtime, 'runtime_mounts', return_value=self.binds),
                      mock.patch.object(sdk, 'provider_base_environment', return_value={
                          'CODEX_HOME': '/profiles/canary-one/account', 'CAUCE_HARNESS_COMMAND': '/usr/bin/codex',
                          'CAUCE_HARNESS_COMMAND_SHA256': 'd' * 64, 'UNAPPROVED_TOKEN': 'must-not-propagate'})):
            patch.start()
            self.addCleanup(patch.stop)

    def docker(self, *arguments):
        self.calls.append(arguments)
        if arguments[0:2] == ('volume', 'inspect'):
            return json.dumps([self.volumes[arguments[2]]]).encode()
        if arguments[0] == 'run':
            pathlib.Path(arguments[arguments.index('--cidfile') + 1]).write_text('e' * 64 + '\n')
            if self.run_error is not None:
                raise self.run_error
            if self.interrupt_run:
                handler = signal.getsignal(signal.SIGTERM)
                self.assertTrue(callable(handler))
                handler(signal.SIGTERM, None)
            return self.result
        if arguments[0] == 'rm':
            if self.cleanup_error:
                raise SafeFailure('probe is still running')
            return b''
        if arguments[0] == 'ps':
            return b'e' * 64 if self.cleanup_error else b''
        raise AssertionError(arguments)

    def command(self, arguments, *, timeout):
        self.assertEqual(arguments[0], runtime.DOCKER)
        self.timeouts.append((arguments[1], timeout))
        return self.docker(*arguments[1:])

    def run_proof(self):
        return resume.resume_proof(self.policy, self.agent, self.observed, self.bundle, '1000', '1000')

    def test_current_sdk_uses_only_approved_release_and_readonly_runtime_volumes(self):
        self.assertEqual(self.run_proof(), {'resumable': True, 'fingerprint': 'c' * 64})
        run = next(call for call in self.calls if call[0] == 'run')
        for flag in ('--read-only', '--pull=never', '--rm'):
            self.assertIn(flag, run)
        for flag, value in (('--network', 'none'), ('--cap-drop', 'ALL'), ('--security-opt', 'no-new-privileges'),
                            ('--user', '1000:1000'), ('--entrypoint', '/usr/bin/env')):
            self.assertEqual(run[run.index(flag) + 1], value)
        self.assertIn(self.agent['_placement']['image'], run)
        self.assertTrue(run[run.index('--name') + 1].startswith('zz-canary-one-resume-'))
        self.assertIn(str(self.bin / 'shared-session.js'), run)
        self.assertIn('CAUCE_SHARED_SESSION_REQUIRE_RESUME=1', run)
        self.assertIn('CAUCE_MODEL_ID=selected-model', run)
        self.assertIn('CODEX_HOME=/profiles/canary-one/account', run)
        self.assertNotIn('UNAPPROVED_TOKEN=must-not-propagate', run)
        self.assertEqual([run[index + 1] for index, flag in enumerate(run) if flag == '--mount'], [
            'type=volume,source=zz-canary-one-state,destination=/state,readonly,volume-nocopy',
            'type=volume,source=zz-canary-one-provider-profiles,destination=/profiles,readonly,volume-nocopy'])
        self.assertEqual([run[index + 1] for index, flag in enumerate(run) if flag == '--volume'],
                         [f'{source}:{destination}:ro,z' for destination, source in self.binds.items()])
        self.assertEqual(self.calls[-1], ('rm', '-f', 'e' * 64))
        self.assertTrue(all(call[0] in {'volume', 'run', 'rm'} for call in self.calls))
        self.assertEqual(self.timeouts, [('run', 12), ('rm', 3)])

    def test_missing_current_entry_cannot_execute_previous_sdk(self):
        (self.bin / 'shared-session.js').unlink()
        with self.assertRaisesRegex(SafeFailure, 'current adapter bundle'):
            self.run_proof()
        self.assertEqual(self.calls, [])

    def test_missing_or_foreign_persistent_volume_never_launches_probe(self):
        for mutation in ('name', 'readonly', 'owner'):
            with self.subTest(mutation=mutation):
                observed = copy.deepcopy(self.observed)
                volumes = copy.deepcopy(self.volumes)
                if mutation == 'name':
                    observed['Mounts'][0]['Name'] = 'other-state'
                elif mutation == 'readonly':
                    observed['Mounts'][0]['RW'] = False
                else:
                    self.volumes['zz-canary-one-state']['Labels']['cauce.fleet.tenant'] = 'other'
                with self.assertRaises(SafeFailure):
                    resume.resume_proof(self.policy, self.agent, observed, self.bundle, 1000, 1000)
                self.volumes = volumes
        self.assertFalse(any(call[0] == 'run' for call in self.calls))

    def test_refused_and_malformed_sdk_results_fail_closed_and_cleanup(self):
        for result in ({'resumable': False, 'fingerprint': None}, {'resumable': True, 'fingerprint': 'bad'},
                       {'resumable': True, 'fingerprint': 'c' * 64, 'args': ['resume', 'identifier']}, [], None):
            with self.subTest(result=result):
                self.result = json.dumps(result).encode()
                with self.assertRaises(SafeFailure):
                    self.run_proof()
                self.assertEqual(self.calls[-1], ('rm', '-f', 'e' * 64))
        for result in (b'not JSON', b'x' * 4097):
            self.result = result
            with self.assertRaises(SafeFailure):
                self.run_proof()
            self.assertEqual(self.calls[-1], ('rm', '-f', 'e' * 64))

    def test_failed_sdk_launch_has_bounded_failure_and_owned_cleanup(self):
        self.run_error = SafeFailure('arbitrary CLI diagnostics')
        with self.assertRaisesRegex(SafeFailure, '^current SDK did not accredit an exact shared resume$'):
            self.run_proof()
        self.assertEqual(self.calls[-1], ('rm', '-f', 'e' * 64))

    def test_unconfirmed_cleanup_cannot_report_ready(self):
        self.cleanup_error = True
        with self.assertRaisesRegex(SafeFailure, 'cleanup is unverified'):
            self.run_proof()
        self.assertEqual(self.calls[-1], ('ps', '-aq', '--no-trunc', '--filter', 'id=' + 'e' * 64))

    def test_timeout_or_termination_always_cleanup_the_exact_probe(self):
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted):
                self.interrupt_run = interrupted
                self.run_error = None if interrupted else subprocess.TimeoutExpired('probe', 12)
                previous_handler = signal.getsignal(signal.SIGTERM)
                with self.assertRaises(SafeFailure):
                    self.run_proof()
                self.assertEqual(self.calls[-1], ('rm', '-f', 'e' * 64))
                self.assertIs(signal.getsignal(signal.SIGTERM), previous_handler)

    def test_root_uid_or_mutable_image_cannot_launch_probe(self):
        for uid, image_digest in ((0, 'sha256:' + 'b' * 64), ('unknown', 'sha256:' + 'b' * 64), (1000, 'mutable:latest')):
            self.agent['_placement']['image'] = image_digest
            with self.assertRaises(SafeFailure):
                resume.resume_proof(self.policy, self.agent, self.observed, self.bundle, uid, 1000)
        self.assertEqual(self.calls, [])

    def test_preflight_requires_exact_held_identity_before_running_current_sdk(self):
        packet = {'operation_id': 'operation', 'agent': {}, 'trusted_accounts': [], 'claim': {},
                  'expected_runtime': {'container_id': 'a' * 64, 'generation': 'f' * 64}}
        identity = {**packet['expected_runtime'], 'control': pathlib.Path('/run/control')}
        with mock.patch.object(maintenance, 'request_agent', return_value=self.agent) as request, \
                mock.patch.object(runtime, 'inspect_container', return_value=self.observed), \
                mock.patch.object(image, 'validate_previous', return_value=self.agent), \
                mock.patch.object(runtime, 'identity_for', return_value=identity), \
                mock.patch.object(runtime, 'user_identity', return_value=('1000', '1000')), \
                mock.patch.object(sdk, 'approved_bundle', return_value=self.bundle):
            self.assertEqual(resume.maintenance_resume_preflight(self.policy, packet)['resumable'], True)
            request.assert_called_with(self.policy, {key: value for key, value in packet.items() if key != 'expected_runtime'})
            self.calls.clear()
            packet['expected_runtime']['generation'] = '0' * 64
            with self.assertRaisesRegex(SafeFailure, 'held runtime changed'):
                resume.maintenance_resume_preflight(self.policy, packet)
            self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
