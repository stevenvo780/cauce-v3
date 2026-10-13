from __future__ import annotations

import pathlib
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from fleet_executor_policy import SafeFailure, validate_payload  # noqa: E402


def payload(parameters, kind='purge', resource='agent'):
    target = {'resource': resource, 'tenant_id': 'A'}
    if resource == 'agent':
        target['alias'] = 'worker'
    elif resource == 'room':
        target['room_id'] = 'room'
    return {'operation_id': str(uuid.uuid4()), 'request': {
        'kind': kind, 'target': target, 'parameters': parameters,
        'expected_revision': 0, 'idempotency_key': 'purge-worker'},
        'fenced_targets': [], 'previous_agents': [], 'desired_memberships': []}


class PurgeConfirmationTest(unittest.TestCase):
    def test_confirmed_agent_purge_is_accepted_without_rewriting_the_request(self):
        document = payload({'confirm_alias': 'worker'})
        self.assertIs(validate_payload(document), document)
        self.assertEqual(document['request']['parameters'], {'confirm_alias': 'worker'})

    def test_legacy_agent_and_group_purges_keep_empty_parameters(self):
        for resource in ('agent', 'room', 'tenant'):
            with self.subTest(resource=resource):
                document = payload({}, resource=resource)
                self.assertIs(validate_payload(document), document)
                self.assertEqual(document['request']['parameters'], {})

    def test_confirmation_requires_exact_text_without_coercion_or_normalization(self):
        for alias in (None, 1, True, [], {}, '', 'other', 'Worker', ' worker', 'worker '):
            with self.subTest(alias=alias), self.assertRaises(SafeFailure):
                validate_payload(payload({'confirm_alias': alias}))

    def test_confirmation_does_not_allow_additional_agent_purge_parameters(self):
        for parameters in ({'command': ['true']}, {'confirm_alias': 'worker', 'force': True}):
            with self.subTest(parameters=parameters), self.assertRaises(SafeFailure):
                validate_payload(payload(parameters))

    def test_confirmation_is_rejected_for_other_actions_and_group_purges(self):
        for kind, resource in (('start', 'agent'), ('stop', 'agent'), ('retire', 'agent'),
                               ('restore', 'agent'), ('purge', 'room'), ('purge', 'tenant')):
            with self.subTest(kind=kind, resource=resource), self.assertRaises(SafeFailure):
                validate_payload(payload({'confirm_alias': 'worker'}, kind=kind, resource=resource))


if __name__ == '__main__':
    unittest.main()
