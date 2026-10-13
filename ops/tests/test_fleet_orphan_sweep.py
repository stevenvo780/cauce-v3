from __future__ import annotations

# cauce:requiere docker
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor_container as containers

SWEEP = pathlib.Path(__file__).resolve().parents[1] / 'cli/fleet_orphan_sweep.py'
PREFIX = 'zz-canary-'


def docker_available() -> bool:
    return subprocess.run(['docker', 'info'], capture_output=True).returncode == 0


class OrphanSweepTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not docker_available():
            if os.environ.get('CAUCE_RELEASE_VALIDATION') == '1':
                raise RuntimeError('docker is unavailable for the release orphan gate')
            raise unittest.SkipTest('docker is unavailable')

    def setUp(self):
        self.key = PREFIX + uuid.uuid4().hex[:10]
        self.volume = self.key + '-state'
        self.directory = tempfile.TemporaryDirectory()
        self.rows = pathlib.Path(self.directory.name) / 'rows.json'

    def tearDown(self):
        subprocess.run(['docker', 'rm', '-f', self.key], capture_output=True)
        subprocess.run(['docker', 'volume', 'rm', self.volume], capture_output=True)
        self.directory.cleanup()

    def sweep(self, rows, host_id=''):
        self.rows.write_text(json.dumps(rows))
        report, code, attempts = containers.sweep_report(self.rows, self.key, host_id)
        return {**report, 'sweep_exit': code, 'inventory_attempts': attempts}

    def seed(self):
        subprocess.run(['docker', 'volume', 'create', '--label', 'cauce.fleet.runtime_key=' + self.key, self.volume],
                       capture_output=True, check=True)

    def test_seeded_volume_without_row_fails_and_removal_returns_clean(self):
        self.seed()
        result = self.sweep([])
        self.assertEqual(result['sweep_exit'], 1)
        self.assertEqual([row['name'] for row in result['orphan_resources']], [self.volume])
        subprocess.run(['docker', 'volume', 'rm', self.volume], capture_output=True, check=True)
        result = self.sweep([])
        self.assertEqual(result['sweep_exit'], 0, result)
        self.assertTrue(result['clean'])

    def test_row_with_row_is_clean_and_row_without_container_fails(self):
        self.seed()
        row = {'runtime_key': self.key, 'container_name': self.key, 'runtime_mode': 'native'}
        result = self.sweep([row])
        self.assertEqual(result['sweep_exit'], 0, result)
        result = self.sweep([{**row, 'runtime_mode': 'container'}])
        self.assertEqual(result['sweep_exit'], 1)
        self.assertEqual(result['orphan_rows'][0]['runtime_key'], self.key)

    def test_row_pointing_to_unlabelled_container_is_clean_and_other_host_rows_are_ignored(self):
        subprocess.run(['docker', 'create', '--name', self.key, 'busybox', 'true'], capture_output=True, check=True)
        row = {'runtime_key': self.key, 'container_name': self.key, 'runtime_mode': 'container', 'host_id': 'host-a'}
        self.assertEqual(self.sweep([row])['sweep_exit'], 0)
        subprocess.run(['docker', 'rm', '-f', self.key], capture_output=True, check=True)
        foreign = {**row, 'host_id': 'host-b'}
        self.assertEqual(self.sweep([foreign], host_id='host-a')['sweep_exit'], 0)
        self.assertEqual(self.sweep([foreign], host_id='host-b')['sweep_exit'], 1)

    def test_owned_running_declaration_diverges_while_stopped_and_matches_the_live_state(self):
        subprocess.run(['docker', 'create', '--name', self.key, '--label', 'cauce.fleet.runtime_key=' + self.key,
                        '--label', 'cauce.fleet.host=host-a', 'busybox', 'sleep', '30'], capture_output=True, check=True)
        row = {'runtime_key': self.key, 'container_name': self.key, 'runtime_mode': 'container', 'host_id': 'host-a',
               'ownership': 'owned', 'docker_state': 'running'}
        stopped = self.sweep([row])
        self.assertEqual(stopped['sweep_exit'], 1, stopped)
        self.assertEqual(stopped['divergences'][0]['kind'], 'docker_state')
        self.assertEqual(stopped['divergences'][0]['actual'], 'stopped')
        matched = self.sweep([{**row, 'docker_state': 'stopped'}])
        self.assertEqual(matched['sweep_exit'], 0, matched)
        self.assertEqual(matched['divergences'], [])
        subprocess.run(['docker', 'start', self.key], capture_output=True, check=True)
        running = self.sweep([{**row, 'docker_state': 'stopped'}])
        self.assertEqual(running['sweep_exit'], 1, running)
        self.assertEqual(running['divergences'][0]['actual'], 'running')
        self.assertEqual(self.sweep([row])['sweep_exit'], 0)

    def test_shared_unlabelled_container_diverges_only_when_a_state_is_declared(self):
        subprocess.run(['docker', 'create', '--name', self.key, 'busybox', 'true'], capture_output=True, check=True)
        row = {'runtime_key': self.key, 'container_name': self.key, 'runtime_mode': 'container', 'ownership': 'shared'}
        self.assertEqual(self.sweep([row])['sweep_exit'], 0)
        declared = self.sweep([{**row, 'docker_state': 'running'}])
        self.assertEqual(declared['sweep_exit'], 1, declared)
        self.assertEqual(declared['divergences'][0]['kind'], 'docker_state')
        self.assertEqual(declared['divergences'][0]['actual'], 'stopped')


def load_sweep():
    spec = importlib.util.spec_from_file_location('fleet_orphan_sweep_under_test', SWEEP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeclaredDockerStateTest(unittest.TestCase):
    def report(self, row, observed, resources=None):
        return load_sweep().sweep([row], resources or [], {row['container_name']: observed})

    def row(self, **extra):
        base = {'runtime_key': 'zz-canary-state', 'container_name': 'zz-canary-state', 'runtime_mode': 'container', 'host_id': 'host-a'}
        base.update(extra)
        return base

    def labels(self, runtime_key='zz-canary-state', host='host-a'):
        return {'cauce.fleet.runtime_key': runtime_key, 'cauce.fleet.host': host}

    def test_owned_expected_running_actual_stopped_is_a_state_divergence(self):
        report = self.report(self.row(ownership='owned', docker_state='running'), {'running': False, 'labels': self.labels()})
        self.assertEqual(report['divergences'], [{
            'kind': 'docker_state', 'expected': 'running', 'actual': 'stopped', 'runtime_key': 'zz-canary-state',
            'container_name': 'zz-canary-state', 'ownership': 'owned'}])

    def test_owned_expected_stopped_actual_running_is_a_state_divergence(self):
        report = self.report(self.row(ownership='owned', docker_state='stopped'), {'running': True, 'labels': self.labels()})
        self.assertEqual(report['divergences'][0]['actual'], 'running')
        self.assertEqual(report['divergences'][0]['expected'], 'stopped')

    def test_shared_unlabelled_expected_running_actual_stopped_is_a_state_divergence(self):
        report = self.report(self.row(ownership='shared', docker_state='running'), {'running': False, 'labels': {}})
        self.assertEqual(report['divergences'][0]['kind'], 'docker_state')
        self.assertEqual(report['divergences'][0]['ownership'], 'shared')

    def test_legacy_unlabelled_without_declared_state_stays_clean_while_stopped(self):
        report = self.report(self.row(ownership='legacy'), {'running': False, 'labels': {}})
        self.assertEqual(report['divergences'], [])
        self.assertEqual(report['orphan_rows'], [])

    def test_owned_unlabelled_container_is_an_ownership_divergence(self):
        report = self.report(self.row(ownership='owned', docker_state='stopped'), {'running': False, 'labels': {}})
        self.assertEqual(report['divergences'][0]['kind'], 'ownership')
        self.assertIsNone(report['divergences'][0]['actual'])

    def test_shared_or_legacy_container_with_another_runtime_key_is_an_ownership_divergence(self):
        observed = {'running': True, 'labels': self.labels('zz-canary-other')}
        for ownership in ('shared', 'legacy'):
            report = self.report(self.row(ownership=ownership), observed)
            self.assertEqual(report['divergences'][0]['kind'], 'ownership', ownership)
            self.assertEqual(report['divergences'][0]['actual'], 'zz-canary-other')

    def test_matching_owned_labels_and_state_are_clean(self):
        report = self.report(self.row(ownership='owned', docker_state='running'), {'running': True, 'labels': self.labels()})
        self.assertEqual(report['divergences'], [])

    def test_omitted_state_does_not_invent_an_expectation_for_a_matching_stopped_container(self):
        report = self.report(self.row(ownership='owned'), {'running': False, 'labels': self.labels()})
        self.assertEqual(report['divergences'], [])

    def test_native_row_does_not_compare_container_state(self):
        report = self.report(self.row(runtime_mode='native', docker_state='running'), {'running': False, 'labels': {}})
        self.assertEqual(report['divergences'], [])
        self.assertEqual(report['orphan_rows'], [])

    def test_owned_host_label_must_match_when_both_are_present(self):
        report = self.report(self.row(ownership='owned'), {'running': False, 'labels': self.labels(host='host-b')})
        self.assertEqual(report['divergences'][0]['kind'], 'ownership')
        self.assertEqual(report['divergences'][0]['actual'], 'host-b')

    def test_invalid_declaration_is_rejected_before_docker_and_is_not_clean(self):
        module = load_sweep()
        with tempfile.TemporaryDirectory() as directory:
            rows = pathlib.Path(directory) / 'rows.json'
            rows.write_text(json.dumps([self.row(docker_state='paused')]))
            with patch.object(module.subprocess, 'run', side_effect=AssertionError('docker must not be consulted')):
                self.assertEqual(module.main(['--rows', str(rows)]), 2)
            rows.write_text(json.dumps([self.row(ownership='borrowed')]))
            with patch.object(module.subprocess, 'run', side_effect=AssertionError('docker must not be consulted')):
                self.assertEqual(module.main(['--rows', str(rows)]), 2)


class SweepReleaseGateTest(unittest.TestCase):
    def test_release_gate_rejects_unavailable_docker(self):
        with patch.dict(os.environ, {'CAUCE_RELEASE_VALIDATION': '1'}), \
                patch(__name__ + '.docker_available', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'docker is unavailable'):
                try:
                    OrphanSweepTest.setUpClass()
                except unittest.SkipTest as error:
                    self.fail(f'release gate skipped: {error}')

    def test_release_gate_rejects_unavailable_runtime_image(self):
        missing = subprocess.CompletedProcess([], 1, '', '')
        with patch.dict(os.environ, {'CAUCE_RELEASE_VALIDATION': '1'}), \
                patch.object(containers.subprocess, 'run', return_value=missing):
            with self.assertRaisesRegex(RuntimeError, 'Python image is unavailable'):
                try:
                    containers.DisposableContainerExecutorTest.setUpClass()
                except unittest.SkipTest as error:
                    self.fail(f'release gate skipped: {error}')


if __name__ == '__main__':
    unittest.main()
