from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import socket
import sys
import tempfile
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'scripts'))
import v4_alcance_copia as alcance  # noqa: E402
import v4_copia_integral as integral  # noqa: E402

OUTSIDE_CONTENT = 'CONTENIDO-DE-FUERA'


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class ChromeVolatileScopeTests(unittest.TestCase):
    def test_only_singleton_artifacts_inside_google_chrome_are_volatile(self):
        volatile = (
            'muse/.config/google-chrome/SingletonSocket',
            'muse/.config/google-chrome/SingletonLock',
            'muse/.config/google-chrome/SingletonCookie',
            'muse/.config/google-chrome/Default/SingletonSocket',
            '/datos/agents/x/.config/Google-Chrome/SINGLETONLOCK',
        )
        for path in volatile:
            self.assertTrue(alcance.is_chrome_volatile(path), path)
        not_volatile = (
            'muse/SingletonSocket',
            'muse/.config/google-chrome/Preferences',
            'muse/.config/google-chrome/SingletonSocket.bak',
            'muse/.config/chromium/SingletonSocket',
            'muse/.config/google-chrome',
            'SingletonSocket',
        )
        for path in not_volatile:
            self.assertFalse(alcance.is_chrome_volatile(path), path)
        self.assertEqual(alcance.CHROME_VOLATILE_REASON, 'chrome-volatile')


class InventoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-v4-integral-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.outside = self.root / 'fuera.txt'
        self.outside.write_text(OUTSIDE_CONTENT)
        self.source = self.root / 'origen'
        self.chrome = self.source / '.config' / 'google-chrome'
        write(self.source / 'keep.txt', 'benigno\n')
        write(self.chrome / 'Preferences', '{}\n')
        write(self.chrome / 'SingletonCookie', 'cookie\n')
        os.symlink(str(self.outside), self.chrome / 'SingletonSocket')
        write(self.chrome / 'lock-target', 'lock\n')
        os.symlink('lock-target', self.chrome / 'SingletonLock')

    def inventory(self, source: pathlib.Path, name: str = 'muse'):
        descriptor = integral.directory(str(source))
        try:
            return integral.inventory({name: descriptor})
        finally:
            os.close(descriptor)

    def test_chrome_volatile_artifacts_are_omitted_with_reason_and_outside_never_copied(self):
        entries, omissions, _ = self.inventory(self.source)
        entry_paths = {entry['path'] for entry in entries}
        self.assertIn('muse/keep.txt', entry_paths)
        self.assertIn('muse/.config/google-chrome/Preferences', entry_paths)
        self.assertIn('muse/.config/google-chrome/lock-target', entry_paths)
        for artifact in ('SingletonSocket', 'SingletonLock', 'SingletonCookie'):
            self.assertNotIn(f'muse/.config/google-chrome/{artifact}', entry_paths)
        reasons = {item['path']: (item['reason'], item.get('kind')) for item in omissions}
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonSocket'], ('chrome-volatile', 'symlink'))
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonLock'], ('chrome-volatile', 'symlink'))
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonCookie'], ('chrome-volatile', 'file'))
        outside_digest = hashlib.sha256(OUTSIDE_CONTENT.encode()).hexdigest()
        self.assertNotIn(outside_digest, {entry.get('sha256') for entry in entries})
        self.assertNotIn(str(self.outside), json.dumps(omissions))

    def test_chrome_socket_file_is_omitted_as_volatile(self):
        sock_path = self.chrome / 'SingletonSocket'
        sock_path.unlink()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(sock.close)
        sock.bind(str(sock_path))
        entries, omissions, _ = self.inventory(self.source)
        self.assertNotIn('muse/.config/google-chrome/SingletonSocket', {entry['path'] for entry in entries})
        reasons = {item['path']: (item['reason'], item.get('kind')) for item in omissions}
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonSocket'], ('chrome-volatile', 'socket'))

    def test_generic_symlink_leaving_tree_is_rejected_and_never_copied(self):
        for name, target in (('escape-abs', str(self.outside)), ('escape-rel', '../fuera.txt')):
            with self.subTest(name=name):
                other = self.root / name
                write(other / 'keep.txt', 'benigno\n')
                os.symlink(target, other / 'escape')
                with self.assertRaisesRegex(integral.Failure, 'a symlink leaves its source root'):
                    self.inventory(other, name='data')

    def test_singleton_name_outside_google_chrome_is_not_volatile(self):
        other = self.root / 'sin-chrome'
        write(other / 'keep.txt', 'benigno\n')
        os.symlink(str(self.outside), other / 'SingletonSocket')
        with self.assertRaisesRegex(integral.Failure, 'a symlink leaves its source root'):
            self.inventory(other, name='data')
        internal = self.root / 'interno'
        write(internal / 'keep.txt', 'benigno\n')
        os.symlink('keep.txt', internal / 'SingletonSocket')
        entries, omissions, _ = self.inventory(internal, name='data')
        self.assertIn('data/SingletonSocket', {entry['path'] for entry in entries})
        self.assertEqual(omissions, [])


class PackUnpackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-v4-integral-pack-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.outside = self.root / 'fuera.txt'
        self.outside.write_text(OUTSIDE_CONTENT)
        self.host_config = self.root / 'host-config'
        self.host_state = self.root / 'host-state'
        self.source = self.host_config / 'hegel'
        self.chrome = self.source / '.config' / 'google-chrome'
        write(self.source / 'keep.txt', 'benigno\n')
        write(self.chrome / 'Preferences', '{}\n')
        write(self.chrome / 'SingletonCookie', 'cookie\n')
        os.symlink(str(self.outside), self.chrome / 'SingletonSocket')
        write(self.chrome / 'lock-target', 'lock\n')
        os.symlink('lock-target', self.chrome / 'SingletonLock')
        self.config = self.root / 'aliases.json'
        self.config.write_text(json.dumps({'aliases': {'hegel': {
            'tenant': 'Miguel', 'container': 'c-hegel', 'home': '/home/dev',
            'stateDirectory': '/home/dev/.local/state/cauce-v3/hegel'}}}))
        self.containers = {'c-hegel': [
            (os.path.realpath(self.host_config), '/home/dev/.local/share/cauce-v3/config'),
            (os.path.realpath(self.host_state), '/home/dev/.local/state/cauce-v3'),
        ]}
        self.archive = self.root / 'copia.tar'

    def pack_args(self, source: pathlib.Path) -> argparse.Namespace:
        return argparse.Namespace(config=str(self.config), alias='hegel', empresa='Miguel',
                                  origen=[f'muse={source}'], destino=str(self.archive))

    def test_pack_records_chrome_volatile_omissions_and_unpack_restores_without_them(self):
        with mock.patch.object(integral, 'host_containers', return_value=self.containers):
            receipt = integral.pack(self.pack_args(self.source))
        self.assertTrue(receipt['verified'])
        reasons = {item['path']: item['reason'] for item in receipt['omissions']}
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonSocket'], 'chrome-volatile')
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonLock'], 'chrome-volatile')
        self.assertEqual(reasons['muse/.config/google-chrome/SingletonCookie'], 'chrome-volatile')
        raw = self.archive.read_bytes()
        self.assertNotIn(OUTSIDE_CONTENT.encode(), raw)
        self.assertNotIn(str(self.outside).encode(), raw)
        target = self.root / 'espacio'
        unpacked = integral.unpack(argparse.Namespace(
            archivo=str(self.archive), alias='hegel', empresa='Miguel',
            mapa=['muse=config/hegel'], destino=str(target)))
        self.assertTrue(unpacked['verified'])
        self.assertEqual((target / 'config/hegel/keep.txt').read_text(), 'benigno\n')
        self.assertEqual((target / 'config/hegel/.config/google-chrome/Preferences').read_text(), '{}\n')
        for artifact in ('SingletonSocket', 'SingletonLock', 'SingletonCookie'):
            self.assertFalse((target / f'config/hegel/.config/google-chrome/{artifact}').exists(), artifact)
            self.assertFalse((target / f'config/hegel/.config/google-chrome/{artifact}').is_symlink(), artifact)
        restored = b''.join(p.read_bytes() for p in target.rglob('*') if p.is_file())
        self.assertNotIn(OUTSIDE_CONTENT.encode(), restored)

    def test_validate_rejects_forged_chrome_volatile_omission_outside_chrome_profile(self):
        with mock.patch.object(integral, 'host_containers', return_value=self.containers):
            integral.pack(self.pack_args(self.source))
        import tarfile
        with tarfile.open(self.archive, 'r:') as handle:
            manifest = json.loads(handle.extractfile('manifest.json').read())
        forged = json.loads(json.dumps(manifest))
        target = next(item for item in forged['omissions'] if item['reason'] == 'chrome-volatile')
        target['path'] = 'muse/fuera-de-chrome.txt'
        forged['sha256'] = integral.seal(forged)
        with self.assertRaisesRegex(integral.Failure, 'may omit only'):
            integral.validate(forged, argparse.Namespace(alias='hegel', empresa='Miguel'))

    def test_pack_with_generic_external_symlink_fails_and_creates_no_archive(self):
        other = self.host_config / 'hegel-mal'
        write(other / 'keep.txt', 'benigno\n')
        os.symlink(str(self.outside), other / 'escape')
        args = self.pack_args(other)
        args.origen = [f'muse={other}']
        with mock.patch.object(integral, 'host_containers', return_value=self.containers):
            with self.assertRaisesRegex(integral.Failure, 'a symlink leaves its source root'):
                integral.pack(args)
        self.assertFalse(self.archive.exists())


if __name__ == '__main__':
    unittest.main()
