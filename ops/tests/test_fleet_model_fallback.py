from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_policy as policy_module  # noqa: E402
import fleet_model_fallback as fallback  # noqa: E402
from fleet_policy_paths import SafeFailure  # noqa: E402
from test_fleet_executor_rebind import FakeDocker, ReleaseFixture  # noqa: E402

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

    def test_the_client_cannot_reach_the_server_profile_through_docker(self):
        for extra in ({'type': 'docker', 'access': 'read'}, {'type': 'docker', 'access': 'control'}, {'type': 'full_control'}):
            with self.assertRaisesRegex(SafeFailure, 'docker or full_control'):
                fallback.pairing({**agent(), 'extensions': [ROW, extra]})

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



class VolumeDocker(FakeDocker):
    def __call__(self, *arguments):
        if arguments[:2] == ('volume', 'rm'):
            self.calls.append(arguments)
            del self.volumes[arguments[2]]
            return b''
        return super().__call__(*arguments)


class ModelFallbackContainerShapeTest(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.docker = VolumeDocker()
        patch = mock.patch.object(container, 'docker', self.docker)
        patch.start()
        self.addCleanup(patch.stop)
        placement = self.policy['containers'].pop(self.name)
        bundle = self.policy['bundles'].pop('codex')
        self.policy['bundles'].update(openclaw=bundle, muse=copy.deepcopy(bundle))
        self.policy['extensions_allowed'] = {'types': ['model_fallback', 'resources'], 'mount_roots': [], 'networks': []}
        self.agents = {}
        for harness, alias, other in (('openclaw', 'operador', 'operador-respaldo'), ('muse', 'operador-respaldo', 'operador')):
            name = self.name + '-' + harness
            self.policy['containers'][name] = dict(placement)
            self.agents[harness] = policy_module.approve_agent(self.policy, {'tenant_id': 'Praxis', 'alias': alias,
                'runtime_key': alias, 'harness_id': harness, 'host_id': 'fixture-host', 'runtime_mode': 'container',
                'container_name': name, 'runtime_user': 'nobody', 'home_directory': '/nonexistent',
                'state_directory': '/tmp/cauce-state/' + alias, 'systemd_user': self.user,
                'extensions': [{'type': 'model_fallback', 'agent': other, 'model': 'muse-spark-1.3'}]})
        self.volume = fallback.pairing(self.agents['muse'])['volume']

    def create(self, harness):
        agent = self.agents[harness]
        container.create_container(self.policy, agent, container.runtime_mounts(self.policy, agent, self.new, self.new))
        return self.docker.containers[agent['container_name']]

    def socket_mount(self, observed):
        return next(row for row in observed['Mounts'] if row['Destination'] == '/cauce/model-fallback')

    def test_the_client_waits_for_its_server_socket_volume(self):
        with self.assertRaisesRegex(SafeFailure, 'create and start its Muse agent first'):
            self.create('openclaw')
        self.assertFalse(any(call[0] == 'create' for call in self.docker.calls))

    def test_both_containers_share_only_the_pair_volume_and_the_client_mounts_it_read_only(self):
        server = self.create('muse')
        self.assertEqual(self.docker.volumes[self.volume]['cauce.fleet.volume'], 'model-fallback')
        self.assertEqual(self.docker.volumes[self.volume]['cauce.fleet.alias'], 'operador-respaldo')
        client = self.create('openclaw')
        self.assertEqual((self.socket_mount(server)['Name'], self.socket_mount(server)['RW']), (self.volume, True))
        self.assertEqual((self.socket_mount(client)['Name'], self.socket_mount(client)['RW']), (self.volume, False))
        for harness, observed in (('muse', server), ('openclaw', client)):
            container.validate_container(self.policy, self.agents[harness], observed)
        drifted = copy.deepcopy(client)
        self.socket_mount(drifted)['RW'] = True
        with self.assertRaisesRegex(SafeFailure, 'container runtime mounts differ'):
            container.validate_container(self.policy, self.agents['openclaw'], drifted)
        missing = copy.deepcopy(client)
        missing['Mounts'] = [row for row in missing['Mounts'] if row['Destination'] != '/cauce/model-fallback']
        with self.assertRaisesRegex(SafeFailure, 'container runtime mounts differ'):
            container.validate_container(self.policy, self.agents['openclaw'], missing)
        unpaired = {**self.agents['openclaw'], 'extensions': []}
        with self.assertRaises(SafeFailure):
            container.validate_container(self.policy, unpaired, client)

    def test_a_foreign_volume_with_the_pair_name_is_never_mounted(self):
        self.docker.volumes[self.volume] = {'cauce.fleet.owner': 'foreign'}
        for harness in ('openclaw', 'muse'):
            with self.subTest(harness=harness), self.assertRaisesRegex(SafeFailure, 'another owner'):
                self.create(harness)

    def test_removing_the_server_extension_retires_its_volume_once_no_client_mounts_it(self):
        self.create('muse')
        server = self.agents['muse']
        plain = policy_module.approve_agent(self.policy, {**{key: value for key, value in server.items() if not key.startswith('_')}, 'extensions': []})
        with mock.patch.object(container, 'stop_container'), mock.patch.object(container, 'purge_sidecars', return_value={}):
            container.recreate_extensions(self.policy, server, plain)
        self.assertNotIn(self.volume, self.docker.volumes)

    def test_purging_the_server_keeps_the_socket_volume_while_its_client_mounts_it(self):
        self.create('muse')
        self.create('openclaw')
        server = self.agents['muse']
        with mock.patch.object(container, 'stop_container'), mock.patch.object(container, 'purge_sidecars', return_value={}):
            removed = container.purge_container(self.policy, server)
        self.assertIn(self.volume, self.docker.volumes)
        self.assertNotIn({'type': 'volume', 'name': self.volume}, removed['removed'])
        del self.docker.containers[self.agents['openclaw']['container_name']]
        with mock.patch.object(container, 'stop_container'), mock.patch.object(container, 'purge_sidecars', return_value={}):
            self.assertEqual(container.purge_container(self.policy, server)['removed'], [{'type': 'volume', 'name': self.volume}])


if __name__ == '__main__':
    unittest.main()
