from __future__ import annotations

import contextlib
import copy
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'))
import fleet_executor_container as container
import fleet_executor_image as image
import fleet_executor_replacement as replacement
from fleet_executor_policy import SafeFailure


class ReplacementRetirementTest(unittest.TestCase):
    def setUp(self):
        self.policy = {'host_id': 'host', 'executor_user': 'executor'}
        self.agent = {'tenant_id': 'Tenant', 'alias': 'agent', 'runtime_key': 'physical', 'host_id': 'host',
                      'container_name': 'old-agent', 'runtime_mode': 'container', '_placement': {}}
        self.observed = {'Id': 'a' * 64, 'Created': 'created', 'Name': '/old-agent', 'Image': 'sha256:' + 'b' * 64,
                         'Config': {'Labels': {'owner': 'executor'}}, 'HostConfig': {}, 'Mounts': [],
                         'State': {'Running': True, 'Pid': 42, 'StartedAt': 'started'}}
        self.volumes = [{'name': 'old-agent-state', 'created_at': 'created', 'identity_sha256': 'c' * 64}]
        self.calls = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(replacement, 'approve_agent', side_effect=lambda policy, agent: agent))
        self.stack.enter_context(mock.patch.object(container, 'inspect_container', side_effect=lambda name: self.observed))
        self.stack.enter_context(mock.patch.object(container, 'validate_container'))
        self.stack.enter_context(mock.patch.object(replacement, 'volume_pins', side_effect=lambda *args: copy.deepcopy(self.volumes)))
        self.stack.enter_context(mock.patch.object(container, 'docker', side_effect=self.docker))
        self.stack.enter_context(mock.patch.object(image, 'image_guard', side_effect=lambda identity: contextlib.nullcontext()))
        self.login_check = self.stack.enter_context(mock.patch.object(image, 'assert_no_login'))

    def docker(self, *arguments):
        self.calls.append(arguments)
        if arguments[0] == 'ps':
            return b'' if self.observed is None else self.observed['Id'].encode()
        if arguments[0] == 'stop':
            self.observed['State'].update(Running=False, Pid=0)
        elif arguments[0] == 'rm':
            self.assertFalse(self.observed['State']['Running'])
            self.observed = None
        else:
            self.fail('unexpected Docker mutation: ' + json.dumps(arguments))
        return b''

    def authorized(self):
        receipt = replacement.capture_previous(self.policy, self.agent)
        receipt['replacement'] = {'agent': {'container_name': 'new-agent'}, 'pin': {'container_id': 'd' * 64, 'started_at': 'new-started'},
                                  'normal_verified': True, 'operation_id': '00000000-0000-4000-8000-000000000001',
                                  'runtime_digest': 'f' * 64}
        receipt['confirmed_operation'] = {'operation_id': receipt['replacement']['operation_id'], 'status': 'succeeded',
            'runtime_digest': receipt['replacement']['runtime_digest'], 'container_id': 'd' * 64, 'started_at': 'new-started'}
        self.stack.enter_context(mock.patch.object(replacement, 'authorize_replacement', side_effect=lambda policy, agent, receipt, proof: copy.deepcopy(receipt)))
        return receipt

    def test_preflight_is_read_only_and_preserves_persistent_volumes(self):
        receipt = container.retire_replaced_container(self.policy, self.agent)
        self.assertEqual(receipt['retention'], replacement.RETENTION)
        self.assertEqual(receipt['volumes'], self.volumes)
        self.assertEqual(self.calls, [])

    def test_shared_container_is_never_retired(self):
        self.agent['_placement']['ownership'] = 'shared'
        with self.assertRaisesRegex(SafeFailure, 'dedicated'):
            replacement.capture_previous(self.policy, self.agent)
        self.assertEqual(self.calls, [])

    def test_missing_normal_roundtrip_cannot_remove_original(self):
        receipt = replacement.capture_previous(self.policy, self.agent)
        with self.assertRaisesRegex(SafeFailure, 'normal runtime verification'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def test_replaced_name_with_foreign_id_is_not_touched(self):
        receipt = self.authorized()
        self.observed['Id'] = 'e' * 64
        with self.assertRaisesRegex(SafeFailure, 'identity changed'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def test_changed_labels_mounts_or_generation_are_not_touched(self):
        for field, value in [('Config', {'Labels': {'owner': 'other'}}), ('Mounts', [{'Source': '/foreign'}]),
                             ('State', {'Running': True, 'Pid': 42, 'StartedAt': 'restarted'})]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.observed)
                receipt = self.authorized()
                self.observed[field] = value
                with self.assertRaisesRegex(SafeFailure, 'identity changed'):
                    container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
                self.assertEqual(self.calls, [])
                self.observed = original

    def test_changed_volume_identity_is_not_touched(self):
        receipt = self.authorized()
        self.volumes[0]['created_at'] = 'replaced'
        with self.assertRaisesRegex(SafeFailure, 'volume identity changed'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def test_unconfirmed_or_wrong_operation_cannot_remove_original(self):
        receipt = self.authorized()
        for commit in (None, {**receipt['confirmed_operation'], 'status': 'cancelling'},
                       {**receipt['confirmed_operation'], 'container_id': 'e' * 64}):
            with self.subTest(commit=commit):
                receipt['confirmed_operation'] = commit
                with self.assertRaisesRegex(SafeFailure, 'confirmed operation'):
                    container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
                self.assertEqual(self.calls, [])

    def test_pending_login_keeps_original_and_volumes(self):
        receipt = self.authorized()
        self.login_check.side_effect = SafeFailure('provider login session is open or unverified')
        with self.assertRaisesRegex(SafeFailure, 'login session'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])
        self.assertTrue(self.observed['State']['Running'])

    def test_stop_remove_uses_pinned_id_without_deleting_volumes_and_retries(self):
        receipt = self.authorized()
        completed = container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        mutations = [call for call in self.calls if call[0] != 'ps']
        self.assertEqual(mutations, [('stop', '--time', '15', 'a' * 64), ('rm', 'a' * 64)])
        self.assertEqual(completed['volumes'], self.volumes)
        self.assertIs(completed['complete'], True)
        self.assertEqual(container.retire_replaced_container(self.policy, self.agent, completed, apply=True), completed)


if __name__ == '__main__':
    unittest.main()
