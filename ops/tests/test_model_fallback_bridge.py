from __future__ import annotations

import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'
sys.path.insert(0, str(CLI))
import model_fallback as bridge  # noqa: E402

SESSION = '0b5b1c3e-8d0e-4a57-9b1e-6c2f1d9a7e01'
OTHER = '6f0f3a52-2c4b-4f0e-8a1d-3b7e9c5d2a10'
TURN = '9d3c2b1a-0f4e-4d5c-8b7a-1e2f3a4b5c6d'
FAKE_MUSE = '''import json, os, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
args = sys.argv[2:]
prompt = sys.stdin.read()
(root / 'argv.json').write_text(json.dumps(args))
(root / 'prompt.txt').write_text(prompt)
(root / 'env.json').write_text(json.dumps(dict(os.environ)))
(root / 'cwd').write_text(os.getcwd())
(root / 'pid').write_text(str(os.getpid()))
mode = (root / 'mode').read_text() if (root / 'mode').exists() else ''
known = json.loads((root / 'known.json').read_text())
session = args[args.index('--session-id') + 1] if '--session-id' in args else known['session']
if mode == 'changed':
    session = known['other']
if mode == 'sleep':
    time.sleep(60)
def out(payload):
    print(json.dumps({'schema_version': 1, 'stream': {'kind': 'session', 'id': session}, 'payload': payload}), flush=True)
run = {'command_id': known['turn'], 'run_stream': {'kind': 'run', 'id': known['turn']}}
out({'kind': 'command_accepted', 'command_kind': 'turn.submit', 'command_id': known['turn']})
out({'kind': 'run_output_delta', 'text': 'Hola ', **run})
out({'kind': 'run_terminal', 'terminal': 'completed', 'text': 'Hola desde Muse', **run})
'''


class ModelFallbackBridgeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-model-fallback-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        (self.root / 'run').mkdir(mode=0o700)
        self.socket = str(self.root / 'run' / 'muse.sock')
        self.bridge = bridge.Bridge(str(self.root / 'state'))
        fake = self.root / 'fake-muse.py'
        fake.write_text(FAKE_MUSE)
        (self.root / 'known.json').write_text(json.dumps({'session': SESSION, 'other': OTHER, 'turn': TURN}))
        self.stop = threading.Event()
        ready = threading.Event()
        os.environ['META_SECRET_FOR_TEST'] = 'must-not-cross'
        self.addCleanup(os.environ.pop, 'META_SECRET_FOR_TEST', None)
        self.server = threading.Thread(target=bridge.serve, args=(self.socket, 'muse-spark-1.3'), daemon=True,
            kwargs={'command': (sys.executable, str(fake), str(self.root)), 'stop': self.stop, 'bridge': self.bridge, 'ready': ready.set})
        self.server.start()
        self.assertTrue(ready.wait(5))
        self.addCleanup(self.server.join, 5)
        self.addCleanup(self.stop.set)

    def client(self, *arguments: str, prompt: str = 'hola', timeout: float = 20):
        return subprocess.run([sys.executable, '-I', '-B', str(CLI / 'model_fallback.py'), 'client', '--socket', self.socket, *arguments],
            input=prompt.encode(), capture_output=True, timeout=timeout, env={'PATH': '/usr/bin:/bin'})

    @staticmethod
    def records(result) -> list[dict]:
        return [json.loads(line) for line in result.stdout.decode().splitlines()]

    def test_one_turn_crosses_the_socket_with_the_safe_flags_and_the_system_boundary(self):
        result = self.client('--reasoning-effort', 'high', '--system-prompt', 'Eres el director.')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        records = self.records(result)
        self.assertEqual(records[0], {'type': 'system', 'session_id': SESSION})
        self.assertEqual(records[-1], {'type': 'result', 'result': 'Hola desde Muse', 'session_id': SESSION,
                                       'item': {'type': 'assistant_message', 'text': 'Hola desde Muse'}})
        argv = json.loads((self.root / 'argv.json').read_text())
        workspace = argv[argv.index('--workspace') + 1]
        self.assertEqual(argv, ['exec', '--json', '--provider', 'meta', '--disable-web-tools', '--disable-reminders',
            '--no-foreign-personal-context', '--disable-write', '--disable-shell', '--max-model-steps', '1',
            '--workspace', self.bridge.workspace, '--model', 'muse-spark-1.3', '--reasoning-effort', 'high'])
        self.assertEqual((self.root / 'cwd').read_text(), workspace)
        self.assertEqual(os.stat(workspace).st_mode & 0o777, 0o700)
        prompt = (self.root / 'prompt.txt').read_text()
        self.assertIn('OPENCLAW SYSTEM INSTRUCTIONS', prompt)
        self.assertIn('Eres el director.', prompt)
        self.assertIn('--- USER REQUEST', prompt)
        self.assertNotIn('META_SECRET_FOR_TEST', json.loads((self.root / 'env.json').read_text()))

    def test_only_sessions_this_bridge_created_resume_and_a_changed_one_fails(self):
        refused = self.client('--session-id', SESSION)
        self.assertEqual(self.records(refused), [bridge.error_record('MUSE_SESSION_INVALID')])
        self.assertFalse((self.root / 'argv.json').exists())
        self.assertEqual(self.client().returncode, 0)
        self.assertEqual(self.bridge.sessions(), [SESSION])
        result = self.client('--session-id', SESSION)
        self.assertEqual(result.returncode, 0, result.stdout)
        argv = json.loads((self.root / 'argv.json').read_text())
        self.assertEqual(argv[argv.index('--session-id') + 1], SESSION)
        (self.root / 'mode').write_text('changed')
        failed = self.client('--session-id', SESSION)
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(self.records(failed)[-1]['code'], 'MUSE_SESSION_CHANGED')

    def test_the_server_accepts_only_its_fixed_request(self):
        for arguments, code in ((['--reasoning-effort', 'turbo'], 'MUSE_INPUT_INVALID'), (['--session-id', 'not-a-uuid'], 'MUSE_SESSION_INVALID')):
            result = self.client(*arguments)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(self.records(result)[-1]['code'], code)
        self.assertFalse((self.root / 'argv.json').exists())
        request = b'{"v":1,"prompt_bytes":4,"argv":["--yolo"],"command":"/bin/sh","model":"other","workspace":"/"}\nhola'
        self.assertEqual(self.raw(request)[-1]['type'], 'result')
        argv = json.loads((self.root / 'argv.json').read_text())
        self.assertNotIn('--yolo', argv)
        self.assertEqual((argv[argv.index('--model') + 1], argv[argv.index('--workspace') + 1]), ('muse-spark-1.3', self.bridge.workspace))
        for request in (b'not json\n', b'{"v":2,"prompt_bytes":4}\nhola', b'{"v":1,"prompt_bytes":0}\n',
                        b'{"v":1,"prompt_bytes":%d}\n' % (bridge.MAX_PROMPT_BYTES + 1), b'{"v":1,"prompt_bytes":2}\n\xff\xfe'):
            self.assertEqual(self.raw(request), [bridge.error_record('MUSE_INPUT_INVALID')], request[:40])

    def raw(self, request: bytes) -> list[dict]:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(20)
            connection.connect(self.socket)
            connection.sendall(request)
            received = b''
            while chunk := connection.recv(65536):
                received += chunk
        return [json.loads(line) for line in received.decode().splitlines()]

    def test_a_vanished_client_cancels_the_running_turn(self):
        (self.root / 'mode').write_text('sleep')
        client = subprocess.Popen([sys.executable, '-I', '-B', str(CLI / 'model_fallback.py'), 'client', '--socket', self.socket],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        client.stdin.write(b'hola')
        client.stdin.close()
        deadline = time.monotonic() + 10
        while not (self.root / 'pid').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        pid = int((self.root / 'pid').read_text())
        client.kill()
        client.communicate(timeout=5)
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail('the Muse turn survived its client')
        (self.root / 'mode').unlink()
        self.assertEqual(self.client().returncode, 0)

    def test_only_the_same_runtime_user_is_served_on_a_private_directory(self):
        with mock.patch.object(bridge.os, 'geteuid', return_value=os.geteuid() + 1):
            self.assertEqual(self.raw(b''), [bridge.error_record('MUSE_PEER_DENIED')])
        self.assertFalse((self.root / 'argv.json').exists())
        public = self.root / 'public'
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaises(SystemExit):
            bridge.listen(str(public / 'muse.sock'))

    def test_the_client_fails_closed_without_a_server(self):
        self.stop.set()
        self.server.join(5)
        result = self.client()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.records(result), [bridge.error_record('MUSE_BRIDGE_UNAVAILABLE')])


if __name__ == '__main__':
    unittest.main()
