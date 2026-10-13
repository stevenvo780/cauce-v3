from __future__ import annotations

import base64
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops/cli'))
import fleet_executor_view as view  # noqa: E402

GENERATION_A, GENERATION_B = 'a' * 64, 'b' * 64


def payload(generation: str, marker: str) -> dict:
    files = {'agent.crt': b'certificate', 'agent.key': b'key', 'agent.token': b'token', 'ca.crt': b'ca',
             'inventory/desired-fleet.json': f'{{"generation":"{generation}"}}'.encode(),
             f'inventory/generations/{generation}/flota.json': marker.encode()}
    return {'files': {name: base64.b64encode(body).decode('ascii') for name, body in files.items()}}


class CredentialViewTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-view-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name) / 'credentials' / 'agent' / 'bootstrap'
        self.uid, self.gid = os.geteuid(), os.getegid()
        if self.uid == 0:
            self.skipTest('the view keeps private files for a non-root runtime user')

    def test_a_new_generation_replaces_the_previous_view_whole(self):
        view.install(self.root, payload(GENERATION_A, 'first'), self.uid, self.gid)
        view.install(self.root, payload(GENERATION_B, 'second'), self.uid, self.gid)
        inventory = self.root / 'inventory'
        self.assertEqual((inventory / 'desired-fleet.json').read_text(), f'{{"generation":"{GENERATION_B}"}}')
        self.assertEqual(sorted(path.name for path in (inventory / 'generations').iterdir()), [GENERATION_B])
        self.assertEqual((inventory / 'generations' / GENERATION_B / 'flota.json').read_text(), 'second')
        self.assertEqual(oct((self.root / 'agent.key').stat().st_mode & 0o777), oct(0o400))

    def test_reinstalling_the_same_generation_is_idempotent(self):
        first = view.install(self.root, payload(GENERATION_A, 'same'), self.uid, self.gid)
        self.assertEqual(view.install(self.root, payload(GENERATION_A, 'same'), self.uid, self.gid), first)

    def test_an_unexpected_artifact_still_fails_closed(self):
        body = payload(GENERATION_A, 'first')
        body['files']['inventory/../escape'] = base64.b64encode(b'x').decode('ascii')
        with self.assertRaises(ValueError):
            view.install(self.root, body, self.uid, self.gid)


if __name__ == '__main__':
    unittest.main()
