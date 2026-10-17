from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import v4_alcance_copia  # noqa: E402

LIVE = {'Name': '/zz-canary-live', 'Mounts': [{'Source': '/srv/zz-canary', 'Destination': '/data'}]}


def docker(inspect_code: int, inspect_err: str):
    def run(command, **_):
        if command[1:3] == ['ps', '-aq']:
            return subprocess.CompletedProcess(command, 0, 'live\ngone\n', '')
        return subprocess.CompletedProcess(command, inspect_code, json.dumps([LIVE]), inspect_err)
    return run


class HostContainersTests(unittest.TestCase):
    def test_a_container_removed_between_listing_and_inspection_is_skipped(self):
        with patch.object(v4_alcance_copia.subprocess, 'run', docker(1, 'Error response from daemon: No such container: gone\n')):
            self.assertEqual(v4_alcance_copia.host_containers(), {'zz-canary-live': [('/srv/zz-canary', '/data')]})

    def test_any_other_inspection_error_still_fails(self):
        with patch.object(v4_alcance_copia.subprocess, 'run', docker(1, 'Cannot connect to the Docker daemon\n')):
            with self.assertRaises(subprocess.CalledProcessError):
                v4_alcance_copia.host_containers()


if __name__ == '__main__':
    unittest.main()
