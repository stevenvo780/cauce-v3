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
        with self.assertRaisesRegex(SafeFailure, '^shared terminal has no exact Codex conversation to resume$') as raised:
            current.stop()
        self.assertEqual(self.events, [])
        self.assertNotIn('stopped', current.journal)
        self.assertNotIn('shared_resume_accredited', current.journal)
        self.assertIs(current.journal['shared_resume_refused'], True)
        self.assertEqual(current.journal['previous_adapter_state'], {'owned-runtime': {'adapter_running': True}})
        self.assertEqual(cli.fleet_failure_reason(raised.exception), 'shared_conversation_unaccredited')

    def test_updates_that_need_no_exact_codex_resume_are_not_probed(self):
        cases = {'selection_changed': {'_require_shared_resume': False}, 'claude': {'harness_id': 'claude'},
                 'native': {'runtime_mode': 'native'}, 'shared_container': {'_placement': {'ownership': 'shared'}}}
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

    def test_a_container_that_is_absent_or_stopped_is_left_to_the_runtime_step(self):
        for observed in (None, {'Id': 'a' * 64, 'State': {'Running': False}}):
            with self.subTest(observed=observed):
                self.observed = observed
                self.context['operation_id'] = str(uuid.uuid4())
                self.assertFalse(update_resume.assert_update_resumes(self.policy, self.desired))
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
        for target, name, options in ((update_resume, 'approve_agent', {'side_effect': lambda _policy, row: row}),
                                      (container, 'inspect_container', {'side_effect': lambda _name: self.observed}),
                                      (container, 'adapter_restart_state', {'side_effect': lambda *_: self.current}),
                                      (container, 'identity_for', {'return_value': {'container_id': 'a' * 64}}),
                                      (image, 'validate_previous', {'side_effect': lambda _policy, agent, _observed: agent}),
                                      (runtime, 'approved_bundle', {'return_value': {'digest': 'd' * 64}})):
            patcher = mock.patch.object(target, name, **options)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.proof = mock.patch.object(container, 'process_proof', return_value={'runtime_digest': 'e' * 64}).start()
        self.addCleanup(mock.patch.stopall)

    def test_the_same_running_adapter_is_kept_and_accredited_without_a_relaunch(self):
        self.assertEqual(update_resume.untouched_restoration(self.executor, self.agent), {'runtime_digest': 'e' * 64})
        self.assertEqual(self.proof.call_args.args[1:], (self.agent, {'container_id': 'a' * 64}, {'digest': 'd' * 64}))

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


if __name__ == '__main__':
    unittest.main()
