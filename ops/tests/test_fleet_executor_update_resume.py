from __future__ import annotations

import copy
import importlib.util
import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest import mock

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'
sys.path.insert(0, str(CLI))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_image as image  # noqa: E402
import fleet_executor_rebind as rebind  # noqa: E402
import fleet_executor_resume as resume  # noqa: E402
import fleet_executor_runtime as runtime  # noqa: E402
import fleet_executor_steps as steps  # noqa: E402
import fleet_executor_update_resume as update_resume  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402

specification = importlib.util.spec_from_file_location('fleet_executor_cli', CLI / 'fleet-executor.py')
assert specification is not None and specification.loader is not None
cli = importlib.util.module_from_spec(specification)
specification.loader.exec_module(cli)


class UpdateResumePreflightTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-update-resume-')
        self.addCleanup(temporary.cleanup)
        state = pathlib.Path(temporary.name) / 'state'
        state.mkdir(mode=0o700)
        self.policy = {'roots': {'state': str(state)}, 'bundles': {'codex': {'shared_tui': True}}}
        self.previous = {'tenant_id': 'OwnedTenant', 'alias': 'owned', 'runtime_key': 'owned-runtime',
            'harness_id': 'codex', 'runtime_mode': 'container', 'host_id': 'owned-host',
            'container_name': 'owned-container', 'runtime_user': 'cauce', 'home_directory': '/home/cauce',
            'state_directory': '/home/cauce/.cauce/owned-runtime', 'model_id': 'gpt-5.5',
            'reasoning_effort': 'medium', 'extensions': []}
        self.base = {**copy.deepcopy(self.previous), '_require_shared_resume': True, '_placement': {'image': 'sha256:' + 'b' * 64}}
        self.desired = copy.deepcopy(self.base)
        self.context = {'operation_id': str(uuid.uuid4()), 'request': {'kind': 'update',
            'target': {'resource': 'agent', 'tenant_id': 'OwnedTenant', 'alias': 'owned'},
            'parameters': {}}, 'previous_agents': [self.previous], 'desired_memberships': [],
            'fenced_targets': [{'resource': 'agent', 'tenant_id': 'OwnedTenant', 'alias': 'owned'}]}
        self.events = []
        self.observed = {'Id': 'a' * 64, 'State': {'Running': True}}
        self.patch(steps, 'stop', side_effect=lambda *_: self.events.append('adapter_stop'))
        self.patch(steps.Executor, 'close_previous_tui', side_effect=lambda *_args, **_options: None)
        self.patch(steps, 'scoped_agents', side_effect=lambda *_: [self.previous])
        self.patch(steps, 'approve_agent', side_effect=lambda _policy, row: row)
        self.patch(container, 'inspect_container', side_effect=lambda _name: self.observed)
        self.patch(container, 'adapter_restart_state', return_value={'adapter_running': True})
        self.patch(container, 'identity_for', return_value={'container_id': 'a' * 64})
        self.patch(container, 'user_identity', return_value=('1500', '1500'))
        self.patch(image, 'validate_previous', side_effect=lambda _policy, agent, _observed: agent)
        self.patch(runtime, 'approved_bundle', return_value={'directory': '/bundle'})
        self.proof = self.patch(resume, 'resume_proof', side_effect=lambda *_: (self.events.append('resume_proof'),
            {'resumable': True, 'fingerprint': 'c' * 64})[1])
        self.launch = self.patch(resume, 'launch_proof', side_effect=lambda *_: (self.events.append('launch_proof'),
            {'launchable': True, 'resumed': False})[1])

    def patch(self, target, name, **options):
        patcher = mock.patch.object(target, name, **options)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def executor(self):
        executor = steps.Executor(self.policy, self.context)
        executor.agent = mock.Mock(side_effect=lambda: self.desired)
        return executor

    def test_an_update_that_must_resume_is_accredited_before_anything_stops(self):
        current = self.executor()
        self.assertEqual(current.stop(), {'stopped_verified': True})
        self.assertEqual(self.events, ['resume_proof', 'adapter_stop'])
        args = self.proof.call_args.args
        self.assertEqual((args[1], args[2], args[4], args[5]), (self.desired, self.observed, '1500', '1500'))
        self.assertIs(current.journal['shared_resume_accredited'], True)
        self.executor().stop()
        self.assertEqual(self.events, ['resume_proof', 'adapter_stop', 'adapter_stop'])

    def test_an_unaccredited_conversation_refuses_the_update_without_stopping_the_running_adapter(self):
        self.proof.side_effect = SafeFailure('current SDK did not accredit an exact shared resume')
        current = self.executor()
        with self.assertRaisesRegex(SafeFailure, '^shared terminal has no accredited conversation to continue$') as raised:
            current.stop()
        self.assertEqual(self.events, [])
        self.assertNotIn('stopped', current.journal)
        self.assertNotIn('shared_resume_accredited', current.journal)
        self.assertIs(current.journal['shared_resume_refused'], True)
        self.assertEqual(current.journal['previous_adapter_state'], {'owned-runtime': {'adapter_running': True}})
        self.assertEqual(cli.fleet_failure_reason(raised.exception), 'shared_conversation_unaccredited')

    def test_a_model_change_proves_the_shared_terminal_can_start_before_anything_stops(self):
        self.desired = {**self.base, '_require_shared_resume': False, 'model_id': 'gpt-6'}
        current = self.executor()
        self.assertEqual(current.stop(), {'stopped_verified': True})
        self.assertEqual(self.events, ['launch_proof', 'adapter_stop'])
        args = self.launch.call_args.args
        self.assertEqual((args[1], args[2], args[4], args[5], args[6]),
                         (self.desired, self.observed, '1500', '1500', self.context['operation_id']))
        self.proof.assert_not_called()
        self.assertIs(current.journal['shared_resume_accredited'], True)

    def test_a_model_change_whose_terminal_cannot_start_is_refused_before_the_adapter_stops(self):
        self.desired = {**self.base, '_require_shared_resume': False, 'model_id': 'gpt-6'}
        self.launch.side_effect = SafeFailure('current SDK did not accredit a shared terminal launch')
        current = self.executor()
        with self.assertRaisesRegex(SafeFailure, '^shared terminal has no accredited conversation to continue$') as raised:
            current.stop()
        self.assertEqual(self.events, [])
        self.assertIs(current.journal['shared_resume_refused'], True)
        self.assertEqual(cli.fleet_failure_reason(raised.exception), 'shared_conversation_unaccredited')

    def test_every_shared_terminal_harness_is_proved_before_its_update_stops_it(self):
        for harness in ('claude', 'grok', 'muse'):
            for change, proof in (({}, 'resume_proof'), ({'_require_shared_resume': False, 'reasoning_effort': 'high'}, 'launch_proof')):
                with self.subTest(harness=harness, proof=proof):
                    self.events.clear()
                    self.policy['bundles'][harness] = {'shared_tui': True}
                    self.previous['harness_id'] = harness
                    self.context['operation_id'] = str(uuid.uuid4())
                    self.desired = {**self.base, 'harness_id': harness, **change}
                    self.executor().stop()
                    self.assertEqual(self.events, [proof, 'adapter_stop'])

    def test_updates_without_a_dedicated_shared_terminal_of_the_same_harness_are_not_probed(self):
        self.policy['bundles']['claude'] = {'shared_tui': True}
        launch = {'_require_shared_resume': False}
        cases = {'harness_changed': {**launch, 'harness_id': 'claude'},
                 'native': {'runtime_mode': 'native'}, 'shared_container': {'_placement': {'ownership': 'shared'}},
                 'without_shared_terminal': {'harness_id': 'openclaw'}}
        for name, change in cases.items():
            with self.subTest(name=name):
                self.context['operation_id'] = str(uuid.uuid4())
                self.desired = {**self.base, **change}
                self.executor().stop()
        self.desired = copy.deepcopy(self.base)
        self.policy['bundles']['codex']['shared_tui'] = False
        self.context['operation_id'] = str(uuid.uuid4())
        self.executor().stop()
        self.proof.assert_not_called()
        self.launch.assert_not_called()
        self.policy['bundles']['codex']['shared_tui'] = True
        for field in ('runtime_key', 'container_name'):
            with self.subTest(moved=field):
                self.assertIsNone(update_resume.proof_mode(self.policy, {**self.base, **launch, field: 'moved'}, [self.previous]))
        self.assertIsNone(update_resume.proof_mode(self.policy, {**self.base, **launch}, [self.previous, self.previous]))
        self.assertEqual(update_resume.proof_mode(self.policy, {**self.base, **launch}, [self.previous]), 'launch')

    def test_a_container_that_is_absent_or_stopped_is_left_to_the_runtime_step(self):
        for observed in (None, {'Id': 'a' * 64, 'State': {'Running': False}}):
            with self.subTest(observed=observed):
                self.observed = observed
                self.assertFalse(update_resume.assert_update_resumes(self.policy, self.desired, [self.previous], str(uuid.uuid4())))
        self.proof.assert_not_called()


class UntouchedRestorationTest(unittest.TestCase):
    def setUp(self):
        self.agent = {'runtime_key': 'owned-runtime', 'container_name': 'owned-container'}
        self.state = {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': str(uuid.uuid4()),
                      'adapter_bundle_digest': 'd' * 64}
        self.journal = {'shared_resume_refused': True, 'previous_adapter_state': {'owned-runtime': dict(self.state)}}
        self.executor = mock.Mock(policy={'host_id': 'owned-host'}, journal=self.journal)
        self.observed = {'Id': 'a' * 64, 'State': {'Running': True}}
        self.current = dict(self.state)
        self.bundle = {'digest': 'd' * 64}
        for target, name, options in ((update_resume, 'approve_agent', {'side_effect': lambda _policy, row: row}),
                                      (container, 'inspect_container', {'side_effect': lambda _name: self.observed}),
                                      (container, 'adapter_restart_state', {'side_effect': lambda *_: self.current}),
                                      (container, 'identity_for', {'return_value': {'container_id': 'a' * 64}}),
                                      (image, 'validate_previous', {'side_effect': lambda _policy, agent, _observed: agent}),
                                      (runtime, 'approved_bundle', {'side_effect': lambda *_: self.bundle})):
            patcher = mock.patch.object(target, name, **options)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.proof = mock.patch.object(container, 'process_proof', return_value={'runtime_digest': 'e' * 64}).start()
        self.addCleanup(mock.patch.stopall)

    def test_the_same_running_adapter_is_kept_and_accredited_without_a_relaunch(self):
        self.assertEqual(update_resume.untouched_restoration(self.executor, self.agent), {'runtime_digest': 'e' * 64})
        self.assertEqual(self.proof.call_args.args[1:], (self.agent, {'container_id': 'a' * 64}, {'digest': 'd' * 64}))
        self.bundle = {'digest': 'f' * 64, 'directory': '/release/adapter', 'executable_sha256': None}
        with mock.patch.object(rebind, 'bound_release', return_value=None):
            self.assertIsNone(update_resume.untouched_restoration(self.executor, self.agent))

    def test_anything_else_falls_back_to_the_ordinary_restoration(self):
        cases = {'not_refused': lambda: self.journal.pop('shared_resume_refused'),
                 'stopped': lambda: self.journal.update(stopped=True),
                 'recorded_stopped': lambda: self.journal['previous_adapter_state']['owned-runtime'].update(adapter_running=False),
                 'another_process': lambda: self.current.update(adapter_operation_id=str(uuid.uuid4())),
                 'container_stopped': lambda: self.observed['State'].update(Running=False),
                 'proof_refused': lambda: setattr(self.proof, 'side_effect', SafeFailure('container process identity differs'))}
        for name, change in cases.items():
            with self.subTest(name=name):
                self.setUp()
                change()
                self.assertIsNone(update_resume.untouched_restoration(self.executor, self.agent))

    def test_a_refused_update_that_changed_release_keeps_the_adapter_of_its_bound_release(self):
        release = pathlib.Path('/opt/cauce/releases/new')
        self.bundle.update(directory=str(release / 'adapter'), digest='f' * 64, executable_sha256=None)
        with mock.patch.object(container, 'RELEASE_ROOT', release), \
                mock.patch.object(rebind, 'bound_release', return_value=pathlib.Path('/opt/cauce/releases/old')) as bound:
            self.assertEqual(update_resume.untouched_restoration(self.executor, self.agent), {'runtime_digest': 'e' * 64})
            self.assertEqual(bound.call_args.args, (self.observed, release))
            self.assertEqual(self.proof.call_args.args[3], {'directory': '/opt/cauce/releases/old/adapter', 'digest': 'd' * 64,
                                                            'executable_sha256': None})
            bound.return_value = None
            self.assertIsNone(update_resume.untouched_restoration(self.executor, self.agent))


if __name__ == '__main__':
    unittest.main()
