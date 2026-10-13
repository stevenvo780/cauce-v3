from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'scripts'))
import v4_copia_migracion as copia  # noqa: E402

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


FAKE_DOCKER = '''#!/usr/bin/env python3
import json, os, sys
layout = json.load(open(os.environ['CAUCE_TEST_DOCKER']))
if sys.argv[1:3] == ['ps', '-aq']:
    print('\\n'.join(layout))
elif sys.argv[1:3] == ['container', 'inspect']:
    print(json.dumps([{'Name': '/' + name, 'Mounts': [{'Source': s, 'Destination': d} for s, d in layout[name]]}
                      for name in sys.argv[3:]]))
else:
    sys.exit(1)
'''


def agent(tenant: str, container: str, home: str, workspace: str | None = None) -> dict:
    entry = {'tenant': tenant, 'container': container, 'home': home, 'user': 'dev', 'systemdUser': 'stev',
             'room': 'grp.x', 'harness': 'codex', 'membershipRole': 'agent',
             'stateDirectory': f'{home}/.local/state/cauce-v3/{container}'}
    return {**entry, 'workspace': workspace} if workspace else entry


class Scoped(unittest.TestCase):
    """Copies are scoped to one alias and company; Docker answers from a fixed layout so the suite stays hermetic."""

    def scoped(self, aliases: dict, containers: dict, alias: str, tenant: str) -> None:
        self.alias, self.tenant = alias, tenant
        self.config = self.root / 'container-aliases.json'
        self.config.write_text(json.dumps({'schemaVersion': 1, 'aliases': aliases}))
        self.containers = {name: [(os.path.realpath(source), destination) for source, destination in mounts]
                           for name, mounts in containers.items()}
        layout = self.root / 'docker-layout.json'
        layout.write_text(json.dumps(self.containers))
        fake = self.root / 'bin'
        fake.mkdir(exist_ok=True)
        write(fake / 'docker', FAKE_DOCKER, 0o700)
        self.env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PATH': f'{fake}:{os.environ["PATH"]}',
                    'CAUCE_TEST_DOCKER': str(layout)}

    def cli(self, *arguments):
        arguments = [str(item) for item in arguments]
        if arguments[0] == 'copiar' and '--empresa' not in arguments:
            arguments[1:1] = ['--empresa', self.tenant, '--config', str(self.config)]
        if arguments[0] == 'restaurar' and '--alias' not in arguments:
            arguments += ['--alias', self.alias, '--empresa', self.tenant]
        return subprocess.run(['bash', str(SCRIPT), *arguments], capture_output=True, text=True, timeout=300,
                              env=self.env)


class CopyAndRestoreTests(Scoped):
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
        write(project / 'AGENTS.md.bak-2', 'copia vieja\n')
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
        self.scoped({'gaia': agent('Miguel', 'c-gaia', '/home/claw', '/home/claw/clawd')},
                    {'c-gaia': [(project, '/home/claw/clawd'), (data, '/home/claw/datos')]}, 'gaia', 'Miguel')

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
                        '--mapa', 'datos=data', '--omitir', '*.bak*', '--duplicar', 'clawd/AGENTS.md=context/AGENTS.md',
                        '--recibo', str(self.root / 'recibo.json'))
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
        self.assertEqual(receipt['excludedByLayout'], ['clawd/AGENTS.md.bak-2'])
        self.assertFalse((project / 'AGENTS.md.bak-2').exists())
        self.assertEqual((target / 'context/AGENTS.md').read_text(), 'contexto v2 sin commit\n')
        self.assertEqual(moved['clawd/AGENTS.md'], 'projects/gaia-clawd/AGENTS.md')

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
        self.assertEqual(restored.returncode, 2)
        self.assertIn('does not match the manifest', restored.stderr)
        (self.copy / 'manifest.json').write_text((self.copy / 'manifest.json').read_text().replace('gaia', 'hades'))
        self.assertEqual(self.cli('comprobar-copia', str(self.copy)).returncode, 2)


def private_key() -> str:
    return '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----\nAAAAB3Nza\n'


def github_token() -> str:
    return 'gh' + 'p_' + 'Z9' * 18


class SecurityTests(Scoped):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-v4-copia-seg-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.source = self.root / 'origen'
        self.outside = self.root / 'fuera'
        write(self.outside / 'robado.txt', 'CONTENIDO-DE-FUERA')
        project = self.source / 'proyecto'
        git(self.root, 'init', '-q', '-b', 'main', str(project))
        write(project / 'README.md', 'hola\n')
        write(project / 'fixture.md', 'token de prueba ' + github_token() + '\n')
        (project / 'salida').symlink_to(self.outside)
        git(project, 'add', '-A')
        git(project, 'commit', '-q', '-m', 'inicial')
        git(project, 'remote', 'add', 'origin', 'https://u:pa/ss@example.invalid/x.git')
        git(project, 'remote', 'add', 'peligro', 'ext::sh -c touch% /tmp/x')
        git(project, 'remote', 'add', 'limpio', 'git@example.invalid:owner/x.git')
        write(project / 'notas.txt', private_key())
        os.link(project / 'notas.txt', project / 'copia-inocente.txt')
        write(project / 'config.yaml', 'api_key: ' + 'q' * 24 + '\n')
        write(project / 'ａｕｔｈ.json', 'oculto')
        data = self.source / 'datos'
        write(data / 'ok.txt', 'benigno\n')
        write(data / 'setuid.sh', '#!/bin/sh\n')
        os.chmod(data / 'setuid.sh', 0o4755)
        write(data / 'abierto.txt', 'abierto\n')
        os.chmod(data / 'abierto.txt', 0o777)
        (data / 'absoluto').symlink_to('/etc/hostname')
        (data / 'escapa').symlink_to('../../fuera/robado.txt')
        (data / 'victima').mkdir()
        write(data / 'victima/v.txt', 'v\n')
        self.copy = self.root / 'copia'
        aliases = {'hades': agent('Steven', 'c-hades', '/home/claw')}
        self.scoped(aliases, {'c-hades': [(project, '/home/claw/proyecto'), (data, '/home/claw/datos')]},
                    'hades', 'Steven')
        self.scope = copia.tenant_scope({'aliases': aliases}, 'hades', 'Steven', self.containers)

    def make_copy(self):
        done = self.cli('copiar', '--alias', 'hades', '--origen', f'proyecto={self.source / "proyecto"}',
                        '--origen', f'datos={self.source / "datos"}', '--destino', str(self.copy))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.streams = done.stdout + done.stderr
        return json.loads((self.copy / 'manifest.json').read_text())

    def copied_bytes(self) -> bytes:
        return b''.join(path.read_bytes() for path in self.copy.rglob('*') if path.is_file() and not path.is_symlink())

    def reseal(self, change) -> None:
        manifest = json.loads(self.original)
        change(manifest)
        manifest['sha256'] = copia.seal(manifest)
        (self.copy / 'manifest.json').write_text(json.dumps(manifest))

    def test_finding1_credentials_are_excluded_by_content_hardlink_and_unicode_name(self):
        manifest = self.make_copy()
        reasons = {item['path']: item['reason'] for item in manifest['omissions']}
        for path in ('proyecto/notas.txt', 'proyecto/copia-inocente.txt', 'proyecto/config.yaml'):
            self.assertEqual(reasons[path], 'sensitive-content', path)
        self.assertEqual(reasons['proyecto/ａｕｔｈ.json'], 'auth')
        repo, = manifest['repositories']
        self.assertEqual(repo['trackedSensitive'], ['proyecto/fixture.md'])
        self.assertEqual(repo['remotes'], {'limpio': 'git@example.invalid:owner/x.git'})
        self.assertEqual(repo['droppedRemotes'], ['origin', 'peligro'])

    def test_finding2_no_credential_reaches_copy_manifest_or_output(self):
        self.make_copy()
        stored = self.copied_bytes()
        for secret in (private_key(), 'q' * 24, 'oculto', 'pa/ss', 'ext::', 'CONTENIDO-DE-FUERA'):
            self.assertNotIn(secret.encode(), stored, secret)
            self.assertNotIn(secret, self.streams)
        manifest_text = (self.copy / 'manifest.json').read_text()
        self.assertNotIn(str(self.source), manifest_text)
        self.assertNotIn(str(self.root), manifest_text)
        for command in (('comprobar-copia', str(self.copy)), ('restaurar', str(self.copy))):
            output = self.cli(*command)
            self.assertEqual(output.returncode, 0, output.stderr)
            self.assertNotIn(github_token(), output.stdout + output.stderr)

    def test_finding3_paths_swapped_for_symlinks_mid_copy_are_refused(self):
        original = copia.open_verified

        def swap_directory(parent, name, expected, flags):
            if name == 'victima':
                os.rename(name, 'victima.old', src_dir_fd=parent, dst_dir_fd=parent)
                os.symlink(str(self.outside), name, dir_fd=parent)
            return original(parent, name, expected, flags)

        def swap_file(parent, name, expected, flags):
            if name == 'ok.txt':
                os.rename(name, 'ok.old', src_dir_fd=parent, dst_dir_fd=parent)
                os.symlink(str(self.outside / 'robado.txt'), name, dir_fd=parent)
            return original(parent, name, expected, flags)

        def replace_file(parent, name, expected, flags):
            if name == 'abierto.txt':
                os.rename(name, 'abierto.old', src_dir_fd=parent, dst_dir_fd=parent)
                os.close(os.open(name, os.O_WRONLY | os.O_CREAT, 0o644, dir_fd=parent))
            return original(parent, name, expected, flags)
        for attempt, racer in enumerate((swap_directory, swap_file, replace_file)):
            with self.subTest(racer=racer.__name__), mock.patch.object(copia, 'open_verified', racer):
                target = self.root / f'carrera-{attempt}'
                with self.assertRaises((OSError, copia.Failure)):
                    copia.copy('hades', [f'datos={self.source / "datos"}'], str(target), self.scope)
                stored = b''.join(p.read_bytes() for p in target.rglob('*') if p.is_file())
                self.assertNotIn(b'CONTENIDO-DE-FUERA', stored)
            for left, back in (('victima.old', 'victima'), ('ok.old', 'ok.txt'), ('abierto.old', 'abierto.txt')):
                if (self.source / 'datos' / left).exists():
                    (self.source / 'datos' / back).unlink()
                    (self.source / 'datos' / left).rename(self.source / 'datos' / back)

    def test_finding4_restore_validates_manifest_modes_links_and_destinations(self):
        self.make_copy()
        self.original = (self.copy / 'manifest.json').read_text()
        target = self.root / 'restaurado'
        done = self.cli('restaurar', str(self.copy), '--destino', str(target), '--recibo', str(self.root / 'r.json'))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((target / 'datos/setuid.sh').stat().st_mode & 0o7777, 0o755)
        self.assertEqual((target / 'datos/abierto.txt').stat().st_mode & 0o7777, 0o775)
        reasons = {item['path']: item['reason'] for item in json.loads(self.original)['omissions']}
        self.assertEqual((reasons['datos/absoluto'], reasons['datos/escapa']), ('symlink-outside', 'symlink-outside'))
        self.assertFalse((target / 'datos/escapa').is_symlink())
        self.assertNotIn(str(self.outside), self.original)
        self.reseal(lambda m: m['entries'].append({'path': 'datos/plantado', 'kind': 'symlink', 'source': 'data',
                                                   'target': '../../fuera/robado.txt'}))
        planted = self.root / 'plantado'
        done = self.cli('restaurar', str(self.copy), '--destino', str(planted), '--recibo', str(self.root / 'p.json'))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads((self.root / 'p.json').read_text())['skippedUnsafeSymlinks'], ['datos/plantado'])
        self.assertFalse((planted / 'datos/plantado').is_symlink())
        again = self.cli('restaurar', str(self.copy), '--destino', str(target), '--recibo', str(self.root / 'r.json'))
        self.assertEqual(again.returncode, 2)
        linked = self.root / 'enlace-destino'
        linked.symlink_to(self.outside)
        self.assertEqual(self.cli('restaurar', str(self.copy), '--destino', str(linked)).returncode, 2)
        blob = next(e['sha256'] for e in json.loads(self.original)['entries'] if e['path'] == 'datos/ok.txt')
        tampering = {
            'traversal': lambda m: m['entries'].append({'path': '../evil', 'kind': 'file', 'mode': 420, 'sha256': blob,
                                                        'source': 'data', 'bytes': 1}),
            'digest-path': lambda m: next(e for e in m['entries'] if e['path'] == 'datos/ok.txt').update(
                sha256='../../../../etc/hostname'),
            'deletion-outside': lambda m: m['repositories'][0]['deleted'].append('datos/ok.txt'),
            'command-remote': lambda m: m['repositories'][0]['remotes'].update(x='ext::sh -c id'),
            'option-branch': lambda m: m['repositories'][0].update(branch='--orphan=x'),
            'option-head': lambda m: m['repositories'][0].update(head='--detach'),
            'through-git-symlink': lambda m: m['entries'].append({'path': 'proyecto/salida/plantado.txt', 'kind': 'file',
                                                                  'mode': 420, 'sha256': blob, 'source': 'data',
                                                                  'bytes': 1}),
        }
        reasons = {'traversal': 'unsafe manifest path', 'digest-path': 'digest is invalid',
                   'deletion-outside': 'leaves its repository', 'command-remote': 'remote is unsafe',
                   'option-branch': 'repository is invalid', 'option-head': 'repository is invalid',
                   'through-git-symlink': 'escapes the destination'}
        for name, change in tampering.items():
            with self.subTest(name=name):
                self.reseal(change)
                result = self.cli('restaurar', str(self.copy))
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn(reasons[name], result.stderr)
        self.assertEqual(sorted(p.name for p in self.outside.iterdir()), ['robado.txt'])
        with mock.patch.object(copia.os, 'geteuid', return_value=0), self.assertRaises(copia.Failure):
            copia.ownership(None)
        self.assertEqual(copia.ownership('1000:1000'), (1000, 1000))


class CompanyIsolationTests(Scoped):
    """Two companies on one host: copying an agent of one never carries anything of the other."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-v4-copia-empresas-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        tenants = self.root / 'tenants'
        write(tenants / 'uno/ana/clawd/notas.md', 'datos de ana\n')
        write(tenants / 'dos/bea/clawd/cliente.md', 'CLIENTE-DE-LA-EMPRESA-DOS\n')
        write(tenants / 'compartido/comun.md', 'COMUN-A-AMBAS\n')
        config = self.root / 'humanizar-config/cauce-v3/config'
        write(config / 'carla/settings.json', '{"empresa": "uno"}\n')
        write(config / 'dario/settings.json', '{"empresa": "DOS-PRIVADO"}\n')
        self.aliases = {
            'ana': agent('Uno', 'c-ana', '/home/a', '/home/a/clawd'),
            'bea': agent('Dos', 'c-bea', '/home/b', '/home/b/clawd'),
            'carla': agent('Uno', 'c-ws', '/home/dev'),
            'dario': agent('Dos', 'c-ws', '/home/dev'),
        }
        self.scoped(self.aliases, {
            'c-ana': [(tenants / 'uno/ana/clawd', '/home/a/clawd'), (tenants / 'compartido', '/srv/compartido')],
            'c-bea': [(tenants / 'dos/bea/clawd', '/home/b/clawd'), (tenants / 'compartido', '/srv/compartido')],
            'c-ws': [(self.root / 'humanizar-config', '/home/dev/.local/share')],
        }, 'ana', 'Uno')
        self.tenants, self.config_root = tenants, config

    def copy_of(self, alias, tenant, **sources):
        target = self.root / f'copia-{alias}-{len(list(self.root.glob("copia-*")))}'
        origins = [item for name, path in sources.items() for item in ('--origen', f'{name}={path}')]
        return target, self.cli('copiar', '--alias', alias, '--empresa', tenant, '--config', self.config, *origins,
                                '--destino', target)

    def test_copy_of_one_company_carries_nothing_of_the_other(self):
        target, done = self.copy_of('ana', 'Uno', clawd=self.tenants / 'uno/ana/clawd')
        self.assertEqual(done.returncode, 0, done.stderr)
        manifest = json.loads((target / 'manifest.json').read_text())
        self.assertEqual((manifest['alias'], manifest['tenant'], manifest['container']), ('ana', 'Uno', 'c-ana'))
        self.assertEqual([e['path'] for e in manifest['entries'] if e['kind'] == 'file'], ['clawd/notas.md'])
        stored = b''.join(p.read_bytes() for p in target.rglob('*') if p.is_file())
        for foreign in (b'CLIENTE-DE-LA-EMPRESA-DOS', b'COMUN-A-AMBAS', b'DOS-PRIVADO', b'cliente.md', b'bea'):
            self.assertNotIn(foreign, stored)
        _, carla = self.copy_of('carla', 'Uno', config=self.config_root / 'carla')
        self.assertEqual(carla.returncode, 0, carla.stderr)

    def test_sources_outside_the_alias_space_or_company_are_refused(self):
        refused = {
            'other company volume': ('ana', 'Uno', {'clawd': self.tenants / 'dos/bea/clawd'}, 'outside the space'),
            'volume shared by both': ('ana', 'Uno', {'comun': self.tenants / 'compartido'}, 'outside the space'),
            'parent of both agents': ('ana', 'Uno', {'todo': self.tenants}, 'outside the space'),
            'wrong company': ('ana', 'Dos', {'clawd': self.tenants / 'uno/ana/clawd'}, 'does not belong'),
            'whole shared config': ('carla', 'Uno', {'cfg': self.root / 'humanizar-config'}, 'outside the space'),
            'sibling of other company': ('carla', 'Uno', {'cfg': self.config_root / 'dario'}, 'outside the space'),
            'config of both': ('carla', 'Uno', {'cfg': self.config_root}, 'outside the space'),
        }
        for name, (alias, tenant, sources, reason) in refused.items():
            with self.subTest(name=name):
                target, done = self.copy_of(alias, tenant, **sources)
                self.assertEqual(done.returncode, 2, done.stdout)
                self.assertIn(reason, done.stderr)
                self.assertFalse(target.exists())

    def test_restore_refuses_a_copy_of_another_alias_company_or_space(self):
        target, done = self.copy_of('ana', 'Uno', clawd=self.tenants / 'uno/ana/clawd')
        self.assertEqual(done.returncode, 0, done.stderr)
        for alias, tenant in (('bea', 'Dos'), ('ana', 'Dos'), ('bea', 'Uno')):
            result = self.cli('restaurar', target, '--alias', alias, '--empresa', tenant)
            self.assertEqual(result.returncode, 2)
            self.assertIn('another alias or company', result.stderr)
        manifest = json.loads((target / 'manifest.json').read_text())
        manifest['entries'].append({'path': 'otro-espacio/x.md', 'kind': 'directory', 'mode': 493})
        manifest['sha256'] = copia.seal(manifest)
        (target / 'manifest.json').write_text(json.dumps(manifest))
        tampered = self.cli('restaurar', target)
        self.assertEqual(tampered.returncode, 2)
        self.assertIn('outside the copied space', tampered.stderr)


if __name__ == '__main__':
    unittest.main()
