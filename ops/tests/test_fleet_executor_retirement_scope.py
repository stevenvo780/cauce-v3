from __future__ import annotations

import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_retirement as retirement  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402

TARGET = {'resource': 'agent', 'tenant_id': 'Steven', 'alias': 'drafted'}
DRAFT = {'tenant_id': 'Steven', 'alias': 'drafted', 'runtime_key': None, 'enabled': False, 'lifecycle_state': 'draft'}


def context(kind: str, previous: list[dict]) -> dict:
    return {'request': {'kind': kind, 'target': TARGET, 'parameters': {}}, 'previous_agents': previous,
            'fenced_targets': [TARGET], 'snapshot': {}, 'desired_memberships': []}


class ScopedAgentsDraftTest(unittest.TestCase):
    def test_create_ignores_an_adopted_registry_draft(self):
        placement = {'tenant_id': 'Steven', 'alias': 'drafted', 'runtime_key': 'drafted'}
        with mock.patch('fleet_executor_policy.target_agent', return_value=placement), \
                mock.patch.object(retirement, 'approve_agent', side_effect=lambda _policy, row: row) as approve:
            trusted = {**placement, '_trusted_accounts': [], '_trusted_accounts_present': False}
            self.assertEqual(retirement.scoped_agents({}, context('create', [DRAFT])), [trusted])
        approve.assert_called_once_with({}, trusted)

    def test_previous_rows_carry_the_operation_account_trust(self):
        row = {'tenant_id': 'Steven', 'alias': 'drafted', 'runtime_key': 'drafted', 'primary_account_id': 'acct'}
        accounts = [{'id': 'acct', 'payer_tenant_id': 'Steven', 'shared_with_pool': False}]
        with mock.patch.object(retirement, 'approve_agent', side_effect=lambda _policy, value: value):
            (agent,) = retirement.scoped_agents({}, {**context('start', [row]), 'trusted_accounts': accounts})
        self.assertEqual((agent['_trusted_accounts'], agent['_trusted_accounts_present']), (accounts, True))

    def test_other_kinds_still_approve_every_previous_agent(self):
        with mock.patch.object(retirement, 'approve_agent', side_effect=SafeFailure('no runtime')):
            with self.assertRaises(SafeFailure):
                retirement.scoped_agents({}, context('stop', [DRAFT]))


if __name__ == '__main__':
    unittest.main()
