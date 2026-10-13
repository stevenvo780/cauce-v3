from __future__ import annotations

import json
import os
import pathlib
import subprocess
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = OPS / 'scripts/v4-medicion-migracion.sh'
MARKER = 'MATERIAL-QUE-NO-VIAJA'
GIT_ENV = {'GIT_AUTHOR_NAME': 'fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid', 'GIT_COMMITTER_NAME': 'fixture',
           'GIT_COMMITTER_EMAIL': 'fixture@example.invalid', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'}


def git(directory: pathlib.Path, *arguments: str) -> str:
    return subprocess.run(['git', '-C', str(directory), *arguments], check=True, capture_output=True, text=True,
                          env={**os.environ, **GIT_ENV}).stdout.strip()


def write(path: pathlib.Path, text: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


class CopyAndRestoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-v4-copia-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.source = self.root / 'origen'
        project = self.source / 'clawd'
        git(self.root, 'init', '-q', '-b', 'principal', str(project))
        write(project / 'AGENTS.md', 'contexto v1\n')
        write(project / 'tool.sh', '#!/bin/sh\necho ok\n', 0o755)
        write(project / 'borrar.md', 'se borra\n')
        write(project / '.gitignore', 'data/\nnode_modules/\n')
        (project / 'enlace').symlink_to('AGENTS.md')
        git(project, 'add', '-A')
        git(project, 'commit', '-q', '-m', 'inicial')
        git(project, 'remote', 'add', 'origin', 'https://usuario:secreto@example.invalid/owner/clawd.git')
        git(project, 'branch', 'otra-rama')
        write(project / 'AGENTS.md', 'contexto v2 sin commit\n')
        (project / 'borrar.md').unlink()
        write(project / 'nuevo.md', 'sin seguimiento\n')
        write(project / 'data/envios.jsonl', '{"n": 1}\n' * 50)
        write(project / 'node_modules/pkg/index.js', 'regenerable\n')
        write(project / 'auth.json', MARKER)
        write(project / 'sessions/abc.jsonl', MARKER)
        nested = project / 'work/otro'
        git(self.root, 'init', '-q', '-b', 'main', str(nested))
        write(nested / 'README.md', 'repo anidado\n')
        git(nested, 'add', '-A')
        git(nested, 'commit', '-q', '-m', 'anidado')
        git(nested, 'checkout', '-q', '--detach')
        self.nested_head = git(nested, 'rev-parse', 'HEAD')
        self.head = git(project, 'rev-parse', 'HEAD')
        data = self.source / 'datos'
        write(data / 'catalogo.pdf', 'pdf' * 1000)
        write(data / 'script.py', 'print(1)\n', 0o750)
        (data / 'vacio').mkdir()
        write(data / 'token.txt', MARKER)
        write(data / 'chrome-profile/Default/Cookies', MARKER)
        write(data / '.env', MARKER)
        write(data / 'cabecera.hdr', MARKER)
        os.mkfifo(data / 'tuberia')
        self.copy = self.root / 'copia'

    def cli(self, *arguments):
        return subprocess.run(['bash', str(SCRIPT), *arguments], capture_output=True, text=True, timeout=300,
                              env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})

    def make_copy(self):
        done = self.cli('copiar', '--alias', 'gaia', '--origen', f'clawd={self.source / "clawd"}',
                        '--origen', f'datos={self.source / "datos"}', '--destino', str(self.copy))
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads((self.copy / 'manifest.json').read_text())

    def test_manifest_keeps_projects_by_git_data_by_sha256_and_omits_with_reasons(self):
        manifest = self.make_copy()
        repos = {repo['path']: repo for repo in manifest['repositories']}
        self.assertEqual(repos['clawd']['head'], self.head)
        self.assertEqual(repos['clawd']['branch'], 'principal')
        self.assertEqual(repos['clawd']['remotes'], {'origin': 'https://example.invalid/owner/clawd.git'})
        self.assertEqual(repos['clawd']['deleted'], ['clawd/borrar.md'])
        self.assertEqual((repos['clawd/work/otro']['head'], repos['clawd/work/otro']['branch']), (self.nested_head, None))
        entries = {entry['path']: entry for entry in manifest['entries']}
        self.assertEqual(entries['clawd/tool.sh']['source'], 'git')
        self.assertEqual(entries['clawd/enlace']['source'], 'git')
        for path in ('clawd/AGENTS.md', 'clawd/nuevo.md', 'clawd/data/envios.jsonl', 'datos/catalogo.pdf'):
            self.assertEqual(entries[path]['source'], 'data', path)
            self.assertRegex(entries[path]['sha256'], r'^[0-9a-f]{64}$')
        reasons = {item['path']: item['reason'] for item in manifest['omissions']}
        self.assertEqual(reasons, {
            'clawd/auth.json': 'auth', 'clawd/sessions': 'session', 'clawd/node_modules': 'regenerable',
            'datos/token.txt': 'token', 'datos/chrome-profile': 'profile', 'datos/.env': 'credential',
            'datos/cabecera.hdr': 'credential', 'datos/tuberia': 'special'})
        self.assertNotIn(MARKER, ''.join(p.read_text(errors='replace') for p in self.copy.rglob('*') if p.is_file()))
        checked = self.cli('comprobar-copia', str(self.copy))
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertTrue(json.loads(checked.stdout)['verified'])

    def test_test_restore_is_verified_and_leaves_no_scratch(self):
        self.make_copy()
        before = set(pathlib.Path(tempfile.gettempdir()).glob('cauce-v4-restauracion-*'))
        done = self.cli('restaurar', str(self.copy), '--recibo', str(self.root / 'recibo.json'))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(json.loads(done.stdout)['verified'])
        self.assertEqual(set(pathlib.Path(tempfile.gettempdir()).glob('cauce-v4-restauracion-*')), before)
        receipt = json.loads((self.root / 'recibo.json').read_text())
        self.assertEqual(receipt['problems'], [])

    def test_restore_into_normalized_layout_reproduces_heads_and_bytes(self):
        self.make_copy()
        target = self.root / 'espacio'
        done = self.cli('restaurar', str(self.copy), '--destino', str(target), '--mapa', 'clawd=projects/gaia-clawd',
                        '--mapa', 'datos=data', '--recibo', str(self.root / 'recibo.json'))
        self.assertEqual(done.returncode, 0, done.stderr)
        project = target / 'projects/gaia-clawd'
        self.assertEqual(git(project, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(git(project, 'symbolic-ref', '--short', 'HEAD'), 'principal')
        self.assertIn('otra-rama', git(project, 'branch', '--list'))
        self.assertEqual(git(project, 'remote', 'get-url', 'origin'), 'https://example.invalid/owner/clawd.git')
        self.assertEqual(git(project / 'work/otro', 'rev-parse', 'HEAD'), self.nested_head)
        self.assertEqual((project / 'AGENTS.md').read_text(), 'contexto v2 sin commit\n')
        self.assertFalse((project / 'borrar.md').exists())
        self.assertEqual((project / 'data/envios.jsonl').read_text(), '{"n": 1}\n' * 50)
        self.assertTrue(os.access(project / 'tool.sh', os.X_OK))
        self.assertEqual(os.readlink(project / 'enlace'), 'AGENTS.md')
        self.assertEqual((target / 'data/script.py').stat().st_mode & 0o777, 0o750)
        self.assertTrue((target / 'data/vacio').is_dir())
        for missing in ('auth.json', 'sessions', 'node_modules'):
            self.assertFalse((project / missing).exists(), missing)
        receipt = json.loads((self.root / 'recibo.json').read_text())
        moved = {item['from']: item['to'] for item in receipt['layout']}
        self.assertEqual(moved['clawd/AGENTS.md'], 'projects/gaia-clawd/AGENTS.md')
        self.assertEqual(moved['datos/catalogo.pdf'], 'data/catalogo.pdf')
        self.assertTrue(receipt['verified'])

    def test_damage_and_unsafe_requests_fail_closed(self):
        manifest = self.make_copy()
        split = self.cli('restaurar', str(self.copy), '--mapa', 'clawd/data=data')
        self.assertEqual(split.returncode, 2)
        self.assertIn('splits repository', split.stderr)
        inside = self.cli('copiar', '--alias', 'gaia', '--origen', f'datos={self.source / "datos"}',
                          '--destino', str(self.source / 'datos/copia'))
        self.assertEqual(inside.returncode, 2)
        blob = next(e['sha256'] for e in manifest['entries'] if e['path'] == 'datos/catalogo.pdf')
        (self.copy / 'data' / blob[:2] / blob).write_text('alterado')
        damaged = self.cli('comprobar-copia', str(self.copy))
        self.assertEqual(damaged.returncode, 2)
        self.assertIn('not recoverable', damaged.stderr)
        restored = self.cli('restaurar', str(self.copy))
        self.assertEqual(restored.returncode, 1)
        (self.copy / 'manifest.json').write_text((self.copy / 'manifest.json').read_text().replace('gaia', 'hades'))
        self.assertEqual(self.cli('comprobar-copia', str(self.copy)).returncode, 2)


if __name__ == '__main__':
    unittest.main()
