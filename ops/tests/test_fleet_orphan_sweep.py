from __future__ import annotations

# cauce:requiere docker
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
