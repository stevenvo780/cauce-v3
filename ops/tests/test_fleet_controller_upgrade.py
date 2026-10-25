#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import fleet_controller_upgrade_lib as lib

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/fleet-controller-upgrade.py'
OLD, NEW = 'a' * 40, 'b' * 40


class UpgradeFixture(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('fleet_controller_upgrade', SCRIPT)
        self.kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.kit)
        self.temporary = tempfile.TemporaryDirectory(prefix='controller-upgrade-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        real_stat = os.fstat

        def root_stat(descriptor):
            values = list(real_stat(descriptor))
            values[4] = 0
            return os.stat_result(values)

        self.owner = mock.patch.object(lib.os, 'fstat', side_effect=root_stat)
        self.owner.start()
        self.addCleanup(self.owner.stop)
        chown = mock.patch.object(lib.os, 'fchown')
        chown.start()
        self.addCleanup(chown.stop)
        self.old, self.new = self.root / OLD, self.root / NEW
        for release in (self.old, self.new):
            for tree in ('ops/cli', 'ops/scripts', 'ops/container-runtime', 'adapter', 'app'):
                (release / tree).mkdir(parents=True)

    def file(self, path, body=b'content\n', mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(mode)
        return path

    def arguments(self, *extra):
        return self.kit.parse_arguments(['--release', NEW, '--runtime-image-from', str(self.root / 'prod.env'),
            '--ops-source', str(self.root / 'src'), '--adapter-bundle', str(self.root / 'bundle'),
            '--tools-base', str(self.root), '--fleet-config', str(self.root / 'fleet'),
            '--unit', str(self.root / 'units/controller.service'), '--work-root', str(self.root / 'kit'), *extra])


class UpgradeSecurityTests(UpgradeFixture):
    def test_safe_read_rejects_symlink_in_parent_even_when_leaf_is_regular(self):
        real = self.root / 'real'
        self.file(real / 'policy.json')
        (self.root / 'alias').symlink_to(real)
        with self.assertRaises(lib.Abort):
            lib.safe_read(self.root / 'alias/policy.json')

    def test_atomic_write_fsync_failure_preserves_previous_configuration(self):
        original = self.file(self.root / 'policy.json', b'old\n')
        with mock.patch.object(lib.os, 'fsync', side_effect=OSError('disk failed')):
            with self.assertRaises(OSError):
                lib.write_new(original, b'new\n', 0, os.getegid(), 0o600, replace=True)
        self.assertEqual(original.read_bytes(), b'old\n')
        self.assertEqual(list(self.root.glob('.*.upgrade-*')), [])

class UpgradePinTests(UpgradeFixture):
    def test_new_release_contains_backup_workers_and_dynamic_helper(self):
        ops = SCRIPT.parent.parent
        closure = set().union(*(lib.python_closure(ops, entry) for entry in self.kit.OPS_ENTRIES))
        self.assertTrue({'cli/space_backup_runtime.py', 'cli/space_backup_local.py',
                         'cli/space_archive.py', 'cli/space_archive_stream.py', 'cli/space_backup_validate.py'} <= closure,
                        'a clean host upgrade must install both backup workers and their helpers')

class UpgradeConfigurationTests(UpgradeFixture):
    def setUp(self):
        super().setUp()
        self.args = self.arguments()
        self.args.controller.mkdir(parents=True)
        self.args.unit.parent.mkdir()
        authority = {'bundles': {'codex': {'directory': str(self.old / 'adapter'), 'digest': 'sha256:' + '0' * 64}}}
        self.documents = {'authority.v1.json': authority, 'auth.server.v1.json': {'project': str(self.old / 'app')},
            'controller.v1.json': {'authority_command': {'policy_file': str(self.args.controller / 'authority.v1.json'),
                'policy_sha256': '0' * 64}, 'hosts': [{'command': {'executable': str(self.old / 'ops/cli/fleet-executor.py')}}]},
            'executor.server.v1.json': {'hooks': {}, 'bundles': authority['bundles']}}
        for name, document in self.documents.items():
            self.file(self.args.controller / name, lib.dumps(document))
        self.file(self.args.controller / 'controller.env', f'CAUCE_FLEET_PROJECT_ROOT={self.old}\n'.encode())
        self.file(self.args.unit, f'ExecStart=/usr/bin/node {self.old}/app/main.js\n'.encode(), 0o644)
        self.ctx = {'old_root': self.old, 'adapter_digest': 'sha256:' + 'c' * 64, 'rollback': []}
        for module in (self.kit, lib):
            quiet = mock.patch.object(module, 'say')
            quiet.start()
            self.addCleanup(quiet.stop)

    def test_configuration_is_rewritten_with_the_new_authority_digest_and_no_residual_reference(self):
        self.kit.plan_configs(self.args, self.ctx, self.new)
        changes = self.ctx['changes']
        authority = changes[self.args.controller / 'authority.v1.json'][1]
        controller = json.loads(changes[self.args.controller / 'controller.v1.json'][1])
        self.assertEqual(controller['authority_command']['policy_sha256'], hashlib.sha256(authority).hexdigest())
        self.assertEqual(json.loads(authority)['bundles']['codex'], {'directory': str(self.new / 'adapter'), 'digest': 'sha256:' + 'c' * 64})
        self.assertFalse(any(OLD.encode() in after for _, after, _ in changes.values()))
        self.assertIn(str(self.new).encode(), changes[self.args.unit][1])

    def test_configuration_rollback_uses_backup_digest_and_restores_original_bytes(self):
        policy = self.args.controller / 'executor.server.v1.json'
        before = policy.read_bytes()
        self.ctx.update(changes={policy: (before, b'{"new":true}\n', (0, os.getegid(), 0o600))}, capability_changed=False)
        self.kit.write_configs(self.args, self.ctx, 'stamp')
        self.assertEqual(json.loads(policy.read_bytes()), {'new': True})
        self.assertTrue(lib.restore_configs(self.ctx))
        self.assertEqual(policy.read_bytes(), before)

class UpgradeMigrationTests(UpgradeFixture):
    def setUp(self):
        super().setUp()
        self.args = self.arguments('--apply')
        self.ctx = {'old_root': self.old, 'new_root': self.new, 'python': '/usr/bin/python3', 'rollback': [],
                    'tools_created': True, 'restarted': True}
        self.marker = self.file(self.new / 'ops/cli/fleet-runtime-rebind.py', b'tool\n')
        self.systemd = mock.Mock(simulate=False, active=mock.Mock(return_value=True))
        self.events = []
        self.systemd.ctl.side_effect = lambda *arguments: self.events.append(('systemctl', *arguments))

    def receipt(self, **rows):
        return json.dumps({'release': NEW, 'rebound': [], 'deferred': [], 'current': [], 'refused': [], 'shared': [], **rows})

    def rollback(self, *, rebind_error=None, referenced=False, restored=True):
        probe = mock.Mock(side_effect=referenced) if isinstance(referenced, BaseException) else mock.Mock(return_value=referenced)
        def rebind(_args, _ctx, policy, release, **options):
            self.events.append(('rebind', release, options))
            if rebind_error:
                raise lib.Abort(rebind_error)

        def restore(_ctx):
            self.events.append(('restore',))
            return restored

        with mock.patch.object(self.kit, 'rebind_containers', side_effect=rebind), \
                mock.patch.object(self.kit, 'restore_configs', side_effect=restore), \
                mock.patch.object(self.kit, 'referenced', probe), mock.patch.object(self.kit, 'say') as say:
            result = self.kit.rollback(self.args, self.ctx, self.systemd, 'heartbeat missing')
        return result, ' '.join(str(call.args[0]) for call in say.call_args_list)

    def test_rollback_after_restart_stops_restores_rebinds_back_removes_tree_and_restarts(self):
        result, _ = self.rollback()
        self.assertTrue(result)
        self.assertEqual(self.events, [('systemctl', 'stop', 'controller.service'), ('restore',),
            ('rebind', self.old, {'include_running': True}), ('systemctl', 'daemon-reload'), ('systemctl', 'start', 'controller.service')])
        self.assertFalse(self.new.exists())

    def test_unrestorable_configuration_leaves_controller_stopped_and_tools_in_place(self):
        result, output = self.rollback(restored=False)
        self.assertFalse(result)
        self.assertEqual(self.events, [('systemctl', 'stop', 'controller.service'), ('restore',)])
        self.assertTrue(self.marker.is_file())
        self.assertIn('left stopped', output)

if __name__ == '__main__':
    unittest.main()
