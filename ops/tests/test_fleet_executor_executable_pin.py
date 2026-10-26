from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_container as container


class ApprovedExecutableDigestTest(unittest.TestCase):
    """Production, 26-oct (Praxis teseo): restoring an original whose image differs from the approved one measures the
    executable in a probe container; the docker CLI wrote its cidfile with server2's umask 0002 and checked_file refused it."""

    def test_a_group_writable_caller_umask_cannot_make_the_probe_identity_unsafe(self):
        calls, modes = [], []

        def docker(*arguments):
            calls.append(arguments)
            if arguments[0] == 'run':
                cidfile = pathlib.Path(arguments[arguments.index('--cidfile') + 1])
                cidfile.write_text('e' * 64 + '\n')
                modes.append(cidfile.stat().st_mode & 0o777)
                return b'digest'
            return b''

        with tempfile.TemporaryDirectory() as state:
            policy = {'roots': {'state': state}, 'host_id': 'host', 'executor_user': 'cauce'}
            agent = {'runtime_key': 'runtime', 'tenant_id': 'Tenant', 'alias': 'agent',
                     '_placement': {'image': 'sha256:' + '1' * 64, 'python': '/usr/bin/python3'}}
            previous = os.umask(0o002)
            try:
                with mock.patch.object(container, 'docker', side_effect=docker), \
                        mock.patch.object(container, 'executable_digest', return_value='f' * 64):
                    self.assertEqual(container.approved_executable_digest(policy, agent, {'executable': '/bundle/run'}), 'f' * 64)
                self.assertEqual(os.umask(0o002), 0o002)
            finally:
                os.umask(previous)
        self.assertEqual(modes, [0o600])
        self.assertEqual(calls[-1], ('rm', '-f', 'e' * 64))


if __name__ == '__main__':
    unittest.main()
