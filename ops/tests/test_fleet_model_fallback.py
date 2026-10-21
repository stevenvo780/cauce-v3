from __future__ import annotations

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_policy as policy_module  # noqa: E402
import fleet_model_fallback as fallback  # noqa: E402
from fleet_policy_paths import SafeFailure  # noqa: E402

ROW = {'type': 'model_fallback', 'agent': 'operador-respaldo', 'model': 'muse-spark-1.3'}


def agent(harness: str = 'openclaw', alias: str = 'operador', row: dict | None = None) -> dict:
    return {'tenant_id': 'Praxis', 'alias': alias, 'harness_id': harness, 'runtime_mode': 'container',
            'reasoning_effort': 'high', 'extensions': [row or ROW], '_placement': {'python': '/usr/bin/python3'}}


class ModelFallbackPairingTest(unittest.TestCase):
    def test_both_sides_name_the_same_socket_volume(self):
        client = fallback.pairing(agent())
        server = fallback.pairing(agent('muse', 'operador-respaldo', {**ROW, 'agent': 'operador'}))
        self.assertEqual(client['volume'], server['volume'])
        self.assertRegex(client['volume'], r'^cauce-model-fallback-[0-9a-f]{32}$')
        self.assertEqual((client['server'], server['server']), (False, True))
        self.assertEqual((client['client'], client['server_alias']), ('operador', 'operador-respaldo'))

    def test_a_one_sided_or_foreign_tenant_declaration_names_another_volume(self):
        client = fallback.pairing(agent())['volume']
        self.assertNotEqual(client, fallback.pairing(agent('muse', 'operador-respaldo', {**ROW, 'agent': 'otro'}))['volume'])
        self.assertNotEqual(client, fallback.pairing({**agent(), 'tenant_id': 'Humanizar'})['volume'])

    def test_only_openclaw_and_muse_pair_and_never_with_themselves(self):
        for candidate in (agent('codex'), agent(alias='operador-respaldo'), {**agent(), 'extensions': [ROW, ROW]}):
            with self.assertRaises(SafeFailure):
                fallback.pairing(candidate)
        for row in ({**ROW, 'model': 'meta/muse'}, {**ROW, 'agent': 'Upper'}, {**ROW, 'extra': 1}, {'type': 'model_fallback'}):
            with self.assertRaises(SafeFailure):
                fallback.pairing(agent(row=row))
        self.assertIsNone(fallback.pairing({**agent(), 'extensions': []}))

    def test_the_server_carries_nothing_a_model_step_could_trigger(self):
        server = agent('muse', 'operador-respaldo', {**ROW, 'agent': 'operador'})
        self.assertTrue(fallback.pairing({**server, 'extensions': [*server['extensions'], {'type': 'resources', 'pids': 256}]})['server'])
        for extra in ({'type': 'mcp', 'name': 'crm', 'command': '/bin/crm', 'args': [], 'env': []}, {'type': 'ssh', 'hosts': ['u@h']},
                      {'type': 'docker', 'access': 'read'}, {'type': 'full_control'}):
            with self.assertRaisesRegex(SafeFailure, 'only admits the resources'):
                fallback.pairing({**server, 'extensions': [*server['extensions'], extra]})
        self.assertFalse(fallback.pairing({**agent(), 'extensions': [ROW, {'type': 'ssh', 'hosts': ['u@h']}]})['server'])

    def test_only_the_server_runs_the_bridge_from_its_adapter(self):
        self.assertEqual(fallback.adapter_environment(agent()), {})
        served = fallback.adapter_environment(agent('muse', 'operador-respaldo', {**ROW, 'agent': 'operador'}))
        self.assertEqual(json.loads(served['CAUCE_MODEL_FALLBACK_SERVE']), ['/usr/bin/python3', '-I', '-B',
            '/cauce/executor/model_fallback.py', 'serve', '--socket', '/cauce/model-fallback/muse.sock', '--model', 'muse-spark-1.3'])
        self.assertEqual(fallback.client_arguments(agent())[-2:], ['--reasoning-effort', 'high'])
        self.assertNotIn('--reasoning-effort', fallback.client_arguments({**agent(), 'reasoning_effort': None}))


class ModelFallbackPolicyTest(unittest.TestCase):
    def policy(self, types):
        return {'extensions_allowed': {'types': types, 'mount_roots': [], 'networks': []}}

    def test_the_computer_must_admit_it_and_the_executor_checks_the_pair(self):
        self.assertEqual(policy_module.agent_extensions(agent()), [ROW])
        with self.assertRaisesRegex(SafeFailure, 'not allowed by host policy'):
            policy_module.approve_extensions(self.policy([]), agent())
        self.assertEqual(policy_module.approve_extensions(self.policy(['model_fallback']), agent()), [ROW])
        with self.assertRaisesRegex(SafeFailure, 'OpenClaw client or its Muse server'):
            policy_module.approve_extensions(self.policy(['model_fallback']), agent('grok'))
        with self.assertRaises(SafeFailure):
            policy_module.agent_extensions({**agent(), 'extensions': [{**ROW, 'command': '/bin/sh'}]})


if __name__ == '__main__':
    unittest.main()
