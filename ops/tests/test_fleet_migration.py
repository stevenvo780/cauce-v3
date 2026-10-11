from __future__ import annotations

import copy
import importlib
import json
import pathlib
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
fixtures = importlib.import_module('test_fleet_executor')


class FleetMigrationTest(unittest.TestCase):
    def setUp(self):
        self.source = fixtures.PhysicalExecutorTest()
        self.source.setUp()
        self.addCleanup(self.source.tearDown)
        self.destination = fixtures.PhysicalExecutorTest()
        self.destination.setUp()
        self.addCleanup(self.destination.tearDown)
        self.destination.policy['host_id'] = 'destination-host'
        self.destination.agent.update(host_id='destination-host', container_name='host:destination-host')
        self.destination.context['snapshot']['agents'] = [self.destination.agent]
        self.destination.context['request']['parameters']['placement'].update(host_id='destination-host')
        self.destination.save_policy()

    def packet(self, fixture, role):
        context = copy.deepcopy(fixture.context)
        context['operation_id'] = str(uuid.uuid4())
        context['request']['kind'] = 'update'
        context['request']['parameters'] = copy.deepcopy(self.destination.context['request']['parameters'])
        context['fenced_targets'] = [context['request']['target']]
        context['previous_agents'] = [copy.deepcopy(self.source.agent)] if role == 'source' else []
        context['fleet_scope'] = {'operation_id': context['operation_id'], 'host_id': fixture.policy['host_id'],
            'scope_sha256': 'a' * 64, 'prepared_revision': 1, 'worker_id': 'fixture-worker',
            'claim_token': str(uuid.uuid4()), 'claim_epoch': 1, 'placement_role': role}
        if role == 'source':
            context['snapshot']['agents'] = []
            context['snapshot']['memberships'] = []
        return context

    def test_source_stops_only_its_real_process_and_rejects_destination_effects(self):
        self.source.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.source.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        metadata = self.source.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        pid = json.loads(metadata.read_bytes())['pid']
        self.assertTrue(pathlib.Path(f'/proc/{pid}').exists())
        packet = self.packet(self.source, 'source')
        stopped = self.source.run_step('stop', packet)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertFalse(pathlib.Path(f'/proc/{pid}').exists())
        for step in ('credentials', 'runtime', 'authenticate', 'admission'):
            result = self.source.run_step(step, packet)
            self.assertNotEqual(result.returncode, 0)
        result = self.source.run_step('artifacts', packet)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('observed stop and revocation', result.stderr)

    def test_destination_update_starts_locally_without_stopping_a_source_placement(self):
        self.destination.configure_signer()
        for step in ('artifacts', 'credentials'):
            result = self.destination.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        packet = self.packet(self.destination, 'destination')
        result = self.destination.run_step('artifacts', packet)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.destination.run_step('runtime', packet)
        self.assertEqual(result.returncode, 0, result.stderr)
        metadata = self.destination.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        pid = json.loads(metadata.read_bytes())['pid']
        self.assertTrue(pathlib.Path(f'/proc/{pid}').exists())
        for step in ('stop', 'revoke'):
            self.assertNotEqual(self.destination.run_step(step, packet).returncode, 0)
        for patch in ({'placement_role': 'source'}, {'host_id': 'foreign-host'}):
            changed = copy.deepcopy(packet)
            changed['fleet_scope'].update(patch)
            self.assertNotEqual(self.destination.run_step('runtime', changed).returncode, 0)
        changed = copy.deepcopy(packet)
        changed['previous_agents'] = [self.source.agent]
        self.assertNotEqual(self.destination.run_step('runtime', changed).returncode, 0)
        self.assertTrue(pathlib.Path(f'/proc/{pid}').exists())

    def test_crosshost_credentials_and_compensation_require_central_authority(self):
        for fixture, role in ((self.source, 'source'), (self.destination, 'destination')):
            packet = self.packet(fixture, role)
            for step in ('compensate', 'revoke' if role == 'source' else 'credentials'):
                result = fixture.run_step(step, packet)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('durable central authority', result.stderr)


if __name__ == '__main__':
    unittest.main()
