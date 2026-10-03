#!/usr/bin/env python3
"""Exercise the real builder with a deterministic hardlink-producing pnpm fixture."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILDER = pathlib.Path(os.environ.get("CAUCE_BUILDER_UNDER_TEST", ROOT / "ops/scripts/build-adapter-release.sh"))
PNPM_FIXTURE = '''#!/usr/bin/env python3
import os, pathlib, sys
root = pathlib.Path.cwd()
source = root / 'packages/protocol/dist/index.js'
if sys.argv[1:] == ['--filter', '@cauce/protocol', 'build']:
    with source.open('w') as out:
        out.write('export const protocol = 3;\\n')
elif sys.argv[1:] == ['build:adapter']:
    pass
elif sys.argv[1:5] == ['--filter', '@cauce/adapter-sdk', 'deploy', '--legacy']:
    target = pathlib.Path(sys.argv[-1])
    for file in (root / 'packages/adapter-sdk').rglob('*'):
        if file.is_file():
            destination = target / file.relative_to(root / 'packages/adapter-sdk')
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.link(file, destination)
    dependency = target / 'node_modules/protocol/index.js'
    dependency.parent.mkdir(parents=True)
    os.link(source, dependency)
    store_file = target / 'node_modules/dependency/index.js'
    store_file.parent.mkdir(parents=True)
    os.link(pathlib.Path(os.environ['TEST_STORE']) / 'content', store_file)
    os.link(store_file, store_file.with_name('alias.js'))
    (target / 'metadata.json').write_text('{"local":true}\\n')
    (target / 'node_modules/.bin').mkdir()
    (target / 'node_modules/.bin/adapter').symlink_to('../../dist/src/bin/claude.js')
    self_link = target / 'node_modules/.pnpm/node_modules/@cauce/adapter-sdk'
    self_link.parent.mkdir(parents=True)
    self_link.symlink_to(root / 'packages/adapter-sdk')
    if os.environ.get('EXTERNAL_LINK'):
        (target / 'external-link').symlink_to(source)
else:
    raise SystemExit('Unexpected pnpm arguments: ' + repr(sys.argv))
'''


def snapshot(root: pathlib.Path) -> dict[str, tuple[str, int]]:
    return {str(path.relative_to(root)): (hashlib.sha256(path.read_bytes()).hexdigest(),
            stat.S_IMODE(path.stat().st_mode)) for path in root.rglob('*')
            if path.is_file() and not path.is_symlink()}


def inodes(root: pathlib.Path) -> set[tuple[int, int]]:
    return {(path.stat().st_dev, path.stat().st_ino) for path in root.rglob('*')
            if path.is_file() and not path.is_symlink()}


def bundle_digest(root: pathlib.Path) -> str:
    result = subprocess.run([sys.executable, '-B', str(ROOT / 'ops/container-runtime/cauce-container-runtime.py'),
                             'bundle-digest', str(root)], check=True, capture_output=True, text=True, timeout=10)
    return result.stdout.strip()


class BuilderIsolation(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix='builder-hardlinks-')
        self.directory = pathlib.Path(self.temporary.name)
        self.repo = self.directory / 'repo'
        self.store = self.directory / 'store'
        self.store.mkdir()
        (self.store / 'content').write_text('store content\n')
        (self.store / 'content').chmod(0o640)
        for directory in ['ops/scripts', 'ops/container-runtime', 'packages/protocol/dist',
                          'packages/adapter-sdk/dist/src/bin', 'packages/adapter-sdk/scripts']:
            (self.repo / directory).mkdir(parents=True, exist_ok=True)
        shutil.copy2(BUILDER, self.repo / 'ops/scripts/build-adapter-release.sh')
        shutil.copytree(ROOT / 'ops/container-runtime', self.repo / 'ops/container-runtime', dirs_exist_ok=True)
        (self.repo / 'packages/protocol/dist/index.js').write_text('export const protocol = 3;\n')
        for harness in ['claude', 'codex', 'openclaw', 'grok']:
            entry = self.repo / f'packages/adapter-sdk/dist/src/bin/{harness}.js'
            entry.write_text('#!/usr/bin/env node\n')
            entry.chmod(0o755)
        (self.repo / 'packages/adapter-sdk/scripts/package-smoke.mjs').write_text('process.exit(0);\n')
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        (self.bin / 'pnpm').write_text(PNPM_FIXTURE)
        (self.bin / 'pnpm').chmod(0o755)
        self.environment = {**os.environ, 'PATH': f'{self.bin}:{os.environ["PATH"]}', 'TEST_STORE': str(self.store),
                            'PYTHONDONTWRITEBYTECODE': '1'}
        self.git('init', '-q')
        self.git('add', 'ops', 'packages')
        self.git('-c', 'user.name=tales', '-c', 'user.email=34928585+stevenvo780@users.noreply.github.com',
                 'commit', '-qm', 'synthetic builder fixture', '--', 'ops', 'packages')

    def git(self, *arguments: str) -> None:
        subprocess.run(['git', *arguments], cwd=self.repo, check=True, capture_output=True, timeout=10)

    def tearDown(self) -> None:
        # Only this test's disposable files; never a pre-existing release or pnpm store.
        for current, directories, files in os.walk(self.directory):
            for name in [*directories, *files]:
                path = pathlib.Path(current) / name
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode | stat.S_IWUSR | (stat.S_IXUSR if path.is_dir() else 0))
        self.temporary.cleanup()

    def build(self, name: str, *, umask: int | None = None, **environment: str) -> subprocess.CompletedProcess[str]:
        preexec_fn = None
        if umask is not None:
            def set_umask() -> None:
                os.umask(umask)
            preexec_fn = set_umask
        return subprocess.run(['bash', 'ops/scripts/build-adapter-release.sh', str(self.directory / name)],
                              cwd=self.repo, env={**self.environment, **environment},
                              text=True, capture_output=True, timeout=30, preexec_fn=preexec_fn)

    def test_two_builds_preserve_hashes_modes_links_and_private_inodes(self) -> None:
        sources = snapshot(self.repo / 'packages')
        store = snapshot(self.store)
        digests = []
        for name in ['first', 'second']:
            result = self.build(name)
            self.assertEqual(result.returncode, 0, result.stderr)
            digests.append(result.stdout.splitlines()[0])
            self.assertEqual(snapshot(self.repo / 'packages'), sources)
            self.assertEqual(snapshot(self.store), store)
            release = self.directory / name
            self.assertFalse(inodes(release) & (inodes(self.repo / 'packages') | inodes(self.store)))
            for path in [release, *release.rglob('*')]:
                if path.is_symlink():
                    self.assertTrue(path.resolve(strict=True).is_relative_to(release))
                else:
                    self.assertEqual(path.stat().st_mode & 0o222, 0, str(path))
            package = release / 'packages/adapter-sdk'
            for harness in ['claude', 'codex', 'openclaw', 'grok']:
                self.assertEqual(stat.S_IMODE((package / f'dist/src/bin/{harness}.js').stat().st_mode), 0o555)
            dependency = package / 'node_modules/dependency'
            self.assertEqual((dependency / 'index.js').stat().st_ino, (dependency / 'alias.js').stat().st_ino)
        print(json.dumps({'fixture_digests': digests, 'equal': digests[0] == digests[1]}))

    def test_external_symlink_is_rejected_without_changing_source_or_store(self) -> None:
        sources, store = snapshot(self.repo / 'packages'), snapshot(self.store)
        result = self.build('rejected', EXTERNAL_LINK='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('bundle link escapes release: packages/adapter-sdk/external-link', result.stderr)
        self.assertEqual(snapshot(self.repo / 'packages'), sources)
        self.assertEqual(snapshot(self.store), store)

    def test_second_protocol_compile_does_not_hit_eacces(self) -> None:
        first = self.build('first')
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.build('second')
        self.assertEqual(second.returncode, 0, second.stderr)

    def test_umask_bundles_match_supervisor_copy_digest(self) -> None:
        digests = []
        for name, mask in [('private-umask', 0o077), ('standard-umask', 0o022)]:
            result = self.build(name, umask=mask)
            self.assertEqual(result.returncode, 0, result.stderr)
            release = self.directory / name
            expected_digest = result.stdout.splitlines()[0]
            self.assertEqual(bundle_digest(release), expected_digest)

            package = release / 'packages/adapter-sdk'
            executable = package / 'dist/src/bin/claude.js'
            internal_link = package / 'node_modules/.bin/adapter'
            self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o555)
            self.assertEqual(stat.S_IMODE((package / 'metadata.json').stat().st_mode), 0o444)
            self.assertTrue(internal_link.is_symlink())
            self.assertTrue(internal_link.resolve(strict=True).is_relative_to(release))

            copied = self.directory / f'{name}-supervisor-copy'
            old_umask = os.umask(mask)
            try:
                shutil.copytree(release, copied, symlinks=True)
            finally:
                os.umask(old_umask)
            subprocess.run(['chmod', '-R', 'u=rX,go=rX', str(copied)], check=True, timeout=10)
            self.assertEqual(bundle_digest(copied), expected_digest)
            self.assertTrue((copied / 'packages/adapter-sdk/node_modules/.bin/adapter').is_symlink())
            for path in [release, *release.rglob('*'), copied, *copied.rglob('*')]:
                if path.is_symlink():
                    continue
                mode = stat.S_IMODE(path.stat().st_mode)
                expected_mode = 0o555 if path.is_dir() or mode & 0o111 else 0o444
                self.assertEqual(mode, expected_mode, str(path))
            digests.append(expected_digest)
        self.assertEqual(digests[0], digests[1])

    def test_existing_destination_is_rejected_without_mutation(self) -> None:
        result = self.build('first')
        self.assertEqual(result.returncode, 0, result.stderr)
        before = snapshot(self.directory / 'first')
        result = self.build('first')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('release destination must be absolute and must not exist', result.stderr)
        self.assertEqual(snapshot(self.directory / 'first'), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
