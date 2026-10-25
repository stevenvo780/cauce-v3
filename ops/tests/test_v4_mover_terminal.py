from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS.parent / 'pty-agent'))

import v4_mover_agente as mover  # noqa: E402
import v4_mover_terminal as terminal  # noqa: E402
from v4_mover_host import bundle  # noqa: E402


class TerminalMigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.code = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle()))) as archive:
            archive.extractall(cls.code.name)

    @classmethod
    def tearDownClass(cls):
        cls.code.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name)
        self.alias = 'zz-canary-pty'
        self.pki = self.home / '.config/cauce-v3/pty-pki' / self.alias
        self.env = self.home / '.config/cauce-v3/pty' / (self.alias + '.env')
        self.pki.mkdir(parents=True)
        self.env.parent.mkdir(parents=True)
        self.env.write_text('RELAY_HOST=relay.invalid\nRELAY_PORT=9445\nPKI_DIR=' + str(self.pki)
                            + '\nALIAS_KEY_FILE=' + str(self.pki / 'alias-key.hex') + '\n')
        self.env.chmod(0o600)
        for name, mode in terminal.MATERIAL.items():
            (self.pki / name).write_bytes(b'private-fixture')
            (self.pki / name).chmod(mode)
        self.request = {'alias': self.alias, 'tenant': 'Steven', 'runtime_key': self.alias, 'migration_id': 'cut-one',
                        'source': {'systemd_user': 'stev'}, 'placement': {'systemd_user': 'stev', 'host_id': 'target'},
                        'config': {'aliases': {self.alias: {'systemdUser': 'stev', 'container': 'owned', 'user': 'node'}}}}
        self.states = {'cauce-v3-pty@' + self.alias + '.service': {'enabled': 'enabled', 'active': True},
                       'cauce-v3-profile-expectation@' + self.alias + '.service': {'enabled': 'disabled', 'active': False}}
        self.commands = []
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(terminal, '__file__', str(pathlib.Path(self.code.name) / 'v4_mover_terminal.py')).start()
        mock.patch.object(terminal, 'become_manager', return_value=self.home).start()
        mock.patch('rollout_pty_lib.os.geteuid', return_value=os.geteuid() or 1000).start()
        mock.patch.object(terminal, 'systemctl', side_effect=self.systemctl).start()

    def systemctl(self, action, *args):
        self.commands.append((action, *args))
        unit = args[-1]
        if action == 'show':
            if '--property=LoadState' in args:
                return 'loaded' if unit in self.states else 'not-found'
            return self.states[unit]['enabled'] if '--property=UnitFileState' in args else (
                'active' if self.states[unit]['active'] else 'inactive')
        if action == 'disable':
            self.states[unit] = {'enabled': 'disabled', 'active': False}
        elif action == 'enable':
            self.states[unit]['enabled'] = 'enabled'
        elif action in ('start', 'stop'):
            self.states[unit]['active'] = action == 'start'
        return ''

    def call(self, action, **extra):
        return terminal.terminal_action({**self.request, **extra, 'action': 'terminal-' + action})

    def test_source_fences_both_units_and_rollback_preserves_inactive_profile(self):
        snapshot = self.call('preflight')
        expected = json.loads(json.dumps(self.states))
        with mock.patch.object(terminal, 'reap') as reaper:
            self.call('stop', terminal_source=snapshot)
            reaper.assert_called_once()
        self.assertTrue(all(not item['active'] and item['enabled'] == 'disabled' for item in self.states.values()))
        self.call('start', terminal_source=snapshot)
        self.assertEqual(expected, self.states)

    def test_pki_symlink_is_rejected_before_stopping_units(self):
        key = self.pki / 'client.key'
        key.unlink()
        key.symlink_to(self.pki / 'client.crt')
        with self.assertRaises(OSError):
            self.call('preflight')
        self.assertTrue(all(command[0] == 'show' for command in self.commands))

    def test_foreign_destination_marker_cannot_authorize_cleanup(self):
        marker = self.env.with_suffix('.migration.json')
        marker.write_text(json.dumps({'tenant': 'Other', 'alias': self.alias, 'runtime_key': self.alias, 'migration_id': 'cut-one'}))
        marker.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'another migration'):
            self.call('cleanup')
        self.assertTrue(self.env.exists())
        self.assertFalse(self.commands)

    def pin_destination(self):
        paths = {name: self.pki / name for name in terminal.MATERIAL}
        paths.update(env=self.env, selector=self.home / '.config/systemd/user' / (
            'cauce-v3-pty@' + self.alias + '.service.d/20-cauce-release.conf'))
        hashes = {name: hashlib.sha256(path.read_bytes() if path.exists() else b'fixture-selector').hexdigest()
                  for name, path in paths.items()}
        marker = self.env.with_suffix('.migration.json')
        marker.write_text(json.dumps({**{key: self.request[key] for key in ('tenant', 'alias', 'runtime_key', 'migration_id')},
                                      'file_sha256': hashes, 'container_id': 'a' * 64}))
        marker.chmod(0o600)

    def test_cleanup_rejects_changed_material_before_any_mutation(self):
        self.pin_destination()
        (self.pki / 'client.key').write_bytes(b'replaced-private-fixture')
        with self.assertRaisesRegex(ValueError, 'changed after installation'):
            self.call('cleanup')
        self.assertFalse(self.commands)
        self.assertTrue(self.env.exists())

    def test_cleanup_rejects_replaced_runtime_before_any_mutation(self):
        self.pin_destination()
        with mock.patch.object(terminal, 'destination_runtime', side_effect=ValueError('another runtime identity')):
            with self.assertRaisesRegex(ValueError, 'another runtime identity'):
                self.call('cleanup')
        self.assertFalse(self.commands)
        self.assertTrue(self.env.exists())

    def test_failed_transfer_leaves_no_private_spool_file(self):
        cut = object.__new__(mover.Cut)
        cut.receipt = {'terminal_source': {'present': True}}
        cut.source, cut.destination = mock.Mock(), mock.Mock()
        cut.terminal_request = lambda: {}
        cut.save = lambda: None
        streams = []

        def export(_action, _payload, *, destination):
            self.assertEqual(os.fstat(destination.fileno()).st_nlink, 0)
            destination.write(b'private-fixture')
            streams.append(destination)

        def install(_action, _payload, *, source):
            self.assertEqual(source.read(), b'private-fixture')
            raise RuntimeError('fixture installation failure')

        cut.source.call.side_effect = export
        cut.destination.call.side_effect = install
        with mock.patch.object(mover.pathlib.Path, 'home', return_value=self.home):
            with self.assertRaisesRegex(RuntimeError, 'installation failure'):
                cut.install_destination_terminal()
        self.assertFalse(list(self.home.glob('cauce-pty-move-*')))
        self.assertTrue(cut.receipt['terminal_destination_attempted'])
        self.assertTrue(streams[0].closed)

    def test_generated_mapping_is_accepted_by_the_real_alias_reader_for_each_harness(self):
        from container_alias_lib import load_container_aliases
        placement = {'container_name': 'owned', 'runtime_user': 'node', 'home_directory': '/home/node',
                     'state_directory': '/home/node/.cauce/owned', 'host_id': 'target', 'systemd_user': 'stev'}
        for harness in ('codex', 'openclaw', 'muse'):
            with self.subTest(harness=harness):
                config = {'schemaVersion': 2, 'systemPrincipals': {}, 'historicalAliases': {}, 'aliases': {
                    self.alias: {'tenant': 'Steven', 'room': 'ops', 'container': 'old', 'user': 'dev',
                                 'home': '/home/dev', 'stateDirectory': '/home/dev/.cauce', 'systemdUser': 'stev',
                                 'harness': harness, 'membershipRole': 'member'}}}
                generated = terminal.mapping({**self.request, 'placement': placement}, config)
                (self.home / 'container-aliases.json').write_text(json.dumps(generated))
                loaded = load_container_aliases(self.home, resolve_runtime=False)
                self.assertEqual(loaded[self.alias]['container'], 'owned')
                if harness == 'codex':
                    self.assertNotIn('workspace', loaded[self.alias])
                else:
                    self.assertEqual(loaded[self.alias]['workspace'], placement['state_directory'] + '/space/projects')


if __name__ == '__main__':
    unittest.main()
