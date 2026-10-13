from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(OPS / 'cli'), str(OPS / 'container-runtime')]
spec = importlib.util.spec_from_file_location('host_release', OPS / 'scripts/host-release.py')
host_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_release)
from cauce_container_base import bundle_digest  # noqa: E402
from host_setup import extract_release  # noqa: E402

REVISION = 'a' * 40


class HostReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.stage = self.root / 'stage'
        for name, body, mode in (('ops/cli/fleet-executor.py', b'#!/usr/bin/env python3\n', 0o775),
                                 ('ops/cli/fleet-provider-hook.py', b'hook\n', 0o700),
                                 ('services/gateway/dist/fleet/main.js', b'//\n', 0o600),
                                 ('adapter/node_modules/.pnpm/ws/index.js', b'ws\n', 0o664)):
            path = self.stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            path.chmod(mode)
        (self.stage / 'adapter/node_modules/ws').symlink_to('.pnpm/ws')
        os.link(self.stage / 'ops/cli/fleet-provider-hook.py', self.stage / 'ops/cli/hook-alias.py')

    def pack(self, out: str, **extra) -> dict:
        arguments = argparse.Namespace(stage=self.stage, out=self.root / out, revision=REVISION, epoch=1_700_000_000, image=None,
            provider=[], pin=[], **extra)
        return host_release.pack(arguments)

    def test_the_same_tree_packs_the_same_bytes_whatever_its_modes_and_links(self):
        first = self.pack('first')
        (self.stage / 'services/gateway/dist/fleet/main.js').chmod(0o644)
        os.utime(self.stage / 'ops/cli/fleet-executor.py', (1, 1))
        second = self.pack('second')
        self.assertEqual((self.root / 'first/release.tar').read_bytes(), (self.root / 'second/release.tar').read_bytes())
        self.assertEqual(first, second)
        self.assertEqual(sorted(os.listdir(self.root / 'first')), ['host-release.json', 'release.tar'])
        self.assertEqual(json.loads((self.root / 'first/host-release.json').read_text()), first)

    def test_pins_are_measured_on_the_tree_the_computer_extracts(self):
        manifest = self.pack('out', **{})
        extracted = self.root / 'extracted'
        extract_release(self.root / 'out/release.tar', extracted)
        self.assertEqual(manifest['pins'], {'adapter_digest': bundle_digest(str(extracted / 'adapter')),
            'hook_sha256': hashlib.sha256(b'hook\n').hexdigest()})
        self.assertEqual((extracted / 'adapter/node_modules/ws/index.js').read_bytes(), b'ws\n')
        self.assertEqual(oct((extracted / 'ops/cli/fleet-executor.py').stat().st_mode & 0o777), '0o755')
        self.assertEqual(manifest['release']['sha256'], hashlib.sha256((self.root / 'out/release.tar').read_bytes()).hexdigest())

    def test_verify_refuses_another_revision_altered_bytes_and_writable_files(self):
        self.pack('out')
        out = self.root / 'out'
        self.assertEqual(host_release.verify_directory(out, REVISION)['revision'], REVISION)
        with self.assertRaisesRegex(host_release.ReleaseError, 'not the deployed'):
            host_release.verify_directory(out, 'b' * 40)
        (out / 'release.tar').chmod(0o664)
        with self.assertRaisesRegex(host_release.ReleaseError, 'differs from host-release.json'):
            host_release.verify_directory(out)
        (out / 'release.tar').chmod(0o644)
        with open(out / 'release.tar', 'r+b') as stream:
            stream.seek(600)
            stream.write(b'X')
        with self.assertRaisesRegex(host_release.ReleaseError, 'differs from host-release.json'):
            host_release.verify_directory(out)

    def test_escaping_links_and_incomplete_stages_are_refused(self):
        with self.assertRaisesRegex(host_release.ReleaseError, 'absent or empty'):
            (self.root / 'busy').mkdir()
            (self.root / 'busy/x').write_text('x')
            self.pack('busy')
        (self.stage / 'adapter/escape').symlink_to('../../outside')
        with self.assertRaisesRegex(host_release.ReleaseError, 'link escapes'):
            self.pack('escape')
        (self.stage / 'adapter/escape').unlink()
        (self.stage / 'services/gateway/dist/fleet/main.js').unlink()
        with self.assertRaisesRegex(host_release.ReleaseError, 'lacks services/gateway/dist/fleet/main.js'):
            self.pack('incomplete')


if __name__ == '__main__':
    unittest.main()
