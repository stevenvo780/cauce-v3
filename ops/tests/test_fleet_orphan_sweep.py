from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid

SWEEP = pathlib.Path(__file__).resolve().parents[1] / 'cli/fleet_orphan_sweep.py'
PREFIX = 'zz-canary-'


def docker_available() -> bool:
    return subprocess.run(['docker', 'info'], capture_output=True).returncode == 0


@unittest.skipUnless(docker_available(), 'docker is unavailable')
class OrphanSweepTest(unittest.TestCase):
    def setUp(self):
        self.key = PREFIX + uuid.uuid4().hex[:10]
        self.volume = self.key + '-state'
        self.directory = tempfile.TemporaryDirectory()
        self.rows = pathlib.Path(self.directory.name) / 'rows.json'

    def tearDown(self):
        subprocess.run(['docker', 'rm', '-f', self.key], capture_output=True)
        subprocess.run(['docker', 'volume', 'rm', self.volume], capture_output=True)
        self.directory.cleanup()

    def sweep(self, rows, *extra):
        self.rows.write_text(json.dumps(rows))
        return subprocess.run([sys.executable, str(SWEEP), '--rows', str(self.rows), '--runtime-key-prefix', PREFIX, *extra],
                              capture_output=True, text=True, timeout=60)

    def seed(self):
        subprocess.run(['docker', 'volume', 'create', '--label', 'cauce.fleet.runtime_key=' + self.key, self.volume],
                       capture_output=True, check=True)

    def test_seeded_volume_without_row_fails_and_removal_returns_clean(self):
        self.seed()
        result = self.sweep([])
        self.assertEqual(result.returncode, 1)
        self.assertEqual([row['name'] for row in json.loads(result.stdout)['orphan_resources']], [self.volume])
        subprocess.run(['docker', 'volume', 'rm', self.volume], capture_output=True, check=True)
        result = self.sweep([])
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(json.loads(result.stdout)['clean'])

    def test_row_with_row_is_clean_and_row_without_container_fails(self):
        self.seed()
        row = {'runtime_key': self.key, 'container_name': self.key, 'runtime_mode': 'native'}
        self.assertEqual(self.sweep([row]).returncode, 0)
        result = self.sweep([{**row, 'runtime_mode': 'container'}])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['orphan_rows'][0]['runtime_key'], self.key)

    def test_row_pointing_to_unlabelled_container_is_clean_and_other_host_rows_are_ignored(self):
        subprocess.run(['docker', 'create', '--name', self.key, 'busybox', 'true'], capture_output=True, check=True)
        row = {'runtime_key': self.key, 'container_name': self.key, 'runtime_mode': 'container', 'host_id': 'host-a'}
        self.assertEqual(self.sweep([row]).returncode, 0)
        subprocess.run(['docker', 'rm', '-f', self.key], capture_output=True, check=True)
        foreign = {**row, 'host_id': 'host-b'}
        self.assertEqual(self.sweep([foreign], '--host-id', 'host-a').returncode, 0)
        self.assertEqual(self.sweep([foreign], '--host-id', 'host-b').returncode, 1)


if __name__ == '__main__':
    unittest.main()
