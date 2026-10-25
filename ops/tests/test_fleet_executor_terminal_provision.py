from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import sys
import tempfile
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fleet_executor_terminal as terminal
import fleet_executor_terminal_inventory as terminal_inventory
import fleet_executor_terminal_manager as manager
import fleet_executor_terminal_provision as provision
from fleet_executor_pki import expiry, openssl
from fleet_executor_policy import SafeFailure
from fleet_executor_terminal_files import directory, read_file, write_file
from fleet_executor_terminal_inventory import desired_agent, identity_digest, launcher_row
from fleet_runtime_apply import publish_applied
from fleet_runtime_materialization import materialize
from test_export_fleet_snapshot import agent as source_agent
from test_export_fleet_snapshot import membership, source


class TerminalProvisionFilesTest(unittest.TestCase):
    def test_private_hierarchy_and_atomic_modes_ignore_a_group_writable_umask(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-files-', dir='/var/tmp') as temporary:
            root = pathlib.Path(temporary)
            previous = os.umask(0o002)
            try:
                leaf = directory(root, 'one/two/three')
                for name in ('one', 'one/two', 'one/two/three'):
                    self.assertEqual((root / name).stat().st_mode & 0o777, 0o700)
                for mode in (0o400, 0o600, 0o644):
                    filename = leaf / str(mode)
                    write_file(filename, b'owned fixture', mode)
                    self.assertEqual(filename.stat().st_mode & 0o777, mode)
                    write_file(filename, b'owned fixture', mode)
                    with self.assertRaises(SafeFailure):
                        write_file(filename, b'different fixture', mode)
            finally:
                os.umask(previous)
            (root / 'link').symlink_to(leaf, target_is_directory=True)
            with self.assertRaises(OSError):
                directory(root, 'link/child')


class TerminalVerifiedInventoryTest(unittest.TestCase):
    def test_the_mapping_is_parsed_from_the_same_bytes_checked_against_its_receipt(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-inventory-race-', dir='/var/tmp') as temporary:
            state = pathlib.Path(temporary)
            receipt = materialize(source(), {}, state)
            filename = state / 'generations' / receipt['generation'] / 'container-aliases.json'
            approved = filename.read_bytes()
            document = json.loads(approved)
            expected = document['aliases']['kant']
            document['aliases']['kant'] = {**expected, 'tenant': 'Foreign'}
            filename.write_text(json.dumps(document))
            with mock.patch.object(terminal_inventory, 'checked_file', return_value=approved, create=True):
                self.assertEqual(terminal_inventory.generation_row(state, receipt, 'kant')['tenant'], expected['tenant'])
            with self.assertRaises(SafeFailure):
                terminal_inventory.generation_row(state, receipt, 'kant')

    def test_admission_uses_desired_and_other_global_changes_can_fall_back_to_same_applied_identity(self):
        with tempfile.TemporaryDirectory(prefix='cauce-terminal-inventory-', dir='/var/tmp') as temporary:
            state = pathlib.Path(temporary)
            row = {**source_agent('same_alias'), 'runtime_key': 'physical-one', 'host_id': 'host-a',
                   'runtime_mode': 'container', 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name,
                   'state_directory': '/home/dev/.local/state/cauce-v3/physical-one'}
            first = materialize(source(agents=[row], memberships=[membership('same_alias')]), {}, state)
            agent = {'runtime_key': 'physical-one', 'alias': 'same_alias', 'tenant_id': 'Steven',
                     'container_name': 'ctrl-infra', 'runtime_user': 'dev', 'home_directory': '/home/dev',
                     'state_directory': row['state_directory'], 'harness_id': 'codex'}
            generation = state / 'generations' / first['generation']
            selected, pin = desired_agent({'roots': {'state': str(state)}}, generation, agent)
            self.assertEqual(selected['alias'], 'same_alias')
            self.assertFalse((state / 'applied-fleet.json').exists())
            self.assertEqual(launcher_row(state, first['generation'], 'physical-one', pin), selected)
            publish_applied(state, first['generation'], None)
            other = source_agent('another')
            materialize(source(agents=[row, other], memberships=[membership('same_alias'), membership('another')]), {}, state)
            self.assertEqual(launcher_row(state, first['generation'], 'physical-one', pin), selected)
            with self.assertRaises(SafeFailure):
                desired_agent({'roots': {'state': str(state)}}, generation, agent)
            with self.assertRaises(SafeFailure):
                launcher_row(state, first['generation'], 'physical-one', identity_digest('physical-one', {**selected, 'tenant': 'Foreign'}))
            (generation / 'container-aliases.json').write_text('{}')
            with self.assertRaises(ValueError):
                launcher_row(state, first['generation'], 'physical-one', pin)


class TerminalPresenceTest(unittest.TestCase):
    def check_presence(self, invocation, *, process_uid=None, wire='logical', record_fields=None,
                       missing_fields=(), environment=None, environments=None, process_starttimes=(77, 77),
                       after_invocation=None, attempts=1, observations=None, modes='shell,harness'):
        current = 'a' * 32
        unit = 'cauce-v3-pty@physical.service'
        state = 'ActiveState=active\nMainPID=101\nExecMainStartTimestampMonotonic=100\nInvocationID=' + current
        fields = {'_SYSTEMD_USER_UNIT': unit, '_UID': str(os.geteuid()), '_PID': '101',
                  '_BOOT_ID': 'd' * 32, '__MONOTONIC_TIMESTAMP': '101', **(record_fields or {})}
        for name in missing_fields:
            fields.pop(name, None)
        records = [{'MESSAGE': message, **fields} for message in
                   ('starting alias=' + wire + ' container=fixture uid=1000 version=' + 'b' * 64,
                    'relay accepted alias=' + wire + ' modes=' + modes)]
        result = mock.Mock(returncode=0, stdout=b'\n'.join(json.dumps(row).encode() for row in records))
        starttimes = iter(process_starttimes)

        def process_text(filename, **_options):
            if filename == pathlib.Path('/proc/sys/kernel/random/boot_id'):
                return 'dddddddd-dddd-dddd-dddd-dddddddddddd\n'
            self.assertEqual(filename, pathlib.Path('/proc/101/stat'))
            return '101 (docker) ' + ' '.join(['0'] * 19 + [str(next(starttimes))])

        raw = environment if environment is not None else [
            'CAUCE_PTY_AGENT_VERSION=' + 'b' * 64, 'INVOCATION_ID=' + invocation]
        observed_environments = iter(environments) if environments is not None else None

        def process_environment(_filename):
            values = next(observed_environments) if observed_environments is not None else raw
            return '\0'.join(values).encode() + b'\0'

        def unit_properties(*arguments):
            return state if 'ActiveState' in arguments[-1] else 'MainPID=101\nInvocationID=' + (after_invocation or current)

        with mock.patch.object(manager, 'systemctl', side_effect=unit_properties), \
                mock.patch.object(manager.pathlib.Path, 'read_bytes', autospec=True, side_effect=process_environment), \
                mock.patch.object(manager.pathlib.Path, 'read_text', autospec=True, side_effect=process_text), \
                mock.patch.object(manager.pathlib.Path, 'stat', return_value=mock.Mock(st_uid=os.geteuid() if process_uid is None else process_uid)), \
                mock.patch.object(manager.subprocess, 'run', return_value=result) as journal:
            observed = manager.presence(unit, wire, 'b' * 64, attempts=attempts)
        if observations is not None:
            observations['journal_queries'] = journal.call_count
        command = journal.call_args.args[0]
        for field in ('_SYSTEMD_USER_UNIT=' + unit, '_UID=' + str(os.geteuid()), '_PID=101', '_BOOT_ID=' + 'd' * 32):
            self.assertIn(field, command)
        self.assertIn('--user-unit=' + unit, command)
        return observed

    def test_a_valid_wire_alias_ending_in_a_hyphen_is_acknowledged(self):
        self.assertTrue(self.check_presence('a' * 32, wire='logical-')['relay_acknowledged'])

    def test_only_the_current_owned_invocation_acknowledges_the_terminal(self):
        self.assertTrue(self.check_presence('a' * 32)['relay_acknowledged'])
        for invocation, uid in [('c' * 32, None), ('a' * 32, os.geteuid() + 1)]:
            with self.subTest(invocation=invocation, uid=uid), self.assertRaises(SafeFailure):
                self.check_presence(invocation, process_uid=uid)

    def test_acknowledgements_require_the_current_user_unit_pid_boot_and_monotonic_time(self):
        for field, value in [('_SYSTEMD_USER_UNIT', 'cauce-v3-pty@foreign.service'), ('_UID', str(os.geteuid() + 1)),
                             ('_PID', '102'), ('_BOOT_ID', 'e' * 32), ('__MONOTONIC_TIMESTAMP', '99'),
                             ('__MONOTONIC_TIMESTAMP', 'invalid')]:
            with self.subTest(field=field, value=value), self.assertRaises(SafeFailure):
                self.check_presence('a' * 32, record_fields={field: value})
        for field in ('_SYSTEMD_USER_UNIT', '_UID', '_PID', '_BOOT_ID', '__MONOTONIC_TIMESTAMP'):
            with self.subTest(missing=field), self.assertRaises(SafeFailure):
                self.check_presence('a' * 32, missing_fields=(field,))

    def test_process_release_and_invocation_environment_must_be_exact_and_unique(self):
        approved = ['CAUCE_PTY_AGENT_VERSION=' + 'b' * 64, 'INVOCATION_ID=' + 'a' * 32]
        for environment in ([approved[0]], [approved[1]], ['CAUCE_PTY_AGENT_VERSION=' + 'c' * 64, approved[1]],
                            [*approved, approved[0]], [*approved, approved[1]], [*approved, 'INVOCATION_ID=' + 'c' * 32]):
            with self.subTest(environment=environment), self.assertRaises(SafeFailure):
                self.check_presence('a' * 32, environment=environment)

    def test_the_process_and_unit_invocation_are_repinned_after_the_acknowledgement(self):
        for options in ({'process_starttimes': (77, 78)}, {'after_invocation': 'c' * 32}):
            with self.subTest(options=options), self.assertRaises(SafeFailure):
                self.check_presence('a' * 32, **options)

    def test_the_transport_ack_can_precede_the_shared_panel_but_must_include_shell_exactly_once(self):
        self.assertTrue(self.check_presence('a' * 32, modes='shell')['relay_acknowledged'])
        for modes in ('harness', 'harness,harness_rw', 'shell,shell'):
            with self.subTest(modes=modes), self.assertRaises(SafeFailure):
                self.check_presence('a' * 32, modes=modes)

    def test_an_active_unit_waits_for_its_initial_exec_environment_before_accepting_its_ack(self):
        approved = ['CAUCE_PTY_AGENT_VERSION=' + 'b' * 64, 'INVOCATION_ID=' + 'a' * 32]
        with mock.patch.object(manager.time, 'sleep') as sleep:
            observed = self.check_presence('a' * 32, attempts=2, environments=[[], approved, approved],
                                           process_starttimes=(77, 77, 77))
        self.assertTrue(observed['relay_acknowledged'])
        self.assertEqual(sleep.call_args_list, [mock.call(0.5)])

    def test_a_permanently_invalid_process_exhausts_the_bounded_observation_budget(self):
        with mock.patch.object(manager.time, 'sleep') as sleep, self.assertRaisesRegex(
                SafeFailure, 'terminal relay acknowledgement was not observed for the current unit invocation'):
            self.check_presence('a' * 32, attempts=3, environment=[], process_starttimes=(77, 77, 77))
        self.assertEqual(sleep.call_args_list, [mock.call(0.5), mock.call(0.5)])

    def test_a_transient_process_repin_requires_another_complete_ack_observation(self):
        approved = ['CAUCE_PTY_AGENT_VERSION=' + 'b' * 64, 'INVOCATION_ID=' + 'a' * 32]
        observations = {}
        with mock.patch.object(manager.time, 'sleep') as sleep:
            observed = self.check_presence('a' * 32, attempts=2, environments=[approved, [], approved, approved],
                                           process_starttimes=(77, 77, 77, 77), observations=observations)
        self.assertTrue(observed['relay_acknowledged'])
        self.assertEqual(observations['journal_queries'], 2)
        self.assertEqual(sleep.call_args_list, [mock.call(0.5)])

    def test_a_managed_selector_cannot_hide_an_execution_override_or_missing_identity(self):
        unit = 'cauce-v3-pty@physical.service'
        root = pathlib.Path('/fixture/systemd')
        row = {'LoadState': 'loaded', 'FragmentPath': str(root / unit),
               'DropInPaths': str(root / (unit + '.d') / 'zz-fleet-terminal.conf')}
        for raw in (b'[Service]\nExecStart=/foreign\n', b'[Service]\n'):
            with self.subTest(raw=raw), mock.patch.object(manager, 'properties', return_value=row), \
                    mock.patch.object(manager, 'checked_file', side_effect=[b'canonical', raw]), \
                    self.assertRaises(SafeFailure):
                manager.pin_unit(unit, root, b'canonical', agent={'runtime_key': 'physical'})

    def test_the_approved_tui_flag_is_pinned_and_a_verified_previous_selector_can_be_upgraded(self):
        ops = pathlib.Path(manager.__file__).resolve().parents[1]
        unit = 'cauce-v3-pty@physical.service'
        root = pathlib.Path('/fixture/systemd')
        dropin = root / (unit + '.d') / 'zz-fleet-terminal.conf'
        agent = {'runtime_key': 'physical', 'alias': 'logical', 'tenant_id': 'Steven'}
        row = {'LoadState': 'loaded', 'FragmentPath': str(root / unit), 'DropInPaths': str(dropin)}
        for enabled in (False, True):
            selected = manager.selector(ops, 'b' * 64, '/fixture/state', 'a' * 64,
                                        'physical', 'c' * 64, 'host-a', shared_tui=enabled)
            self.assertIn(('CAUCE_PTY_FLEET_SHARED_TUI=' + str(int(enabled))).encode(), selected)
            previous = b'\n'.join(line for line in selected.splitlines() if b'CAUCE_PTY_FLEET_SHARED_TUI=' not in line) + b'\n'
            for raw in (previous, selected):
                with self.subTest(enabled=enabled, previous=raw == previous), \
                        mock.patch.object(manager, 'properties', return_value=row), \
                        mock.patch.object(manager, 'checked_file', side_effect=[b'canonical', raw]), \
                        mock.patch('fleet_executor_rebind.installed_release'), \
                        mock.patch.object(terminal_inventory, 'launcher_row', return_value={'tenant': 'Steven', 'alias': 'logical'}):
                    self.assertEqual(manager.pin_unit(unit, root, b'canonical', agent=agent), row)
            invalid = selected.replace(b'CAUCE_PTY_FLEET_SHARED_TUI=' + str(int(enabled)).encode(), b'CAUCE_PTY_FLEET_SHARED_TUI=2')
            with mock.patch.object(manager, 'properties', return_value=row), \
                    mock.patch.object(manager, 'checked_file', side_effect=[b'canonical', invalid]), self.assertRaises(SafeFailure):
                manager.pin_unit(unit, root, b'canonical', agent=agent)


class TerminalProvisionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ca_temporary = tempfile.TemporaryDirectory(prefix='cauce-terminal-ca-', dir='/var/tmp')
        cls.ca_root = pathlib.Path(cls.ca_temporary.name)
        cls.ca_key, cls.ca = cls.ca_root / 'ca.key', cls.ca_root / 'ca.crt'
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=fixture-ca', '-days', '2',
                '-keyout', str(cls.ca_key), '-out', str(cls.ca))

    @classmethod
    def tearDownClass(cls):
        cls.ca_temporary.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-terminal-provision-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.home = directory(self.root, 'home')
        self.state = directory(self.root, 'state')
        self.agent = {'runtime_key': 'physical-one', 'alias': 'same_alias', 'tenant_id': 'Steven', 'host_id': 'host-a',
                      'container_name': 'fixture-physical-one', 'runtime_user': 'dev', 'home_directory': '/home/dev',
                      'state_directory': '/home/dev/.cauce/physical-one', 'harness_id': 'codex', 'runtime_mode': 'container',
                      'systemd_user': pwd.getpwuid(os.geteuid()).pw_name}
        self.policy = {'terminal': {'required': True}, 'roots': {'state': str(self.state)},
                       'executor_user': self.agent['systemd_user'], 'host_id': 'host-a', 'bundles': {'codex': {'shared_tui': False}}}
        self.context = {'operation_id': str(uuid.uuid4())}
        self.generation = self.state / 'generations' / ('a' * 64)
        self.journal = {}
        self.save = mock.Mock()
        self.records = []
        self.template = b'[Service]\nExecStart=/canonical/fixture-launcher %i\n'
        patches = [mock.patch.object(provision.pwd, 'getpwuid', return_value=mock.Mock(pw_dir=str(self.home), pw_name=self.agent['systemd_user'])),
                   mock.patch.object(provision, 'desired_agent', return_value=({}, 'c' * 64)),
                   mock.patch.object(provision, 'approved_release', return_value=(self.root / 'ops', 'b' * 64, self.template)),
                   mock.patch.object(provision, 'terminal_inventory', side_effect=lambda *_: self.records),
                   mock.patch.object(provision, 'pin_unit', return_value={'LoadState': 'not-found'}),
                   mock.patch.object(provision, 'unit_state', return_value={'active': False, 'enabled': False}),
                   mock.patch.object(provision, 'presence', return_value={'relay_acknowledged': True, 'main_pid': 101}),
                   mock.patch.object(provision, 'systemctl', return_value=''),
                   mock.patch('fleet_executor_container.inspect_container', return_value={'State': {'Running': True}}),
                   mock.patch('fleet_executor_container.validate_container'),
                   mock.patch('fleet_executor_authority.issue_terminal', side_effect=self.issue),
                   mock.patch('fleet_executor_authority.revoke_terminal', return_value={'revoked': True})]
        self.mocks = [patch.start() for patch in patches]
        for patch in reversed(patches):
            self.addCleanup(patch.stop)
        self.systemctl, self.issue_mock, self.revoke_mock = self.mocks[7], self.mocks[10], self.mocks[11]

    def issue(self, _policy, _context, agent, csr_pem, _idempotency):
        if hasattr(self, 'issued'):
            return self.issued
        csr = self.root / 'issued.csr'
        write_file(csr, csr_pem.encode(), 0o600)
        pem = openssl('x509', '-req', '-sha256', '-in', str(csr), '-CA', str(self.ca), '-CAkey', str(self.ca_key),
                      '-set_serial', '42', '-days', '1')
        certificate = self.root / 'issued.crt'
        write_file(certificate, pem, 0o600)
        expires = min(expiry(certificate), expiry(self.ca)).strftime('%Y-%m-%dT%H:%M:%SZ')
        issued = {'certificate_pem': pem.decode(), 'ca_pem': self.ca.read_text(), 'alias_key_hex': '1' * 64,
                  'certificate_sha256': provision.fingerprint(pem), 'expires_at': expires, 'grant_id': 'd' * 64,
                  'relay_host': 'relay.example.invalid', 'relay_port': 8445}
        self.records = [{'tenant_id': agent['tenant_id'], 'alias': agent['alias'],
                         'fingerprint_sha256': issued['certificate_sha256'], 'expires_at': expires}]
        self.issued = issued
        return issued

    def ensure(self):
        return provision.ensure_terminal(self.policy, self.context, self.agent, self.generation, self.journal, self.save)

    def test_new_channel_has_private_material_physical_storage_and_an_acknowledged_unit(self):
        previous = os.umask(0o002)
        try:
            evidence = self.ensure()
        finally:
            os.umask(previous)
        self.assertTrue(evidence['terminal_verified'])
        self.assertFalse(evidence['reused'])
        pki = self.home / '.config/cauce-v3/pty-pki/physical-one'
        for name, mode in [('client.crt', 0o600), ('client.key', 0o600), ('ca.crt', 0o600), ('alias-key.hex', 0o400)]:
            read_file(pki / name, mode)
        entry = self.journal['terminal_provision']['physical-one']
        self.assertEqual(entry['selector'], 'physical-one')
        self.assertEqual(entry['stage'], 'verified')
        self.assertFalse((pathlib.Path(entry['work']) / 'client.key').exists())
        self.assertNotIn(self.issued['alias_key_hex'], json.dumps(self.journal))
        self.assertIn(mock.call('restart', 'cauce-v3-pty@physical-one.service'), self.systemctl.call_args_list)
        selected = self.home / '.config/systemd/user/cauce-v3-pty@physical-one.service.d/zz-fleet-terminal.conf'
        self.assertIn(b'CAUCE_PTY_FLEET_SHARED_TUI=0', selected.read_bytes())

    def test_a_shared_tui_capability_comes_from_the_approved_bundle_policy(self):
        self.policy['bundles']['codex']['shared_tui'] = True
        self.ensure()
        selected = self.home / '.config/systemd/user/cauce-v3-pty@physical-one.service.d/zz-fleet-terminal.conf'
        self.assertIn(b'CAUCE_PTY_FLEET_SHARED_TUI=1', selected.read_bytes())
        self.mocks[6].assert_called_with('cauce-v3-pty@physical-one.service', 'same_alias', 'b' * 64)

    def test_healthy_existing_channel_reuses_its_credentials_without_issuance_or_rollback_revocation(self):
        self.ensure()
        private = self.home / '.config/cauce-v3/pty-pki/physical-one/client.key'
        before = private.read_bytes(), private.stat().st_ino
        self.context = {'operation_id': str(uuid.uuid4())}
        self.journal = {}
        self.issue_mock.reset_mock()
        self.systemctl.reset_mock()
        evidence = self.ensure()
        self.assertTrue(evidence['reused'])
        self.issue_mock.assert_not_called()
        self.assertNotIn(mock.call('restart', evidence['unit']), self.systemctl.call_args_list)
        provision.rollback_terminal(self.policy, self.context, self.agent, self.journal, self.save)
        self.revoke_mock.assert_not_called()
        self.assertEqual((private.read_bytes(), private.stat().st_ino), before)

    def test_failed_activation_rolls_back_only_its_own_grant_and_published_files(self):
        self.mocks[6].side_effect = SafeFailure('fixture acknowledgement absent')
        with self.assertRaisesRegex(SafeFailure, '^terminal provisioning failed$'):
            self.ensure()
        entry = self.journal['terminal_provision']['physical-one']
        files = list(entry['files'])
        provision.rollback_terminal(self.policy, self.context, self.agent, self.journal, self.save)
        self.revoke_mock.assert_called_once_with(self.policy, self.context, self.agent, 'd' * 64, self.issued['certificate_sha256'])
        self.assertTrue(all(not os.path.lexists(name) for name in files))
        self.assertTrue(entry['rolled_back'])
        self.assertEqual(provision.rollback_terminal(self.policy, self.context, self.agent, self.journal, self.save),
                         {'terminal_rollback_verified': True})

    def test_retry_keeps_the_same_csr_and_grant_when_another_operation_changes_the_global_generation(self):
        self.mocks[6].side_effect = SafeFailure('fixture acknowledgement absent')
        with self.assertRaises(SafeFailure):
            self.ensure()
        entry = self.journal['terminal_provision']['physical-one']
        csr = read_file(pathlib.Path(entry['work']) / 'request.csr', 0o600)
        grant = dict(entry['grant'])
        self.generation = self.generation.with_name('e' * 64)
        self.mocks[6].side_effect = None
        self.assertTrue(self.ensure()['terminal_verified'])
        self.assertEqual(entry['grant'], grant)
        self.assertEqual(self.issue_mock.call_args.args[3].encode(), csr)
        self.issue_mock.assert_called_once()
        self.assertEqual(len(entry['files'][str(self.home / '.config/systemd/user/cauce-v3-pty@physical-one.service.d/zz-fleet-terminal.conf')]['owned']), 2)

    def test_an_acknowledgement_outage_after_verification_does_not_require_the_deleted_csr_on_retry(self):
        first = self.ensure()
        self.mocks[6].side_effect = SafeFailure('fixture relay outage after verified admission')
        with self.assertRaises(SafeFailure):
            self.ensure()
        self.mocks[6].side_effect = None
        self.assertEqual(self.ensure()['terminal_certificate_sha256'], first['terminal_certificate_sha256'])
        self.issue_mock.assert_called_once()

    def assert_rollback_rejects_mutation_during_authority(self, *, backup):
        self.ensure()
        entry = self.journal['terminal_provision']['physical-one']
        filename = self.home / '.config/cauce-v3/pty/physical-one.env'
        if backup:
            original = b'previous owned fixture\n'
            saved = pathlib.Path(entry['work']) / 'before-900'
            write_file(saved, original, 0o600)
            entry['files'][str(filename)].update(previous=hashlib.sha256(original).hexdigest(), backup=str(saved))
        foreign = b'external replacement during authority call\n'
        self.revoke_mock.side_effect = lambda *_: filename.write_bytes(foreign)
        with self.assertRaises(SafeFailure):
            provision.rollback_terminal(self.policy, self.context, self.agent, self.journal, self.save)
        self.assertEqual(filename.read_bytes(), foreign)
        self.assertFalse(entry.get('rolled_back', False))

    def test_rollback_does_not_remove_a_created_file_replaced_during_revocation(self):
        self.assert_rollback_rejects_mutation_during_authority(backup=False)

    def test_rollback_does_not_restore_over_a_file_replaced_during_revocation(self):
        self.assert_rollback_rejects_mutation_during_authority(backup=True)

    def test_lost_issuance_response_is_looked_up_without_reissuing_during_rollback(self):
        def lost(*arguments):
            self.issue(*arguments)
            raise SafeFailure('fixture response lost')
        self.issue_mock.side_effect = lost
        with self.assertRaisesRegex(SafeFailure, '^terminal provisioning failed$'):
            self.ensure()
        entry = self.journal['terminal_provision']['physical-one']
        self.assertIsNone(entry['grant'])
        with mock.patch('fleet_executor_authority.terminal_receipt', return_value={'grant': self.issued, 'registered': True, 'revoked': False}) as lookup:
            provision.rollback_terminal(self.policy, self.context, self.agent, self.journal, self.save)
        lookup.assert_called_once()
        self.issue_mock.assert_called_once()
        self.revoke_mock.assert_called_once()
        self.assertFalse(pathlib.Path(entry['work']).exists())

    def test_legacy_optional_hosts_and_native_runtimes_are_not_falsely_provisioned(self):
        for configuration in (None, {'required': False}):
            with self.subTest(configuration=configuration):
                self.policy.pop('terminal', None)
                if configuration is not None:
                    self.policy['terminal'] = configuration
                self.assertEqual(self.ensure(), {})
                self.assertEqual(self.journal, {})
                self.save.assert_not_called()
                self.issue_mock.assert_not_called()
                self.systemctl.assert_not_called()
                self.mocks[8].assert_not_called()
        self.policy['terminal'] = {'required': True}
        self.agent['runtime_mode'] = 'native'
        with self.assertRaisesRegex(SafeFailure, '^terminal provisioning failed$'):
            self.ensure()
        self.issue_mock.assert_not_called()

    def test_required_terminal_does_not_fall_back_when_its_issuer_is_unavailable(self):
        self.issue_mock.side_effect = SafeFailure('terminal authority is unavailable')
        with self.assertRaisesRegex(SafeFailure, '^terminal provisioning failed$'):
            self.ensure()
        self.issue_mock.assert_called_once()
        self.systemctl.assert_not_called()
        self.assertNotEqual(self.journal['terminal_provision']['physical-one']['stage'], 'verified')

    def test_purge_does_not_select_the_same_legacy_alias_of_another_company(self):
        config = directory(self.home, '.config/cauce-v3/pty')
        filename = config / (self.agent['alias'] + '.migration.json')
        metadata = {'schema_version': 1, 'tenant': 'Foreign', 'alias': self.agent['alias'], 'runtime_key': 'other-physical'}
        write_file(filename, json.dumps(metadata).encode(), 0o600)
        with mock.patch.object(terminal, 'purge_selector', return_value={'removed': []}) as purge:
            self.assertEqual(terminal.purge_terminal(self.policy, self.agent, {}, self.save), {'removed': []})
            self.assertEqual(purge.call_count, 1)
            self.assertEqual(purge.call_args.args[-2:], ('physical-one', 'physical-one:physical'))
        metadata.update(tenant=self.agent['tenant_id'], runtime_key=self.agent['runtime_key'])
        filename.write_text(json.dumps(metadata))
        with mock.patch.object(terminal, 'purge_selector', return_value={'removed': []}) as purge:
            terminal.purge_terminal(self.policy, self.agent, {}, self.save)
            self.assertEqual([call.args[-2] for call in purge.call_args_list], ['physical-one', 'same_alias'])


if __name__ == '__main__':
    unittest.main()
