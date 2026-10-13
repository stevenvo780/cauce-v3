from __future__ import annotations

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
from fleet_executor_legacy import validate_shared_observation
from fleet_executor_policy import SafeFailure


def observed(capadd):
    return {'Id': 'container', 'Image': 'image', 'Mounts': [],
            'HostConfig': {'Privileged': False, 'PidMode': '', 'CapAdd': capadd}}


class SharedCapabilityTest(unittest.TestCase):
    def setUp(self):
        self.policy = {}
        self.agent = {'_placement': {'container_id': 'container', 'image': 'image', 'mounts': []}}

    def test_prefixed_and_plain_sys_admin_are_rejected(self):
        for capadd in (['CAP_SYS_ADMIN'], ['SYS_ADMIN'], ['CAP_CHOWN', 'CAP_SYS_ADMIN']):
            with self.subTest(capadd=capadd):
                with self.assertRaisesRegex(SafeFailure, 'isolation changed'):
                    validate_shared_observation(self.policy, self.agent, observed(capadd))
        validate_shared_observation(self.policy, self.agent, observed(['CAP_CHOWN']))
        validate_shared_observation(self.policy, self.agent, observed(None))


if __name__ == '__main__':
    unittest.main()
