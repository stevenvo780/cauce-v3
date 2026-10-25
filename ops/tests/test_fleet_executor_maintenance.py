from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
sys.path.insert(0, str(OPS / 'container-runtime'))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_image as image  # noqa: E402
import fleet_executor_lifecycle as lifecycle  # noqa: E402
import fleet_executor_maintenance as maintenance  # noqa: E402
import fleet_executor_runtime as runtime  # noqa: E402
import test_fleet_executor_rebind as fixtures  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402

OPERATION = '00000000-0000-4000-8000-000000000001'
CLAIM = '00000000-0000-4000-8000-000000000002'


@contextlib.contextmanager
def input_lines(*documents):
    read, write = os.pipe()
    with os.fdopen(write, 'wb') as writer:
        for document in documents:
            writer.write(json.dumps(document).encode() + b'\n')
    with os.fdopen(read, 'rb') as reader:
        yield reader


class MaintenancePreflightTest(fixtures.ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.agent.update(primary_room_id='room', primary_account_id='account', model_id='model')
        self.policy['bundles']['codex']['shared_tui'] = True
        self.raw = {key: value for key, value in self.agent.items() if not key.startswith('_')}
        account = {'id': 'account', 'provider': 'codex', 'external_account_id': 'account@example.invalid',
                   'payer_tenant_id': self.agent['tenant_id'], 'shared_with_pool': False, 'enabled': True}
        self.document = {'operation_id': OPERATION, 'agent': self.raw, 'trusted_accounts': [account],
                         'claim': {'claim_token': CLAIM, 'consumer_epoch': 3}}
        self.fake = fixtures.FakeDocker()
        self.observed = self.fake.add(self.name, container.expected_labels(self.policy, self.agent),
                                     self.mounts(self.old), running=True)
        self.environment = {'HOME': self.agent['home_directory'], 'CODEX_HOME': '/profiles/account',
                            'CAUCE_SHARED_SESSION': '1'}
        self.state = {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': None,
                      'adapter_bundle_digest': self.policy['bundles']['codex']['digest']}
        for patch in (mock.patch.object(container, 'docker', self.fake),
                      mock.patch.object(image, 'assert_persistent_profile'),
                      mock.patch.object(container, 'observe_adapter_state', return_value=(self.state, self.environment)),
                      mock.patch.object(container, 'user_identity', return_value=('65534', '65534')),
                      mock.patch.object(runtime, 'provider_base_environment', return_value={'CODEX_HOME': '/profiles/account'}),
                      mock.patch.object(runtime, 'sdk_environment_proof')):
            patch.start()
            self.addCleanup(patch.stop)

    def run_guard(self):
        output = io.StringIO()
        with input_lines(self.document) as incoming:
            maintenance.run(self.policy, incoming, output)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_previous_release_reaches_exact_guard_without_rebinding_and_holds_login_lock(self):
        held = []

        @contextlib.contextmanager
        def guard(_identity):
            held.append(True)
            try:
                yield
            finally:
                held.pop()

        def stop(agent, spec, _incoming, output):
            self.assertEqual(held, [True])
            self.assertEqual(spec['expected']['wireAlias'], self.agent['alias'])
            self.assertEqual(spec['environment'], self.environment)
            self.assertEqual(agent['primary_account_id'], 'account')
            maintenance.emit(output, {'state': 'aborted'})

        with mock.patch.object(image, 'image_guard', guard), mock.patch.object(maintenance, 'hold', side_effect=stop):
            self.assertEqual(self.run_guard(), [{'state': 'aborted'}])
        self.assertEqual(held, [])
        runtime.sdk_environment_proof.assert_called_once()
        self.assertTrue(all(call[0] in {'ps', 'inspect', 'exec'} for call in self.fake.calls), self.fake.calls)

    def test_current_release_is_skipped_after_sdk_and_profile_identity_proof(self):
        self.observed['Mounts'] = self.mounts(self.new)
        with mock.patch.object(image, 'image_guard', return_value=contextlib.nullcontext()), \
                mock.patch.object(maintenance, 'hold', side_effect=AssertionError('stop launched')):
            self.assertEqual(self.run_guard(), [{'state': 'runtime_current'}])
        runtime.sdk_environment_proof.assert_called_once()

    def test_current_mounts_with_an_older_live_bundle_still_require_guarded_stop(self):
        self.observed['Mounts'] = self.mounts(self.new)
        self.state['adapter_bundle_digest'] = 'a' * 64
        with mock.patch.object(image, 'image_guard', return_value=contextlib.nullcontext()), \
                mock.patch.object(maintenance, 'hold') as stop:
            self.assertEqual(self.run_guard(), [])
        stop.assert_called_once()

    def test_login_is_deferred_before_any_runtime_probe_or_signal(self):
        with mock.patch.object(image, 'image_guard', return_value=contextlib.nullcontext()), \
                mock.patch.object(image, 'assert_no_login', side_effect=SafeFailure(
                    'provider login session is open or unverified; image refresh refused')), \
                mock.patch.object(maintenance, 'hold', side_effect=AssertionError('stop launched')):
            self.assertEqual(self.run_guard(), [{'state': 'deferred', 'reason': 'provider_login'}])
        container.observe_adapter_state.assert_not_called()

    def test_unverified_login_probe_is_deferred_without_a_signal(self):
        with mock.patch.object(image, 'image_guard', return_value=contextlib.nullcontext()), \
                mock.patch.object(image, 'assert_no_login', side_effect=SafeFailure('runtime observation failed')), \
                mock.patch.object(maintenance, 'hold', side_effect=AssertionError('stop launched')):
            self.assertEqual(self.run_guard(), [{'state': 'deferred', 'reason': 'provider_login'}])
        container.observe_adapter_state.assert_not_called()

    def test_missing_canonical_room_account_model_or_claim_is_rejected_before_inspection(self):
        for key in ('primary_room_id', 'primary_account_id', 'model_id'):
            with self.subTest(key=key):
                value = self.raw.pop(key)
                with self.assertRaises(SafeFailure):
                    self.run_guard()
                self.raw[key] = value
        self.document['claim']['consumer_epoch'] = True
        with self.assertRaises(SafeFailure):
            self.run_guard()
        self.assertEqual(self.fake.calls, [])

    def test_profile_or_sdk_mismatch_never_enters_stop_guard(self):
        self.environment['CODEX_HOME'] = '/profiles/foreign'
        with mock.patch.object(image, 'image_guard', return_value=contextlib.nullcontext()), \
                mock.patch.object(maintenance, 'hold', side_effect=AssertionError('stop launched')):
            with self.assertRaisesRegex(SafeFailure, 'approved account'):
                self.run_guard()

    def test_nullable_selection_is_deferred_without_observing_or_stopping(self):
        self.raw['model_id'] = None
        self.assertEqual(self.run_guard(), [{'state': 'deferred', 'reason': 'preflight_unavailable'}])
        self.assertEqual(self.fake.calls, [])


REMOTE_FIXTURE = '''import contextlib,json,os,pathlib,sys
sys.path[:0]=[sys.argv.pop(1)]
import cauce_container_proc as proc,cauce_container_tree as tree,cauce_container_restart as restart
from cauce_container_base import PermanentError
spec=json.loads(sys.argv[1])
root=pathlib.Path(spec['control'])
document={**spec['expected'],'pid':os.getpid(),'runtimeUid':os.geteuid(),'runtimeGid':os.getegid(),
    'containerGeneration':spec['generation'],'stopAuthority':tree.STOP_AUTHORITY,'phase':'running',
    'starttime':1,'controllerPid':os.getpid()+1,'controllerStarttime':1}
proc.read_metadata=lambda _fd:(document,(root/'metadata').read_bytes()) if (root/'metadata').exists() else (None,None)
proc.require_current_generation=lambda *_args:None
proc.verify_adapter=lambda *_args:None
proc.remove_metadata=lambda _fd:(root/'metadata').unlink()
proc.matched_fs_credentials=lambda *_args:contextlib.nullcontext()
leader=os.open('/dev/null',os.O_RDONLY)
controller=os.open('/dev/null',os.O_RDONLY)
tree.pin_verified_adapter=lambda *_args,**_kw:leader
tree.pin_verified_controller=lambda *_args:controller
tree.pidfd_running=lambda fd:fd==leader and not (root/'signal').exists()
tree.pidfd_matches_starttime=lambda *_args:True
tree.alias_generation_pids=lambda *_args,**_kw:[document['pid']]
tree.stop_signal_gate=lambda:None
def signal_pidfd(_fd,_signal):
    (root/'signal').write_text('exact pinned leader')
    if os.environ.get('MAINTENANCE_TEST_SCENARIO')=='partial':
        raise PermanentError('injected signal result unavailable')
tree.signal_pidfd=signal_pidfd
@contextlib.contextmanager
def fence(_document):
    scenario=os.environ.get('MAINTENANCE_TEST_SCENARIO','')
    if scenario.startswith('RESTART_HOLD_'):
        raise PermanentError(scenario)
    (root/'barrier').write_text('held')
    try:
        yield
    finally:
        (root/'barrier').write_text('restored')
        if scenario=='restore-failure':
            raise PermanentError('RESTART_PARTIAL_INPUT_FENCE_RESTORE_UNCONFIRMED')
restart.restart_fence=fence
'''


class MaintenanceHandshakeTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-maintenance-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.root.chmod(0o700)
        (self.root / 'metadata').write_bytes(b'original metadata')
        self.spec = {'action': 'hold', 'operation_id': OPERATION, 'guard_id': uuid.uuid4().hex,
            'container_id': '1' * 64, 'generation': '2' * 64, 'control': str(self.root),
            'alias': 'canary', 'state': '/tmp/canary', 'expected': {}, 'environment': {}}
        self.scenario = ''
        self.remote_ttl = 30

    def remote(self, _agent, spec):
        entry = maintenance.MAINTENANCE_ENTRY.replace('time.monotonic()+30', 'time.monotonic()+' + str(self.remote_ttl))
        code = REMOTE_FIXTURE + '\n' + entry
        return [sys.executable, '-I', '-B', '-c', code, str(OPS / 'container-runtime'), json.dumps(spec)], b''

    def run_hold(self, instructions=()):
        output = io.StringIO()
        with input_lines(*instructions) as incoming, mock.patch.object(maintenance, 'remote_command', self.remote), \
                mock.patch.dict(os.environ, {'MAINTENANCE_TEST_SCENARIO': self.scenario}):
            maintenance.hold({}, self.spec, maintenance.JsonLines(incoming), output)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def command(self, action):
        return {'operation_id': OPERATION, 'guard_id': self.spec['guard_id'], 'action': action}

    def assert_clean(self, *, signalled=False):
        self.assertEqual(list(self.root.glob('m-*')), [])
        self.assertEqual((self.root / 'signal').exists(), signalled)
        self.assertEqual((self.root / 'barrier').read_text(), 'restored')
        self.assertEqual((self.root / 'metadata').exists(), not signalled)

    def test_commit_stops_only_after_ready_and_reuses_original_metadata(self):
        output = io.StringIO()

        def observed_ready(stream, receipt):
            if receipt['state'] == 'ready':
                self.assertEqual((self.root / 'barrier').read_text(), 'held')
                self.assertFalse((self.root / 'signal').exists())
            stream.write(json.dumps(receipt) + '\n')

        with input_lines(self.command('commit')) as incoming, mock.patch.object(maintenance, 'remote_command', self.remote), \
                mock.patch.object(maintenance, 'emit', side_effect=observed_ready):
            maintenance.hold({}, self.spec, maintenance.JsonLines(incoming), output)
        receipts = [json.loads(row) for row in output.getvalue().splitlines()]
        self.assertEqual([row['state'] for row in receipts], ['ready', 'stopped'])
        self.assert_clean(signalled=True)

    def test_metadata_change_after_ready_aborts_before_any_signal(self):
        original_emit = maintenance.emit

        def change_after_ready(stream, receipt):
            original_emit(stream, receipt)
            if receipt['state'] == 'ready':
                (self.root / 'metadata').write_bytes(b'replaced metadata')

        with mock.patch.object(maintenance, 'emit', side_effect=change_after_ready):
            with self.assertRaisesRegex(SafeFailure, 'unverified'):
                self.run_hold([self.command('commit')])
        self.assert_clean()

    def test_abort_and_parent_eof_restore_input_and_preserve_metadata_without_signals(self):
        for instructions in ([self.command('abort')], []):
            with self.subTest(instructions=instructions):
                receipts = self.run_hold(instructions)
                self.assertEqual([row['state'] for row in receipts], ['ready', 'aborted'])
                self.assert_clean()

    def test_wrong_operation_or_guard_cannot_commit(self):
        for key in ('operation_id', 'guard_id'):
            with self.subTest(key=key):
                command = {**self.command('commit'), key: uuid.uuid4().hex}
                self.assertEqual(self.run_hold([command])[-1], {'state': 'aborted'})
                self.assert_clean()

    def test_server_expiry_restores_guard_even_without_an_ipc_client(self):
        self.remote_ttl = 0.05
        arguments, _raw = self.remote({}, self.spec)
        child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0, stderr.decode())
        self.assertEqual([json.loads(row)['state'] for row in stdout.splitlines()], ['ready', 'aborted'])
        self.assert_clean()

    def test_host_deadline_aborts_open_stdin_and_restores_guard(self):
        read, write = os.pipe()
        self.addCleanup(os.close, write)
        with os.fdopen(read, 'rb') as incoming, mock.patch.object(maintenance, 'TTL', 0.05), \
                mock.patch.object(maintenance, 'remote_command', self.remote):
            output = io.StringIO()
            maintenance.hold({}, self.spec, maintenance.JsonLines(incoming), output)
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1]), {'state': 'aborted'})
        self.assert_clean()

    def test_busy_and_unreadable_guards_defer_before_ready(self):
        for code, reason in (('COMPOSER_NOT_EMPTY', 'composer_busy'), ('TURN_OR_PASTE_ACTIVE', 'turn_active'),
                             ('PANE_UNREADABLE', 'tui_unreadable'), ('COMPOSER_EMPTY_STATE_UNKNOWN', 'tui_unreadable')):
            with self.subTest(code=code):
                self.scenario = 'RESTART_HOLD_' + code
                self.assertEqual(self.run_hold(), [{'state': 'deferred', 'reason': reason}])
                self.assertFalse((self.root / 'signal').exists())
                self.assertFalse(list(self.root.glob('m-*')))

    def test_partial_stop_or_failed_restoration_is_never_a_deferral(self):
        for scenario in ('partial', 'restore-failure'):
            with self.subTest(scenario=scenario):
                self.scenario = scenario
                (self.root / 'signal').unlink(missing_ok=True)
                with self.assertRaisesRegex(SafeFailure, 'unverified'):
                    self.run_hold([self.command('commit')])
                self.assertTrue((self.root / 'metadata').exists())
                self.assertFalse(list(self.root.glob('m-*')))

    def test_injected_entry_comes_from_the_fixed_host_constant_and_keeps_module_pins(self):
        pin, raw = lifecycle.current_program(maintenance=True)
        import base64
        import hashlib
        self.assertEqual(hashlib.sha256(raw).hexdigest(), pin)
        packet = json.loads(raw)
        self.assertEqual(list(packet['modules']), list(lifecycle.MODULES))
        self.assertEqual(base64.b64decode(packet['entry']).decode(), maintenance.MAINTENANCE_ENTRY)
        with self.assertRaisesRegex(SafeFailure, 'ambiguous'):
            lifecycle.current_program(observe=True, maintenance=True)

    def test_cli_dispatch_does_not_consume_persistent_stdin_until_eof(self):
        namespace = runpy.run_path(str(OPS / 'cli/fleet-executor.py'), run_name='maintenance_cli_test')
        stdin = mock.Mock()
        stdin.buffer.read.side_effect = AssertionError('persistent stdin was consumed until EOF')
        with mock.patch.dict(namespace['main'].__globals__, {'load_policy': lambda _filename: {'approved': True}}), \
                mock.patch.object(sys, 'argv', ['fleet-executor.py', '--policy', '/approved/policy', '--maintenance-guard']), \
                mock.patch.object(sys, 'stdin', stdin), mock.patch('signal.signal'), \
                mock.patch.object(maintenance, 'run') as guard:
            self.assertEqual(namespace['main'](), 0)
        guard.assert_called_once_with({'approved': True}, stdin.buffer, sys.stdout)


if __name__ == '__main__':
    unittest.main()
