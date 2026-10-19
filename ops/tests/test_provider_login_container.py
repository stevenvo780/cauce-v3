from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import select
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor_container as container_fixtures
import test_provider_login as pty_fixtures

sys.path.insert(0, str(container_fixtures.fixtures.OPS / 'cli'))
import host_setup
import provider_login_container as login


class IsolatedHelperTest(unittest.TestCase):
    def test_previous_release_rejects_writable_entries_and_symlinks(self):
        with tempfile.TemporaryDirectory(prefix='cauce-login-trust-', dir='/var/tmp') as temporary:
            base = pathlib.Path(temporary)
            old, current = (base / (character * 64) for character in ('a', 'b'))
            for tree in ('ops/cli', 'ops/container-runtime'):
                (old / tree).mkdir(parents=True)
            observed = {'Mounts': [{'Destination': destination, 'Type': 'bind', 'RW': False,
                                    'Source': str(old / tree)} for destination, tree in
                                   (('/cauce/executor', 'ops/cli'), ('/cauce/lifecycle', 'ops/container-runtime'))]}
            with mock.patch.object(login, '__file__', str(current / 'ops/cli/provider_login_container.py')):
                self.assertTrue(login.helper_mount(observed, cleanup=True))
                entry = old / 'ops/cli/untrusted.py'
                entry.write_text('')
                entry.chmod(0o666)
                self.assertFalse(login.helper_mount(observed, cleanup=True))
                entry.unlink()
                entry.symlink_to(base / 'outside.py')
                self.assertFalse(login.helper_mount(observed, cleanup=True))
                entry.unlink()
                directory = old / 'ops/container-runtime/nested'
                directory.mkdir(mode=0o777)
                directory.chmod(0o777)
                self.assertFalse(login.helper_mount(observed, cleanup=True))

    def test_cleanup_and_fallback_use_isolated_python_in_root_directory(self):
        binding = {'container_id': 'a' * 64, 'python': '/usr/bin/python3',
                   'helper': '/cauce/executor/provider-login.py'}
        results = [subprocess.CompletedProcess([], 2, b''),
                   subprocess.CompletedProcess([], 0, b'{"stopped_verified":true}')]
        with mock.patch.object(login, 'observe', return_value=True), \
                mock.patch.object(login.subprocess, 'run', side_effect=results) as run:
            self.assertEqual(login.remote_cleanup(binding, str(uuid.uuid4())), {'stopped_verified': True})
        for call in run.call_args_list:
            command = call.args[0]
            self.assertEqual(command[:9], [login.DOCKER, 'exec', '-i', '--user', '0', '-w', '/',
                                         binding['container_id'], binding['python']])
            self.assertEqual(command[9:11], ['-I', '-B'])
        self.assertEqual(run.call_args_list[0].args[0][11], '-c')
        self.assertEqual(run.call_args_list[0].args[0][13], binding['helper'])
        self.assertEqual(run.call_args_list[1].args[0][11], '-c')
        self.assertNotIn(binding['helper'], run.call_args_list[1].args[0])

    def test_helper_imports_stay_within_generated_pins_including_previous_release_cleanup(self):
        ops = container_fixtures.fixtures.OPS
        with tempfile.TemporaryDirectory(prefix='cauce-login-pins-', dir='/var/tmp') as temporary:
            base = pathlib.Path(temporary)
            old, current = (base / (character * 64) for character in ('a', 'b'))
            for tree in ('ops/cli', 'ops/container-runtime'):
                (old / tree).mkdir(parents=True)
            observed = {'Mounts': [{'Destination': destination, 'Type': 'bind', 'RW': False,
                                    'Source': str(old / tree)} for destination, tree in
                                   (('/cauce/executor', 'ops/cli'), ('/cauce/lifecycle', 'ops/container-runtime'))]}
            program = ('import json,pathlib,runpy,sys\n'
                'ops=pathlib.Path(sys.argv[1])\n'
                'sys.path.insert(0,str(ops/"cli"))\n'
                'runpy.run_path(str(ops/"cli/provider-login.py"))\n'
                'import provider_login_container as helper\n'
                'original=helper.__file__\n'
                'helper.__file__=sys.argv[2]\n'
                'assert helper.helper_mount(json.loads(sys.argv[3]),cleanup=True)\n'
                'helper.__file__=original\n'
                'print(json.dumps(sorted({str(pathlib.Path(module.__file__).resolve()) '
                'for module in sys.modules.copy().values() if getattr(module,"__file__",None) '
                'and pathlib.Path(module.__file__).resolve().is_relative_to(ops)})))\n')
            result = subprocess.run([sys.executable, '-I', '-B', '-c', program, str(ops),
                str(current / 'ops/cli/provider_login_container.py'), json.dumps(observed)],
                capture_output=True, text=True, check=True, timeout=10)
            auth = host_setup.provider_auth_policy({'profiles': {}, 'host_id': 'fixture-host',
                'profile_templates': [{'login': {}}]}, ops.parent, base / 'state')
            self.assertLessEqual(set(json.loads(result.stdout)), set(auth['helper']['files']))
            for invalid in (None, '', '/', '/ops/container-runtime', str(old / 'ops/../ops/container-runtime')):
                observed['Mounts'][1]['Source'] = invalid
                with self.subTest(source=invalid), mock.patch.object(login, '__file__',
                        str(current / 'ops/cli/provider_login_container.py')):
                    self.assertFalse(login.helper_mount(observed, cleanup=True))


class PreviousReleaseCleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        container_fixtures.DisposableContainerExecutorTest.setUpClass.__func__(cls)

    frame = pty_fixtures.ProviderLoginPtyTest.frame
    wait_for = pty_fixtures.ProviderLoginPtyTest.wait_for

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-login-release-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.old, self.current = (self.root / 'release' / (character * 64) for character in ('a', 'b'))
        for release in (self.old, self.current):
            for tree in ('ops/cli', 'ops/container-runtime'):
                (release / tree).mkdir(parents=True)
        for filename in ('provider-login.py', 'provider_login_native.py', 'provider_login_state.py',
                         'provider_login_container.py', 'fleet_executor_view.py'):
            shutil.copyfile(container_fixtures.fixtures.OPS / 'cli' / filename, self.old / 'ops/cli' / filename)
        for filename in ('cauce_container_base.py', 'cauce_container_proc.py', 'cauce_container_tree.py'):
            shutil.copyfile(container_fixtures.fixtures.OPS / 'container-runtime' / filename,
                            self.old / 'ops/container-runtime' / filename)
        self.container = 'zz-canary-login-release-' + uuid.uuid4().hex[:12]
        subprocess.run([login.DOCKER, 'run', '-d', '--name', self.container, '--read-only', '--network', 'none',
            '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN',
            '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'SYS_PTRACE', '--cap-add', 'FOWNER',
            '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--tmpfs', '/run:rw,nosuid,noexec,size=16m',
            '--tmpfs', '/tmp:rw,nosuid,noexec,size=1m,mode=1777', '--workdir', '/tmp',
            '--env', 'PYTHONPATH=/tmp', '--env', 'PYTHONUSERBASE=/tmp',
            '--mount', 'type=bind,src=' + str(self.old / 'ops/cli') + ',dst=/cauce/executor,readonly',
            '--mount', 'type=bind,src=' + str(self.old / 'ops/container-runtime') + ',dst=/cauce/lifecycle,readonly',
            '--entrypoint', '/bin/sleep', self.image, 'infinity'], check=True, capture_output=True, timeout=30)
        self.addCleanup(subprocess.run, [login.DOCKER, 'rm', '-f', self.container], capture_output=True, timeout=30)
        planted = subprocess.run([login.DOCKER, 'exec', '-i', '--user', '65534:65534', self.container, '/bin/sh', '-c',
            'cat > /tmp/json.py; cp /tmp/json.py /tmp/sitecustomize.py'],
            input=b'open("/tmp/untrusted-import", "w").write("executed")\nraise RuntimeError("untrusted module")\n',
            capture_output=True, check=True, timeout=10)
        self.assertEqual(planted.returncode, 0)
        subprocess.run([login.DOCKER, 'exec', self.container, 'mkdir', '-m', '700', login.REMOTE_STATE],
                       check=True, capture_output=True, timeout=10)
        self.observed = json.loads(subprocess.run([login.DOCKER, 'inspect', self.container],
            check=True, capture_output=True, timeout=10).stdout)[0]
        self.binding = {'container_id': self.observed['Id'], 'image_digest': self.observed['Image'],
            'generation': hashlib.sha256((self.observed['Id'] + '\0' + self.observed['State']['StartedAt']).encode()).hexdigest(),
            'python': '/usr/local/bin/python3.12', 'helper': '/cauce/executor/provider-login.py'}
        self.operation = str(uuid.uuid4())
        self.addCleanup(login.release_reservation, self.operation)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.process = None
        self.frames = bytearray()
        with mock.patch.object(login, '__file__', str(self.old / 'ops/cli/provider_login_container.py')):
            login.reserve_runtime(self.binding, self.operation)
        with subprocess.Popen(['/bin/sleep', '0.01']) as departed:
            bridge = login.process_identity(departed.pid)
        self.save_receipt(bridge)

    def save_receipt(self, bridge):
        root = login.private_state(str(self.state))
        try:
            login.write_metadata(root, self.operation, {'schemaVersion': 1, 'operation_id': self.operation,
                'account_scope': 'fixture-account', 'backend': 'container', 'expires_at': 1,
                'boot_id': login.boot_identity(), 'controller': login.process_identity(os.getpid()),
                'bridge': bridge, 'container_binding': self.binding})
        finally:
            os.close(root)

    def cleanup(self):
        with mock.patch.object(login, '__file__', str(self.current / 'ops/cli/provider_login_container.py')):
            receipt = login.cleanup_container(self.operation, str(self.state))
        self.assertNotEqual(subprocess.run([login.DOCKER, 'exec', self.container, 'test', '-e', '/tmp/untrusted-import'],
                                         capture_output=True, timeout=10).returncode, 0)
        return receipt

    def assert_receipt_preserved(self):
        self.assertTrue((self.state / (self.operation + '.json')).is_file())
        with self.assertRaises(login.LoginFailure):
            login.assert_unreserved(self.binding['container_id'])

    def test_old_helper_cleans_absent_session_and_releases_saved_receipt(self):
        with mock.patch.object(login, '__file__', str(self.current / 'ops/cli/provider_login_container.py')):
            with self.assertRaisesRegex(login.LoginFailure, 'helper mount differs'):
                login.observe(self.binding)
        self.assertEqual(self.cleanup(), {'stopped_verified': True})
        self.assertFalse((self.state / (self.operation + '.json')).exists())
        login.assert_unreserved(self.binding['container_id'])
        self.assertEqual(subprocess.run([login.DOCKER, 'exec', self.container, 'test', '-e', '/proc/1'],
                                       capture_output=True, timeout=10).returncode, 0)

    def test_old_helper_cleans_missing_remote_state_only_after_proving_idle_container(self):
        subprocess.run([login.DOCKER, 'exec', self.container, 'rmdir', login.REMOTE_STATE],
                       check=True, capture_output=True, timeout=10)
        self.assertEqual(self.cleanup(), {'stopped_verified': True})
        self.assertFalse((self.state / (self.operation + '.json')).exists())
        login.assert_unreserved(self.binding['container_id'])
        self.assertNotEqual(subprocess.run([login.DOCKER, 'exec', self.container, 'test', '-e', login.REMOTE_STATE],
                                          capture_output=True, timeout=10).returncode, 0)

    def test_missing_remote_state_with_foreign_live_process_preserves_receipt_without_signaling(self):
        subprocess.run([login.DOCKER, 'exec', self.container, 'rmdir', login.REMOTE_STATE],
                       check=True, capture_output=True, timeout=10)
        foreign = subprocess.Popen([login.DOCKER, 'exec', '--user', '65534:65534', '-w', '/', self.container,
            self.binding['python'], '-I', '-B', '-c', 'import time;print("ready",flush=True);time.sleep(60)'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(select.select([foreign.stdout], [], [], 5)[0])
            self.assertEqual(foreign.stdout.readline(), b'ready\n')
            with mock.patch.object(login, 'signal_pidfd') as signal_process:
                with self.assertRaisesRegex(login.LoginFailure, 'remote login stop was not observed'):
                    self.cleanup()
                signal_process.assert_not_called()
            self.assertIsNone(foreign.poll())
            self.assert_receipt_preserved()
        finally:
            subprocess.run([login.DOCKER, 'rm', '-f', self.container], capture_output=True, timeout=30)
            foreign.wait(timeout=10)
            foreign.stdout.close()
            foreign.stderr.close()

    def test_old_helper_stops_its_exact_live_login_before_releasing_receipt(self):
        plan = {'operation_id': self.operation, 'command': [self.binding['python'], '-c', 'import time;time.sleep(60)'],
            'runtime_user': 'root', 'home': '/root', 'cwd': '/root', 'env': {'PATH': '/usr/bin:/bin'},
            'backend': 'native', 'state_root': login.REMOTE_STATE, 'account_scope': 'fixture-account'}
        self.process = subprocess.Popen(login.command(self.binding, '--container-child'),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.process.stdin.write(json.dumps(plan).encode() + b'\n')
            self.process.stdin.flush()
            started = self.wait_for('started')
            self.save_receipt(login.process_identity(self.process.pid))
            self.assertEqual(self.cleanup(), {'stopped_verified': True})
            self.process.wait(timeout=10)
            self.assertFalse((self.state / (self.operation + '.json')).exists())
            self.assertNotEqual(subprocess.run([login.DOCKER, 'exec', self.container, 'test', '-e',
                '/proc/' + str(started['pid'])], capture_output=True, timeout=10).returncode, 0)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=5)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()

    def test_previous_helper_refuses_foreign_remote_state_owner(self):
        subprocess.run([login.DOCKER, 'exec', self.container, 'chown', '65534:65534', login.REMOTE_STATE],
                       check=True, capture_output=True, timeout=10)
        with self.assertRaisesRegex(login.LoginFailure, 'remote login stop was not observed'):
            self.cleanup()
        self.assert_receipt_preserved()

    def test_invalid_old_mounts_are_rejected_without_signaling_or_discarding_receipt(self):
        cases = []
        for destination in ('/cauce/executor', '/cauce/lifecycle'):
            for field, value in (('RW', True), ('Source', '/unrelated/release/' + 'a' * 64 + '/ops/cli'),
                                 ('Type', 'volume')):
                observed = copy.deepcopy(self.observed)
                next(row for row in observed['Mounts'] if row['Destination'] == destination)[field] = value
                cases.append(observed)
        observed = copy.deepcopy(self.observed)
        observed['Mounts'].append(copy.deepcopy(observed['Mounts'][0]))
        cases.append(observed)
        for observed in cases:
            with self.subTest(mounts=observed['Mounts']), mock.patch.object(login.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], 0, json.dumps([observed]).encode())) as run, \
                    mock.patch.object(login, 'signal_pidfd') as signal_process:
                with self.assertRaisesRegex(login.LoginFailure, 'helper mount differs'):
                    self.cleanup()
                self.assertEqual(run.call_count, 1)
                signal_process.assert_not_called()
            self.assert_receipt_preserved()

    def test_unverified_previous_helper_stop_keeps_receipt_and_reservation(self):
        results = [subprocess.CompletedProcess([], 0, json.dumps([self.observed]).encode()),
                   subprocess.CompletedProcess([], 0, b'{"stopped_verified":false}')]
        with mock.patch.object(login.subprocess, 'run', side_effect=results), \
                mock.patch.object(login, 'signal_pidfd') as signal_process:
            with self.assertRaisesRegex(login.LoginFailure, 'stop proof differs'):
                self.cleanup()
            signal_process.assert_not_called()
        self.assert_receipt_preserved()


class ContainerLoginPtyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        container_fixtures.DisposableContainerExecutorTest.setUpClass.__func__(cls)
    save_policy = container_fixtures.DisposableContainerExecutorTest.save_policy
    run_step = container_fixtures.DisposableContainerExecutorTest.run_step
    configure_signer = container_fixtures.DisposableContainerExecutorTest.configure_signer
    configure_hooks = container_fixtures.DisposableContainerExecutorTest.configure_hooks
    configure_container = container_fixtures.DisposableContainerExecutorTest.configure_container
    frame = pty_fixtures.ProviderLoginPtyTest.frame
    send = pty_fixtures.ProviderLoginPtyTest.send
    wait_for = pty_fixtures.ProviderLoginPtyTest.wait_for
    output_until = pty_fixtures.ProviderLoginPtyTest.output_until

    def setUp(self):
        container_fixtures.DisposableContainerExecutorTest.setUp(self)
        self.configure_container()
        self.configure_signer()
        self.configure_hooks()
        self.policy['profiles']['fixture-account'].update(path=self.agent['state_directory'],
            runtime_user='nobody', container_name=self.container)
        self.save_policy()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.binding = json.loads(subprocess.run([sys.executable, str(container_fixtures.fixtures.CLI),
            '--policy', str(self.policy_file), '--binding'], input=json.dumps(self.context), capture_output=True,
            text=True, check=True, timeout=20).stdout)
        observed = json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]
        self.assertEqual(self.binding['runtime_binding']['container_id'], observed['Id'])
        self.assertEqual(self.binding['runtime_binding']['image_digest'], self.image)
        self.assertEqual(self.binding['runtime_binding']['generation'],
            hashlib.sha256((observed['Id'] + '\0' + observed['State']['StartedAt']).encode()).hexdigest())
        self.state = self.root / 'login-state'
        self.state.mkdir(mode=0o700)
        self.operation = str(uuid.uuid4())
        self.plan = {'operation_id': self.operation, 'command': ['/usr/local/bin/python3.12', '-c',
            'import sys,os,time,termios;'
            'a=termios.tcgetattr(0);a[3]&=~termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,a);'
            'print("CONTAINER_READY",os.getuid(),sys.stdin.isatty(),sys.stdout.isatty(),flush=True);'
            'line=sys.stdin.readline();print("INPUT_ACCEPTED",len(line.strip()),flush=True);time.sleep(60)'],
            'runtime_user': 'nobody', 'home': '/nonexistent', 'cwd': self.agent['state_directory'],
            'env': {'PATH': '/usr/bin:/bin'}, 'backend': 'container', 'state_root': str(self.state),
            'account_scope': 'fixture-account', 'container_binding': self.binding['runtime_binding']}
        self.process = None
        self.output = b''
        self.frames = bytearray()

    def tearDown(self):
        if self.process is not None:
            if self.process.poll() is None:
                try:
                    self.send({'type': 'close'})
                    self.process.wait(timeout=15)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    self.process.kill()
                    self.process.wait(timeout=3)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()
        container_fixtures.DisposableContainerExecutorTest.tearDown(self)

    def start(self):
        self.process = subprocess.Popen([sys.executable, str(pty_fixtures.HELPER)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.send(self.plan)
        started = self.wait_for('started')
        self.assertEqual(started['runtime_uid'], 65534)
        self.assertEqual(started['backend'], 'container')
        self.assertEqual(started['container_id'], self.binding['runtime_binding']['container_id'])
        self.output_until(b'CONTAINER_READY')
        self.assertIn(b'65534 True True', self.output)
        return started

    def assert_remote_stopped(self, started):
        result = subprocess.run(['docker', 'exec', self.container, 'test', '-e', '/proc/' + str(started['pid'])], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        state = subprocess.run(['docker', 'exec', self.container, 'test', '-e',
            '/run/cauce-provider-login/' + self.operation + '.json'], capture_output=True)
        self.assertNotEqual(state.returncode, 0)

    def test_container_pty_runs_exact_user_and_close_proves_remote_stop(self):
        started = self.start()
        self.send({'type': 'input', 'data': 'Q09OVEFJTkVSX1BSSVZBVEVfRklYVFVSRQo='})
        self.output_until(b'INPUT_ACCEPTED')
        metadata = (self.state / (self.operation + '.json')).read_bytes()
        self.assertNotIn(b'CONTAINER_PRIVATE_FIXTURE', metadata)
        self.assertNotIn(b'CONTAINER_READY', metadata)
        self.assertNotIn(b'command', metadata)
        self.send({'type': 'close'})
        self.assertTrue(self.wait_for('exited')['stopped_verified'])
        self.assertEqual(self.process.wait(timeout=10), 0, self.process.stderr.read().decode())
        self.assert_remote_stopped(started)
        self.assertFalse((self.state / (self.operation + '.json')).exists())

    def test_container_login_accepts_executor_owned_pinned_bridge_on_readonly_mount(self):
        self.worker.write_text(self.plan['command'][2])
        self.plan['command'] = [self.binding['runtime_binding']['python'], '-I', '-B', str(self.worker)]
        self.plan['command_files'] = {str(self.worker): hashlib.sha256(self.worker.read_bytes()).hexdigest()}
        started = self.start()
        self.send({'type': 'close'})
        self.assertTrue(self.wait_for('exited')['stopped_verified'])
        self.assertEqual(self.process.wait(timeout=10), 0, self.process.stderr.read().decode())
        self.assert_remote_stopped(started)

    def test_container_pins_reject_writable_mounts_and_changed_or_unsafe_bridge_files(self):
        self.plan['command_files'] = {str(self.worker): hashlib.sha256(self.worker.read_bytes()).hexdigest()}
        code = ('import json,sys;sys.path.insert(0,"/cauce/executor");'
                'import provider_login_native as n;n.native_user(json.load(sys.stdin),child=True)')
        def validate():
            return subprocess.run([login.DOCKER, 'exec', '-i', '--user', '0', '-w', '/', self.container,
                self.binding['runtime_binding']['python'], '-I', '-B', '-c', code],
                input=json.dumps(self.plan), capture_output=True, text=True, timeout=10)
        self.assertEqual(validate().returncode, 0)
        self.plan['command_files'][str(self.worker)] = '0' * 64
        self.assertNotEqual(validate().returncode, 0)
        self.plan['command_files'][str(self.worker)] = hashlib.sha256(self.worker.read_bytes()).hexdigest()
        self.worker.chmod(0o666)
        self.assertNotEqual(validate().returncode, 0)
        self.worker.chmod(0o644)
        alias = self.bundle / 'bridge-alias.py'
        os.link(self.worker, alias)
        self.assertNotEqual(validate().returncode, 0)
        alias.unlink()
        alias.symlink_to(self.worker)
        self.plan['command_files'] = {str(alias): hashlib.sha256(self.worker.read_bytes()).hexdigest()}
        self.assertNotEqual(validate().returncode, 0)
        writable = self.agent['state_directory'] + '/writable-bridge.py'
        prepare = ('import os,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_text("fixture");'
                   'os.chown(p,int(sys.argv[2]),int(sys.argv[2]));p.chmod(0o644)')
        subprocess.run([login.DOCKER, 'exec', '--user', '0', self.container,
            self.binding['runtime_binding']['python'], '-I', '-B', '-c', prepare, writable, str(os.geteuid() or 1000)],
            check=True, capture_output=True, timeout=10)
        self.plan['command_files'] = {writable: hashlib.sha256(b'fixture').hexdigest()}
        self.assertNotEqual(validate().returncode, 0)

    def test_container_controller_crash_cleanup_uses_exact_namespace(self):
        started = self.start()
        self.process.kill()
        self.process.wait(timeout=4)
        result = subprocess.run([sys.executable, str(pty_fixtures.HELPER), '--cleanup', self.operation, str(self.state)],
            capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['stopped_verified'])
        self.assert_remote_stopped(started)

    def test_changed_generation_is_rejected_before_login(self):
        self.plan['container_binding']['generation'] = 'f' * 64
        result = subprocess.run([sys.executable, str(pty_fixtures.HELPER)], input=json.dumps(self.plan) + '\n',
            capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('started', result.stdout)
        self.assertFalse((self.state / (self.operation + '.json')).exists())


if __name__ == '__main__':
    unittest.main()
