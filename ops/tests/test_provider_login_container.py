from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor_container as container_fixtures
import test_provider_login as pty_fixtures


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
