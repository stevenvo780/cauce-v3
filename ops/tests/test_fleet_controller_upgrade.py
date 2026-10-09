#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import types
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

    def test_safe_read_rejects_hardlink_and_group_writable_file(self):
        original = self.file(self.root / 'policy.json')
        alias = self.root / 'policy-link.json'
        os.link(original, alias)
        with self.assertRaises(lib.Abort):
            lib.safe_read(original)
        alias.unlink()
        original.chmod(0o620)
        with self.assertRaises(lib.Abort):
            lib.safe_read(original)

    def test_safe_read_requires_root_ownership(self):
        original = self.file(self.root / 'policy.json')
        self.owner.stop()
        with self.assertRaises(lib.Abort):
            lib.safe_read(original)
        self.owner.start()

    def test_gateway_config_is_accepted_only_when_its_owner_is_allowed(self):
        capability = self.file(self.root / 'gateway/capability.v1.json', b'{}\n', 0o600)
        self.owner.stop()
        try:
            with self.assertRaises(lib.Abort):
                lib.safe_read(capability)
            self.assertEqual(lib.safe_read(capability, owners=(0, os.geteuid()))[0], b'{}\n')
            lib.write_new(capability, b'{"v":2}\n', os.geteuid(), os.getegid(), 0o600, replace=True, owners=(0, os.geteuid()))
            self.assertEqual(capability.read_bytes(), b'{"v":2}\n')
            self.assertEqual(stat.S_IMODE(capability.stat().st_mode), 0o600)
            with self.assertRaises(lib.Abort):
                lib.write_new(capability, b'x\n', os.geteuid(), os.getegid(), 0o600, replace=True)
        finally:
            self.owner.start()

    def test_gateway_uid_defaults_to_the_gateway_process_user(self):
        self.assertEqual(self.arguments().gateway_uid, 1000)
        self.assertEqual(self.kit.gateway_owners(self.arguments('--gateway-uid', '1001')), (0, 1001))

    def test_atomic_write_replaces_only_after_sync_and_preserves_mode(self):
        original = self.file(self.root / 'policy.json', b'old\n', 0o640)
        lib.write_new(original, b'new\n', 0, os.getegid(), 0o640, replace=True)
        self.assertEqual(original.read_bytes(), b'new\n')
        self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o640)
        self.assertEqual(list(self.root.glob('.*.upgrade-*')), [])

    def test_atomic_write_fsync_failure_preserves_previous_configuration(self):
        original = self.file(self.root / 'policy.json', b'old\n')
        with mock.patch.object(lib.os, 'fsync', side_effect=OSError('disk failed')):
            with self.assertRaises(OSError):
                lib.write_new(original, b'new\n', 0, os.getegid(), 0o600, replace=True)
        self.assertEqual(original.read_bytes(), b'old\n')
        self.assertEqual(list(self.root.glob('.*.upgrade-*')), [])

    def test_non_root_fails_before_commands_or_filesystem_changes(self):
        with mock.patch.object(lib.os, 'geteuid', return_value=1000), mock.patch.object(self.kit, 'run') as run, \
                mock.patch.object(self.kit, 'upgrade') as upgrade:
            with self.assertRaisesRegex(lib.Abort, 'root'):
                self.kit.main(['--release', NEW, '--runtime-image-from', '/x', '--ops-source', '/y', '--adapter-bundle', '/z'])
        run.assert_not_called()
        upgrade.assert_not_called()

    def test_paths_come_from_flags_and_unsafe_combinations_are_rejected(self):
        args = self.arguments()
        self.assertEqual(args.controller, self.root / 'fleet/controller')
        self.assertEqual(args.capability, self.root / 'fleet/gateway/capability.v1.json')
        self.assertEqual(args.service, 'controller.service')
        for extra in (['--tools-base', 'relative'], ['--apply', '--simulate-apply'], ['--inject-failure', 'after-rebind'],
                      ['--host-id', "server'; drop"]):
            with self.assertRaises(SystemExit), mock.patch('sys.stderr'):
                self.arguments(*extra)


class UpgradePinTests(UpgradeFixture):
    def test_rewriter_moves_path_keys_and_updates_authority_hook_bundle_pins(self):
        hook = self.file(self.new / 'ops/cli/hook.py', b'import helper\n')
        helper = self.file(self.new / 'ops/cli/helper.py', b'LIMIT = 2\n')
        old_hook = str(self.old / 'ops/cli/hook.py')
        rewriter = lib.Rewriter(self.old, self.new, 'sha256:' + 'c' * 64)
        policy = rewriter.paths({'hooks': {'profile': {'executable': old_hook, 'sha256': '0' * 64,
            'argv': [old_hook], 'files': {old_hook: '0' * 64}}},
            'bundles': {'codex': {'directory': str(self.old / 'adapter'), 'digest': 'sha256:' + '0' * 64}},
            'external': '/usr/bin/python3'})
        rewriter.hook_closure(policy, self.new / 'ops')
        rewriter.pins(policy)
        profile = policy['hooks']['profile']
        self.assertEqual(profile['executable'], str(hook))
        self.assertEqual(profile['sha256'], hashlib.sha256(hook.read_bytes()).hexdigest())
        self.assertEqual(profile['files'][str(helper)], hashlib.sha256(helper.read_bytes()).hexdigest())
        self.assertEqual(policy['bundles']['codex']['digest'], 'sha256:' + 'c' * 64)
        self.assertEqual(policy['external'], '/usr/bin/python3')
        self.assertEqual(lib.verify_pins(self.new, [policy]), 3)

    def test_rewriter_rejects_symlinked_pin_in_new_tools_tree(self):
        original = self.file(self.new / 'ops/cli/real.py')
        (self.new / 'ops/cli/hook.py').symlink_to(original)
        policy = {'executable': str(self.new / 'ops/cli/hook.py'), 'sha256': '0' * 64}
        with self.assertRaises(lib.Abort):
            lib.Rewriter(self.old, self.new, 'sha256:' + 'c' * 64).pins(policy)

    def test_pin_verification_detects_changed_file_after_rewrite(self):
        hook = self.file(self.new / 'ops/cli/hook.py', b'approved\n')
        document = {'files': {str(hook): hashlib.sha256(hook.read_bytes()).hexdigest()}}
        hook.write_bytes(b'changed\n')
        with self.assertRaises(lib.Abort):
            lib.verify_pins(self.new, [document])

    def test_import_closure_installs_the_rebind_entrypoint_with_its_helpers(self):
        entry = self.file(self.new / 'ops/cli/fleet-runtime-rebind.py', b'import migration\n')
        self.file(self.new / 'ops/cli/migration.py', b'from shared_helper import safe\n')
        self.file(self.new / 'ops/scripts/shared_helper.py', b'safe = True\n')
        self.assertEqual(lib.python_closure(self.new / 'ops', str(entry.relative_to(self.new / 'ops'))),
            ['cli/fleet-runtime-rebind.py', 'cli/migration.py', 'scripts/shared_helper.py'])
        self.assertIn('cli/fleet-runtime-rebind.py', self.kit.OPS_ENTRIES)


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

    def test_shared_containers_mounting_the_current_release_block_the_upgrade(self):
        executor = {**self.documents['executor.server.v1.json'], 'shared_containers': {'legacy': {'mounts': [
            {'Destination': '/cauce/executor', 'Source': str(self.old / 'ops/cli'), 'Type': 'bind', 'RW': False}]}}}
        (self.args.controller / 'executor.server.v1.json').write_bytes(lib.dumps(executor))
        with self.assertRaisesRegex(lib.Abort, 'shared containers'):
            self.kit.plan_configs(self.args, self.ctx, self.new)

    def test_unmanaged_file_that_references_the_previous_release_blocks_the_upgrade(self):
        self.file(self.args.controller / 'extra.conf', f'path={self.old}/ops\n'.encode(), 0o644)
        with self.assertRaisesRegex(lib.Abort, 'extra.conf'):
            self.kit.plan_configs(self.args, self.ctx, self.new)

    def test_refused_container_on_the_release_in_service_blocks_before_any_write(self):
        self.file(self.args.capability, b'{"available":true,"placements":[]}\n', 0o640)
        policy = self.args.controller / 'executor.server.v1.json'
        self.ctx.update(new_root=self.new, documents={}, changes={policy: (b'{}', b'{}\n', (0, os.getegid(), 0o600))})
        work = self.root / 'work'
        work.mkdir(mode=0o700)
        plan = {'release': NEW, 'rebound': [], 'deferred': [], 'current': [], 'shared': [],
                'refused': [{'container': 'stale', 'release': OLD, 'reason': 'release tree entry is not trusted'},
                            {'container': 'ancient', 'release': 'c' * 40, 'reason': 'release tree is unavailable'}]}
        with mock.patch.object(self.kit, 'executor_capabilities', return_value=b'{"available":true,"placements":[]}\n'), \
                mock.patch.object(self.kit, 'rebind_containers', return_value=plan), mock.patch.object(self.kit, 'say'):
            with self.assertRaisesRegex(lib.Abort, 'stale$'):
                self.kit.validate_candidates(self.args, self.ctx, self.new, work)
        self.assertEqual(self.ctx['rollback'], [])
        self.assertFalse((work / 'candidate').exists())

    def test_configuration_rollback_uses_backup_digest_and_restores_original_bytes(self):
        policy = self.args.controller / 'executor.server.v1.json'
        before = policy.read_bytes()
        self.ctx.update(changes={policy: (before, b'{"new":true}\n', (0, os.getegid(), 0o600))}, capability_changed=False)
        self.kit.write_configs(self.args, self.ctx, 'stamp')
        self.assertEqual(json.loads(policy.read_bytes()), {'new': True})
        self.assertTrue(lib.restore_configs(self.ctx))
        self.assertEqual(policy.read_bytes(), before)

    def test_tampered_backup_is_not_installed_by_rollback(self):
        policy = self.args.controller / 'executor.server.v1.json'
        self.ctx.update(changes={policy: (policy.read_bytes(), b'new\n', (0, os.getegid(), 0o600))}, capability_changed=False)
        self.kit.write_configs(self.args, self.ctx, 'stamp')
        next(self.args.controller.glob('executor.server.v1.json.pre-upgrade-*')).write_bytes(b'tampered\n')
        self.assertFalse(lib.restore_configs(self.ctx))
        self.assertEqual(policy.read_bytes(), b'new\n')


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

    def test_rebind_command_targets_the_release_and_forces_dry_run_in_simulation(self):
        completed = subprocess.CompletedProcess([], 0, self.receipt(rebound=[{'container': 'one', 'release': OLD}]), '')
        with mock.patch.object(self.kit, 'run', return_value=completed) as run, mock.patch.object(self.kit, 'say'):
            receipt = self.kit.rebind_containers(self.args, self.ctx, pathlib.Path('/policy.json'), self.new)
            self.assertEqual(receipt['rebound'], [{'container': 'one', 'release': OLD}])
            command = run.call_args.args[0]
            self.assertEqual(command[:5], ['/usr/bin/python3', '-B', str(self.marker), '--policy', '/policy.json'])
            self.assertEqual(command[5:], ['--release-root', str(self.new)])
            simulated = types.SimpleNamespace(**{**vars(self.args), 'simulate_apply': True})
            self.kit.rebind_containers(simulated, self.ctx, pathlib.Path('/policy.json'), self.old, include_running=True)
            self.assertEqual(run.call_args.args[0][-2:], ['--include-running', '--dry-run'])

    def test_rebind_failure_surfaces_only_the_bounded_diagnostic(self):
        failed = subprocess.CompletedProcess([], 2, '', 'noise\nfleet container rebind failed: container mounts no approved runtime bundle\n')
        with mock.patch.object(self.kit, 'run', return_value=failed):
            with self.assertRaisesRegex(lib.Abort, 'no approved runtime bundle'):
                self.kit.rebind_containers(self.args, self.ctx, pathlib.Path('/policy.json'), self.new)

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

    def test_failed_rebind_back_keeps_the_new_tree_and_prints_the_manual_command(self):
        result, output = self.rollback(rebind_error='docker unavailable')
        self.assertFalse(result)
        self.assertTrue(self.marker.is_file())
        self.assertIn('--release-root ' + str(self.old) + ' --include-running', output)
        self.assertEqual(self.events[-1], ('systemctl', 'start', 'controller.service'))

    def test_tree_still_mounted_by_a_container_is_never_removed(self):
        result, _ = self.rollback(referenced=True)
        self.assertFalse(result)
        self.assertTrue(self.marker.is_file())

    def test_failed_mount_probe_still_restarts_the_previous_controller(self):
        result, output = self.rollback(referenced=lib.Abort('docker unavailable'))
        self.assertFalse(result)
        self.assertTrue(self.marker.is_file())
        self.assertEqual(self.events[-1], ('systemctl', 'start', 'controller.service'))
        self.assertIn('tools root removal', output)

    def test_unrestorable_configuration_leaves_controller_stopped_and_tools_in_place(self):
        result, output = self.rollback(restored=False)
        self.assertFalse(result)
        self.assertEqual(self.events, [('systemctl', 'stop', 'controller.service'), ('restore',)])
        self.assertTrue(self.marker.is_file())
        self.assertIn('left stopped', output)

    def test_failure_before_restart_only_restores_and_removes_the_created_tree(self):
        self.ctx['restarted'] = False
        result, _ = self.rollback()
        self.assertTrue(result)
        self.assertEqual(self.events, [('restore',)])
        self.assertFalse(self.new.exists())


if __name__ == '__main__':
    unittest.main()
