from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import pwd
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HELPER = pathlib.Path(__file__).resolve().parents[1] / 'cli/provider-login.py'


class ProviderLoginPtyTest(unittest.TestCase):
    def setUp(self):
        user = pwd.getpwuid(os.getuid())
        self.temporary = tempfile.TemporaryDirectory(prefix='provider-login-fixture-', dir=user.pw_dir)
        self.root = pathlib.Path(self.temporary.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.operation = str(uuid.uuid4())
        self.worker = self.root / 'login.py'
        self.worker.write_text('import sys,termios,os,time,signal\n'
            'a=termios.tcgetattr(0);a[3]&=~termios.ECHO;termios.tcsetattr(0,termios.TCSANOW,a)\n'
            'print("TTY_READY",os.getuid(),sys.stdin.isatty(),sys.stdout.isatty(),flush=True)\n'
            'print("DIRECTORIES",os.environ["HOME"],os.getcwd(),flush=True)\n'
            'signal.signal(signal.SIGWINCH,lambda *_: print("RESIZED",termios.tcgetwinsize(0)[1],flush=True))\n'
            'line=sys.stdin.readline();print("INPUT_ACCEPTED",len(line.strip()),flush=True)\n'
            'time.sleep(60)\n')
        executable = pathlib.Path(sys.executable).resolve()
        self.plan = {'operation_id': self.operation, 'command': [str(executable), str(self.worker)],
            'command_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'runtime_user': user.pw_name,
            'home': str(self.root), 'cwd': str(self.root), 'env': {'PATH': '/usr/bin:/bin'},
            'backend': 'native', 'state_root': str(self.state), 'account_scope': 'fixture-account'}
        self.process = None
        self.child = None
        self.output = b''
        self.frames = bytearray()
        self.child_ticks = None

    def tearDown(self):
        if self.process is not None:
            if self.process.poll() is None:
                try:
                    self.send({'type': 'close'})
                except (BrokenPipeError, ValueError):
                    pass
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream:
                    stream.close()
        if self.child:
            try:
                descriptor = os.pidfd_open(self.child)
            except ProcessLookupError:
                pass
            else:
                raw = pathlib.Path('/proc/' + str(self.child) + '/stat').read_text()
                if self.child_ticks == int(raw[raw.rfind(')') + 2:].split()[19]):
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                os.close(descriptor)
        self.temporary.cleanup()

    def start(self):
        self.process = subprocess.Popen([sys.executable, str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        self.send(self.plan)
        started = self.wait_for('started')
        self.child = started['pid']
        self.child_ticks = started['start_ticks']
        self.assertEqual(started['operation_id'], self.operation)
        self.assertEqual(started['runtime_uid'], os.getuid())
        return started

    def send(self, frame):
        self.process.stdin.write(json.dumps(frame).encode() + b'\n')
        self.process.stdin.flush()

    def frame(self, timeout=6):
        deadline = time.monotonic() + timeout
        while b'\n' not in self.frames:
            ready = select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))[0]
            self.assertTrue(ready, 'PTY protocol did not produce a frame')
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                self.fail('PTY protocol ended before observed effect: ' + self.process.stderr.read().decode())
            self.frames.extend(data)
        line, _, remaining = self.frames.partition(b'\n')
        self.frames = bytearray(remaining)
        if not line:
            failure = self.process.stderr.read().decode()
            self.fail('PTY protocol ended before observed effect: ' + failure)
        item = json.loads(line)
        if item['type'] == 'output':
            self.output += base64.b64decode(item['data'])
        return item

    def wait_for(self, kind):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            frame = self.frame()
            if frame['type'] == kind:
                return frame
        self.fail('missing bounded PTY protocol event')

    def output_until(self, marker):
        while marker not in self.output:
            self.frame()

    def test_real_pty_input_resize_close_and_no_transcript_persisted(self):
        started = self.start()
        self.output_until(b'TTY_READY')
        self.assertIn(b'True True', self.output)
        self.output_until(b'DIRECTORIES')
        self.assertIn(('DIRECTORIES ' + str(self.root) + ' ' + str(self.root)).encode(), self.output)
        secret = b'TYPED_PRIVATE_FIXTURE'
        self.send({'type': 'input', 'data': base64.b64encode(secret + b'\n').decode()})
        self.output_until(b'INPUT_ACCEPTED')
        self.send({'type': 'resize', 'rows': 33, 'cols': 99})
        self.output_until(b'RESIZED 99')
        metadata = (self.state / (self.operation + '.json')).read_bytes()
        self.assertIn(str(started['start_ticks']).encode(), metadata)
        self.assertNotIn(secret, metadata)
        self.assertNotIn(str(self.worker).encode(), metadata)
        self.assertNotIn(b'TTY_READY', metadata)
        self.send({'type': 'close'})
        exited = self.wait_for('exited')
        self.assertTrue(exited['stopped_verified'])
        self.assertEqual(self.process.wait(timeout=4), 0)
        self.assertFalse(pathlib.Path('/proc/' + str(self.child)).exists())
        self.assertFalse((self.state / (self.operation + '.json')).exists())

    def test_stdin_eof_and_sigterm_stop_only_the_owned_process(self):
        for termination in ('eof', 'signal'):
            self.operation = str(uuid.uuid4())
            self.plan['operation_id'] = self.operation
            self.output = b''
            self.frames = bytearray()
            self.start()
            if termination == 'eof':
                self.process.stdin.close()
            else:
                self.process.send_signal(signal.SIGTERM)
            exited = self.wait_for('exited')
            self.assertTrue(exited['stopped_verified'])
            self.assertEqual(self.process.wait(timeout=4), 0)
            self.assertFalse(pathlib.Path('/proc/' + str(self.child)).exists())
            self.child = None
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if not stream.closed:
                    stream.close()

    def test_invalid_frame_has_curated_error_and_stops_owned_child(self):
        self.start()
        self.send({'type': 'untrusted', 'secret': 'PRIVATE_BAD_FRAME_FIXTURE'})
        exited = self.wait_for('exited')
        self.assertTrue(exited['stopped_verified'])
        self.process.wait(timeout=4)
        self.assertNotIn(b'PRIVATE_BAD_FRAME_FIXTURE', self.output + self.process.stderr.read())

    def test_cleanup_after_controller_crash_checks_pid_ticks_and_no_login_bytes(self):
        self.worker.write_text('import time,signal,sys\nsignal.signal(signal.SIGHUP,signal.SIG_IGN)\n'
            'print("CRASH_READY",flush=True)\ntime.sleep(60)\n')
        self.start()
        self.output_until(b'CRASH_READY')
        self.process.kill()
        self.process.wait(timeout=4)
        result = subprocess.run([sys.executable, str(HELPER), '--cleanup', self.operation, str(self.state)],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['stopped_verified'])
        self.assertFalse((self.state / (self.operation + '.json')).exists())

    def test_lifetime_stops_term_resistant_process_and_descendant(self):
        self.plan['ttl_seconds'] = 1
        self.worker.write_text('import os,signal,time,subprocess,sys\n'
            'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
            'p=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"],start_new_session=True)\n'
            'print("DESCENDANT",p.pid,flush=True)\ntime.sleep(60)\n')
        self.start()
        self.output_until(b'DESCENDANT')
        child = int(self.output.split(b'DESCENDANT ')[1].split()[0])
        self.assertTrue(self.wait_for('exited')['stopped_verified'])
        self.assertEqual(self.process.wait(timeout=4), 0)
        self.assertFalse(pathlib.Path('/proc/' + str(self.child)).exists())
        self.assertFalse(pathlib.Path('/proc/' + str(child)).exists())

    def test_cleanup_rejects_reused_ticks_without_signalling_foreign_process(self):
        foreign = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'])
        try:
            raw = pathlib.Path('/proc/' + str(foreign.pid) + '/stat').read_text()
            ticks = int(raw[raw.rfind(')') + 2:].split()[19])
            metadata = {'schemaVersion': 1, 'operation_id': self.operation, 'account_scope': 'fixture-account',
                'backend': 'native', 'runtime_uid': os.getuid(), 'controller': {'pid': 999999999, 'start_ticks': 1},
                'guardian': {'pid': 999999999, 'start_ticks': 1}, 'expires_at': int(time.time()) + 20,
                'boot_id': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                'processes': [{'pid': foreign.pid, 'start_ticks': ticks + 1}]}
            path = self.state / (self.operation + '.json')
            path.write_text(json.dumps(metadata))
            path.chmod(0o600)
            result = subprocess.run([sys.executable, str(HELPER), '--cleanup', self.operation, str(self.state)],
                capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(foreign.poll())
            self.assertTrue(path.exists())
        finally:
            foreign.kill()
            foreign.wait(timeout=3)

    def test_changed_pinned_argument_or_symlinked_state_is_rejected_before_start(self):
        self.plan['command_files'] = {str(self.worker): hashlib.sha256(self.worker.read_bytes()).hexdigest()}
        self.worker.write_text('print("PRIVATE_CHANGED_FIXTURE")\n')
        result = subprocess.run([sys.executable, str(HELPER)], input=json.dumps(self.plan) + '\n',
            capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('PRIVATE_CHANGED_FIXTURE', result.stdout + result.stderr)
        self.plan.pop('command_files')
        self.state.rename(self.root / 'real-state')
        self.state.symlink_to(self.root / 'real-state')
        result = subprocess.run([sys.executable, str(HELPER)], input=json.dumps(self.plan) + '\n',
            capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('started', result.stdout)

    def test_leader_exit_still_stops_adopted_descendant_with_new_session(self):
        gate = self.root / 'leader-release'
        self.worker.write_text('import sys,time,subprocess,pathlib\n'
            'while not pathlib.Path(' + repr(str(gate)) + ').exists(): time.sleep(0.01)\n'
            'p=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGHUP,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"],start_new_session=True)\n'
            'print("ORPHAN",p.pid,flush=True)\n')
        self.start()
        guardian = json.loads((self.state / (self.operation + '.json')).read_text())['guardian']
        descriptor = os.pidfd_open(guardian['pid'])
        try:
            raw = pathlib.Path('/proc/' + str(guardian['pid']) + '/stat').read_text()
            self.assertEqual(int(raw[raw.rfind(')') + 2:].split()[19]), guardian['start_ticks'])
            self.assertEqual(pathlib.Path('/proc/' + str(guardian['pid'])).stat().st_uid, os.geteuid())
            signal.pidfd_send_signal(descriptor, signal.SIGSTOP)
            gate.write_text('release')
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                raw = pathlib.Path('/proc/' + str(self.child) + '/stat').read_text()
                if raw[raw.rfind(')') + 2:].split()[0] == 'Z':
                    break
                time.sleep(0.01)
            else:
                self.fail('leader did not exit with terminal output pending')
        finally:
            signal.pidfd_send_signal(descriptor, signal.SIGCONT)
            os.close(descriptor)
        self.output_until(b'ORPHAN')
        child = int(self.output.split(b'ORPHAN ')[1].split()[0])
        self.assertTrue(self.wait_for('exited')['stopped_verified'])
        self.assertEqual(self.process.wait(timeout=4), 0)
        self.assertFalse(pathlib.Path('/proc/' + str(child)).exists())
        self.assertFalse((self.state / (self.operation + '.json')).exists())

    def test_term_handler_cannot_leave_a_new_orphan_after_stop_proof(self):
        child_file = self.root / 'escape.pid'
        self.worker.write_text('import sys,time,subprocess,signal,pathlib\n'
            'def escape(*_):\n'
            ' p=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"],start_new_session=True)\n'
            ' pathlib.Path(' + repr(str(child_file)) + ').write_text(str(p.pid))\n'
            ' sys.exit(0)\n'
            'signal.signal(signal.SIGTERM,escape)\nprint("ESCAPE_READY",flush=True)\ntime.sleep(60)\n')
        self.start()
        self.output_until(b'ESCAPE_READY')
        self.send({'type': 'close'})
        self.assertTrue(self.wait_for('exited')['stopped_verified'])
        self.assertEqual(self.process.wait(timeout=4), 0)
        self.assertTrue(child_file.exists())
        self.assertFalse(pathlib.Path('/proc/' + child_file.read_text()).exists())


if __name__ == '__main__':
    unittest.main()
