# cauce:requiere docker
# cauce:timeout-ms 600000
from __future__ import annotations

import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import unittest

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'tests'))
import disposable_docker  # noqa: E402

SCRIPT = OPS / 'scripts/v4-medicion-migracion.sh'
SECRET = 'CONTENIDO-QUE-NO-SE-LEE'
FAKE_SSH = '''#!/usr/bin/env bash
# Runs the remote command locally so the declared route is exercised without a network.
printf '%s\\n' "$@" >>"$CAUCE_TEST_SSH_LOG"
for last; do :; done
exec bash -c "$last"
'''


def tree_bytes(path: pathlib.Path) -> int:
    total = path.lstat().st_size
    for root, dirs, names in os.walk(path):
        total += sum((pathlib.Path(root) / item).lstat().st_size for item in dirs + names)
    return total


class MeasurementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        reason = disposable_docker.unavailable_reason()
        if reason:
            if disposable_docker.required():
                raise AssertionError(reason)
            raise unittest.SkipTest(reason)
        cls.temporary = tempfile.TemporaryDirectory(prefix='cauce-v4-medicion-', dir='/var/tmp')
        cls.root = pathlib.Path(cls.temporary.name)
        cls.docker = disposable_docker.Disposable('v4-medicion')
        try:
            cls.prepare()
        except BaseException:
            cls.docker.cleanup()
            cls.temporary.cleanup()
            raise

    @classmethod
    def prepare(cls):
        cls.docker.build()
        own, shared, config = (cls.root / name for name in ('own', 'shared', 'config'))
        (own / 'repo').mkdir(parents=True)
        (own / 'repo/notes.md').write_text('x' * 4096)
        (own / 'data.bin').write_bytes(b'\0' * 10_000)
        shared.mkdir()
        (shared / 'common.txt').write_text('y' * 777)
        (config / 'cauce-v3/config/dos').mkdir(parents=True)
        (config / 'cauce-v3/config/dos/settings.json').write_text(SECRET + 'z' * 50)
        for path in (own, shared, config):
            os.chmod(path, 0o777)
        cls.one = cls.docker.run('uno', '--user', 'node', '-v', f'{own}:/home/node/clawd', '-v', f'{shared}:/srv/compartido:ro')
        cls.two = cls.docker.run('dos', '--user', 'node', '-v', f'{config}:/home/node/.local/share',
                                 '-v', f'{shared}:/srv/compartido')
        state = '/home/node/.local/state/cauce-v3'
        cls.sh(cls.one, f'mkdir -p {state}/uno && printf "{SECRET}%01234d" 0 > {state}/uno/state.json')
        cls.sh(cls.two, f'mkdir -p {state}/dos && head -c 100 /dev/zero > {state}/dos/s')
        for alias in ('uno', 'cuatro'):
            disposable_docker.docker('exec', '-d', '--user', 'node', cls.one, 'bash', '-c',
                                     f'exec -a "cauce-adapter --alias {alias} --secret-flag" sleep 600')
        disposable_docker.docker('exec', '--user', 'node', cls.two, 'tmux', '-L', 'cauce', 'new-session', '-d',
                                 '-s', 'cauce-dos', '-n', 'agente', 'exec sleep 600')
        entry = {'user': 'node', 'home': '/home/node', 'systemdUser': 'stev', 'tenant': 'T', 'room': 'grp.t',
                 'membershipRole': 'agent'}
        cls.config = cls.root / 'container-aliases.json'
        cls.config.write_text(json.dumps({'schemaVersion': 1, 'aliases': {
            'uno': {**entry, 'container': cls.one, 'workspace': '/home/node/clawd', 'harness': 'grok',
                    'stateDirectory': '/home/node/.local/state/cauce-v3/uno'},
            'dos': {**entry, 'container': cls.two, 'harness': 'muse', 'stateDirectory': '/home/node/.local/state/cauce-v3/dos'},
            'tres': {**entry, 'container': cls.two, 'harness': 'claude',
                     'stateDirectory': '/home/node/.local/state/cauce-v3/tres'},
            'cuatro': {**entry, 'container': cls.one, 'dockerHost': 'server2', 'systemdUser': 'server',
                       'harness': 'claude', 'stateDirectory': '/home/node/.local/state/cauce-v3/cuatro'}}}))
        cls.before = cls.root / 'antes.json'
        done = cls.cli('medir', '--local', '--label', 'antes', '--config', str(cls.config), '--out', str(cls.before),
                       'uno', 'dos', 'tres')
        assert done.returncode == 0, done.stderr
        cls.receipt = json.loads(cls.before.read_text())

    @classmethod
    def tearDownClass(cls):
        residue = cls.docker.cleanup()
        cls.temporary.cleanup()
        if residue:
            raise AssertionError(f'disposable Docker resources survived: {residue}')

    @classmethod
    def sh(cls, container, script):
        disposable_docker.docker('exec', '--user', '0', container, 'bash', '-c',
                                 script + ' && chown -R node:node /home/node/.local/state')

    @classmethod
    def cli(cls, *arguments, env=None):
        return subprocess.run(['bash', str(SCRIPT), *arguments], capture_output=True, text=True, timeout=600,
                              env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', **(env or {})})

    def in_container_bytes(self, container, path):
        out = disposable_docker.docker('exec', '--user', '0', container, 'find', path, '-printf', '%s\\n').stdout
        return sum(int(line) for line in out.split())

    def test_receipt_is_sealed_and_records_the_physical_host(self):
        verified = self.cli('verificar', str(self.before))
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(self.receipt['host']['hostname'], socket.gethostname())
        self.assertRegex(self.receipt['host']['machineIdSha256'], r'^[0-9a-f]{16}$')
        for key in ('memory', 'swap', 'disk', 'load'):
            self.assertIn(key, self.receipt)
        self.assertEqual(self.receipt['errors'], [])
        tampered = self.root / 'manipulado.json'
        tampered.write_text(self.before.read_text().replace('"antes"', '"despues"'))
        self.assertEqual(self.cli('verificar', str(tampered)).returncode, 2)

    def test_own_sizes_follow_the_single_scope_without_reading_content(self):
        uno, dos, tres = (self.receipt['aliases'][a] for a in ('uno', 'dos', 'tres'))
        own_mount = tree_bytes(self.root / 'own')
        state = self.in_container_bytes(self.one, '/home/node/.local/state/cauce-v3/uno')
        self.assertEqual(uno['ownBytes'], own_mount + state)
        self.assertEqual(uno['sharedBytes'], tree_bytes(self.root / 'shared'))
        self.assertEqual(uno['sharedMounts'], ['/srv/compartido'])
        roles = {item['role']: item for item in uno['paths']}
        self.assertEqual(roles['espacio']['within'], '/home/node/clawd')
        self.assertEqual(roles['estado']['within'], 'writable-layer')
        self.assertFalse(roles['configuracion']['exists'])
        config = tree_bytes(self.root / 'config/cauce-v3/config/dos')
        self.assertEqual(dos['ownBytes'], self.in_container_bytes(self.two, '/home/node/.local/state/cauce-v3/dos') + config)
        self.assertEqual(dos['sharedBytes'], tree_bytes(self.root / 'config') + tree_bytes(self.root / 'shared'))
        self.assertEqual(dos['containerAliases'], ['dos', 'tres'])
        self.assertEqual(tres['ownBytes'], 0)
        text = self.before.read_text()
        self.assertNotIn(SECRET, text)
        self.assertNotIn('--alias', text)
        self.assertNotIn('secret-flag', text)

    def test_processes_and_correlation(self):
        uno, dos, tres = (self.receipt['aliases'][a] for a in ('uno', 'dos', 'tres'))
        self.assertEqual((uno['adapters'], uno['roots']), (1, 1))
        self.assertGreater(uno['rssBytes'], 0)
        self.assertEqual(uno['rssByCommand'][0]['command'], 'sleep')
        self.assertEqual(dos['tmuxPanes'], 1)
        self.assertEqual((tres['adapters'], tres['tmuxPanes'], tres['processes']), (0, 0, 0))
        correlation = self.receipt['correlation']
        self.assertTrue(correlation['uno']['correlated'] and correlation['dos']['correlated'])
        self.assertFalse(correlation['tres']['correlated'])

    def test_copy_scope_follows_the_real_docker_mounts_and_company(self):
        def copy(tenant, name, path):
            return self.cli('copiar', '--alias', 'uno', '--empresa', tenant, '--config', str(self.config),
                            '--origen', f'{name}={path}', '--destino', str(self.root / f'copia-{name}-{tenant}'))
        own = copy('T', 'own', self.root / 'own')
        self.assertEqual(own.returncode, 0, own.stderr)
        shared = copy('T', 'shared', self.root / 'shared')
        self.assertEqual(shared.returncode, 2)
        self.assertIn('outside the space', shared.stderr)
        other = copy('Otra', 'own', self.root / 'own')
        self.assertEqual(other.returncode, 2)
        self.assertIn('does not belong', other.stderr)

    def test_declared_route_drives_the_measurement_of_a_placed_alias(self):
        fake = self.root / 'bin'
        fake.mkdir(exist_ok=True)
        (fake / 'ssh').write_text(FAKE_SSH)
        (fake / 'ssh').chmod(0o700)
        log = self.root / 'ssh.log'
        out = self.root / 'precedente.json'
        done = self.cli('medir', '--ruta-declarada', '--label', 'precedente', '--config', str(self.config),
                        '--out', str(out), 'cuatro',
                        env={'PATH': f'{fake}:{os.environ["PATH"]}', 'CAUCE_TEST_SSH_LOG': str(log)})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('server@server2', log.read_text().splitlines())
        correlation = json.loads(out.read_text())['correlation']['cuatro']
        self.assertEqual(correlation['declaredRoute'], 'ssh:server@server2')
        self.assertTrue(correlation['routeMatches'] and correlation['correlated'])
        local = self.cli('medir', '--ruta-declarada', '--label', 'x', '--config', str(self.config), 'uno')
        self.assertEqual(local.returncode, 2)
        self.assertIn('--ssh or --local', local.stderr)

    def test_zz_after_cut_uses_the_same_scope_and_compares(self):
        other = self.root / 'otro-alcance.json'
        self.assertEqual(self.cli('medir', '--local', '--label', 'otro', '--config', str(self.config), '--out', str(other),
                                  'uno').returncode, 0)
        mismatch = self.cli('comparar', str(self.before), str(other))
        self.assertEqual(mismatch.returncode, 2)
        self.assertIn('different scopes', mismatch.stderr)
        disposable_docker.docker('stop', '-t', '1', self.one)
        after = self.root / 'despues.json'
        done = self.cli('medir', '--local', '--label', 'despues', '--alcance-de', str(self.before), '--out', str(after))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(after.read_text())['scopeSha256'], self.receipt['scopeSha256'])
        report = self.cli('comparar', str(self.before), str(after))
        self.assertEqual(report.returncode, 0, report.stderr)
        delta = json.loads(report.stdout)
        self.assertTrue(delta['sameHost'])
        self.assertEqual(delta['aliases']['uno']['rssBytes'], -self.receipt['aliases']['uno']['rssBytes'])
        self.assertEqual(delta['aliases']['uno']['ownBytes'], -self.receipt['aliases']['uno']['ownBytes'])
        self.assertEqual((delta['aliases']['uno']['runningBefore'], delta['aliases']['uno']['runningAfter']), (True, False))
        self.assertEqual(delta['aliases']['dos']['ownBytes'], 0)
        self.assertEqual(self.cli('medir', '--local', '--label', 'despues', '--alcance-de', str(self.before),
                                  '--out', str(after)).returncode, 1)


if __name__ == '__main__':
    unittest.main()
