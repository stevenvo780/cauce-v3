from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_container as container
import fleet_executor_start as start
from fleet_executor_policy import SafeFailure


class ManagedLeaseRetirement(unittest.TestCase):
    def setUp(self):
        self.policy = {'host_id': 'fixture-host', 'executor_user': 'fixture-owner'}
        self.agent = {'container_name': 'zz-canary-lease', 'runtime_key': 'fixture-runtime',
                      'tenant_id': 'fixture-tenant', 'alias': 'fixture-wire',
                      '_placement': {'ownership': 'managed', 'state_root': '/state'}}
        self.identity = 'a' * 64
        self.labels = container.expected_labels(self.policy, self.agent)
        self.observed = {'Id': self.identity, 'Config': {'Labels': self.labels.copy()}, 'Mounts': [
            {'Destination': '/state', 'Type': 'volume', 'Name': 'zz-canary-lease-state', 'RW': True}]}
        self.volume = {'Name': 'zz-canary-lease-state', 'Labels': self.labels.copy()}

    def arguments(self, *, users=None, volumes=None):
        with mock.patch.object(container, 'docker', side_effect=[
                json.dumps([self.volume] if volumes is None else volumes).encode(),
                (self.identity + '\n').encode() if users is None else users]) as docker:
            result = start.retirement_arguments(self.policy, self.agent, self.observed)
        self.assertEqual(docker.call_args_list, [
            mock.call('volume', 'inspect', 'zz-canary-lease-state'),
            mock.call('ps', '-a', '-q', '--no-trunc', '--filter', 'volume=zz-canary-lease-state')])
        return result

    def test_only_exclusive_managed_state_authorizes_retirement(self):
        self.assertEqual(self.arguments(), ['--retire-consumer-lease'])

    def test_shared_placement_never_authorizes_retirement(self):
        self.agent['_placement']['ownership'] = 'shared'
        with mock.patch.object(container, 'docker', side_effect=AssertionError('shared observation is forbidden')):
            self.assertEqual(start.retirement_arguments(self.policy, self.agent, {}), [])

    def test_another_container_including_stopped_or_short_identity_blocks(self):
        for users in (b'', b'b' * 64 + b'\n', (self.identity + '\n' + self.identity + '\n').encode(), b'a' * 12 + b'\n', b'\xff'):
            with self.subTest(users=users), self.assertRaises(SafeFailure):
                self.arguments(users=users)

    def test_rollback_volume_user_preserves_normal_start_without_retirement(self):
        self.assertEqual(self.arguments(users=(self.identity + '\n' + 'b' * 64 + '\n').encode()), [])

    def test_volume_owner_and_exact_observation_are_required(self):
        other = copy.deepcopy(self.volume)
        other['Labels']['cauce.fleet.tenant'] = 'other-tenant'
        renamed = {**self.volume, 'Name': 'another-state'}
        for volumes in ([], [self.volume, self.volume], [other], [renamed], [{}], ['invalid'], {}):
            with self.subTest(volumes=volumes), self.assertRaises(SafeFailure):
                self.arguments(volumes=volumes)

    def test_container_owner_mount_and_exact_id_are_required_before_docker(self):
        original = copy.deepcopy(self.observed)
        cases = [
            {**original, 'Id': 'a' * 12},
            {**original, 'Config': {'Labels': {}}},
            {**original, 'Mounts': []},
            {**original, 'Mounts': original['Mounts'] * 2},
        ]
        for field, value in (('Type', 'bind'), ('Name', 'another-state'), ('RW', False)):
            cases.append({**original, 'Mounts': [{**original['Mounts'][0], field: value}]})
        for observed in cases:
            with self.subTest(observed=observed), mock.patch.object(container, 'docker') as docker, self.assertRaises(SafeFailure):
                start.retirement_arguments(self.policy, self.agent, observed)
            docker.assert_not_called()

    def test_failed_or_malformed_observation_never_authorizes_retirement(self):
        for effect in (SafeFailure('Docker observation failed'), b'not-json'):
            with self.subTest(effect=effect), mock.patch.object(container, 'docker', side_effect=[effect]), self.assertRaises(SafeFailure):
                start.retirement_arguments(self.policy, self.agent, self.observed)


if __name__ == '__main__':
    unittest.main()
