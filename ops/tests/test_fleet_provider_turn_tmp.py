from __future__ import annotations

import contextlib
import importlib
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'
sys.path.insert(0, str(CLI))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_profiles as profiles  # noqa: E402
import fleet_provider_identity as identity  # noqa: E402


class SpaceTurnTemporaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-turn-tmp-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)

    def test_path_resolution_does_not_create_an_absent_computer_parent(self):
        state = self.root / 'computer-absent' / 'state'
        self.assertEqual(identity.space_turn_tmpdir(str(state)), str(state / 'space' / 'tmp'))
        self.assertFalse(state.parent.exists())

    def test_resolution_and_preparation_reject_noncanonical_state_paths(self):
        for state in ('relative', '/', str(self.root) + '/state/', str(self.root) + '//state',
                      str(self.root) + '/./state', str(self.root) + '/state/../other'):
            for action in (identity.space_turn_tmpdir, identity.prepare_space_turn_tmpdir):
                with self.subTest(state=state, action=action.__name__), self.assertRaises(ValueError):
                    action(state)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_explicit_preparation_creates_private_directories_and_is_idempotent(self):
        state = self.root / 'agent-state'
        state.mkdir(mode=0o700)
        previous_umask = os.umask(0o777)
        try:
            temporary = identity.prepare_space_turn_tmpdir(str(state))
        finally:
            os.umask(previous_umask)
        for directory in (state / 'space', pathlib.Path(temporary)):
            self.assertTrue(directory.is_dir())
            self.assertFalse(directory.is_symlink())
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        sentinel = pathlib.Path(temporary) / 'preserved'
        sentinel.write_text('owned')
        self.assertEqual(identity.prepare_space_turn_tmpdir(str(state)), temporary)
        self.assertEqual(sentinel.read_text(), 'owned')

    def test_preparation_rejects_symlinks_and_regular_files_without_touching_the_target(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        sentinel = outside / 'preserved'
        sentinel.write_text('owned')
        for component in ('space', 'tmp'):
            for kind in ('symlink', 'dangling', 'file'):
                with self.subTest(component=component, kind=kind):
                    state = self.root / (component + '-' + kind)
                    state.mkdir(mode=0o700)
                    if component == 'tmp':
                        (state / 'space').mkdir(mode=0o700)
                    candidate = state / 'space' if component == 'space' else state / 'space' / 'tmp'
                    if kind == 'file':
                        candidate.write_text('preserved')
                    else:
                        candidate.symlink_to(outside if kind == 'symlink' else self.root / 'absent', target_is_directory=True)
                    with self.assertRaises((OSError, ValueError)):
                        identity.prepare_space_turn_tmpdir(str(state))
                    self.assertEqual(sentinel.read_text(), 'owned')
                    self.assertEqual(list(outside.iterdir()), [sentinel])
                    self.assertTrue(candidate.is_symlink() if kind != 'file' else candidate.read_text() == 'preserved')

    def test_start_prepares_temp_in_the_agent_before_profile_and_computes_environment_without_host_state(self):
        for provider in ('grok', 'muse'):
            with self.subTest(provider=provider):
                self.assert_start_prepares_temp(provider)

    def assert_start_prepares_temp(self, provider):
        driver = importlib.import_module('fleet_provider_' + provider)
        computer_state = self.root / ('absent-computer-' + provider) / 'state'
        agent_volume = self.root / ('agent-volume-' + provider)
        agent_volume.mkdir(mode=0o700)
        agent = {'runtime_mode': 'container', 'harness_id': provider, 'runtime_key': 'physical', 'alias': 'nominal',
                 'tenant_id': 'Fixture', 'runtime_user': 'fixture', 'home_directory': '/home/fixture',
                 'state_directory': str(computer_state), '_placement': {'state_root': str(computer_state.parent),
                 'python': '/usr/bin/python3', 'ownership': 'managed'}}
        binding = {'provider': provider, 'runtime_user': 'fixture', 'path': str(self.root / 'profile'),
                   'command': '/usr/bin/python3', 'command_sha256': 'a' * 64}
        if provider == 'muse':
            binding['muse'] = {'bridge': '/usr/bin/python3', 'bridge_sha256': 'b' * 64}
        proof = {'container_id': 'a' * 64, 'generation': 'b' * 64, 'control': pathlib.Path('/run/cauce-fleet/physical')}
        events = []

        def helper(received_agent, received_proof, action, *arguments):
            self.assertIs(received_agent, agent)
            self.assertIs(received_proof, proof)
            if action == 'prepare-state':
                self.assertEqual(arguments[arguments.index('--uid') + 1], '1000')
                self.assertEqual(arguments[arguments.index('--gid') + 1], '1000')
                target = pathlib.Path(arguments[arguments.index('--state') + 1])
                destination = agent_volume / target.relative_to(computer_state)
                destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                events.append(('agent-prepare', str(target)))
            return b''

        def profile(*_, **__):
            self.assertFalse(computer_state.parent.exists())
            self.assertEqual((agent_volume / 'space' / 'tmp').stat().st_mode & 0o777, 0o700)
            events.append(('profile', provider))

        def environment(*_):
            values = driver.environment(binding, agent)
            self.assertEqual(values['TMPDIR'], str(computer_state / 'space' / 'tmp'))
            self.assertFalse(computer_state.parent.exists())
            events.append(('environment', provider))
            return values

        replacements = {'identity_for': mock.Mock(return_value=proof), 'user_identity': mock.Mock(return_value=('1000', '1000')),
            'process_proof': mock.Mock(side_effect=[container.SafeFailure('not running'), {'runtime_digest': 'c' * 64}]),
            'lifecycle_arguments': mock.Mock(return_value=[]), 'verify_executable': mock.Mock(), 'helper': helper,
            'pairing': mock.Mock(return_value=None), 'checked_command': mock.Mock(return_value=b''),
            'payload_for': mock.Mock(return_value={}), 'credential_environment': mock.Mock(return_value={}),
            'sdk_environment': mock.Mock(return_value={}), 'provider_environment': environment,
            'validate_sidecars': mock.Mock(return_value=[]), 'sidecar_shape': mock.Mock(return_value=([], {})),
            'adapter_environment': mock.Mock(return_value={}), 'docker': mock.Mock()}
        with contextlib.ExitStack() as stack:
            for name, replacement in replacements.items():
                stack.enter_context(mock.patch.object(container, name, replacement))
            stack.enter_context(mock.patch.object(profiles, 'prepare_profile', side_effect=profile))
            result = container.start_existing_adapter({}, agent, {}, {'directory': '/bundle', 'digest': 'sha256:' + 'd' * 64,
                'executable': '/usr/bin/python3', 'argv': []}, bootstrap=False)
        self.assertEqual(result, {'runtime_digest': 'c' * 64})
        self.assertLess(events.index(('agent-prepare', str(computer_state / 'space' / 'tmp'))), events.index(('profile', provider)))
        self.assertLess(events.index(('profile', provider)), events.index(('environment', provider)))
        self.assertFalse(computer_state.parent.exists())
        replacements['docker'].assert_called_once()


if __name__ == '__main__':
    unittest.main()
