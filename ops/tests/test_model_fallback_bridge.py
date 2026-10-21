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
TURN = '9d3c2b1a-0f4e-4d5c-8b7a-1e2f3a4b5c6d'
CANARY = 'CANARY-auth-json-contents'
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
if mode == 'sleep':
    time.sleep(60)
def out(payload, payload_type=None):
    print(json.dumps({'schema_version': 1, 'stream': {'kind': 'session', 'id': known['session']},
                      **({'payload_type': payload_type} if payload_type else {}), 'payload': payload}), flush=True)
run = {'command_id': known['turn'], 'run_stream': {'kind': 'run', 'id': known['turn']}}
out({'kind': 'command_accepted', 'command_kind': 'turn.submit', 'command_id': known['turn']}, 'runtime.command.accepted')
if mode == 'tool':
    out({'kind': 'tool_result', 'call_id': 'c1', 'output': known['canary'], **run}, 'tool.result')
if mode == 'output':
    out({'kind': 'task_lifecycle', 'event': {'kind': 'output', 'text': 'Read text file `auth.json` ' + known['canary']}, **run},
        'task.lifecycle.output')
out({'kind': 'run_output_delta', 'text': 'Hola ', **run}, 'run.output.delta')
out({'kind': 'run_terminal', 'terminal': 'completed', 'text': 'Hola desde Muse', **run}, 'run.terminal.completed')
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
        (self.root / 'known.json').write_text(json.dumps({'session': SESSION, 'turn': TURN, 'canary': CANARY}))
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

    def client(self, *arguments: str, prompt: str = 'hola', socket_path: str | None = None, timeout: float = 20):
        return subprocess.run([sys.executable, '-I', '-B', str(CLI / 'model_fallback.py'), 'client', '--socket', socket_path or self.socket,
                               *arguments], input=prompt.encode(), capture_output=True, timeout=timeout, env={'PATH': '/usr/bin:/bin'})

    @staticmethod
    def records(result) -> list[dict]:
        return [json.loads(line) for line in result.stdout.decode().splitlines()]

    def raw(self, request: bytes) -> list[dict]:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(20)
            connection.connect(self.socket)
            connection.sendall(request)
            received = b''
            while chunk := connection.recv(65536):
                received += chunk
        return [json.loads(line) for line in received.decode().splitlines()]

    def test_one_fresh_text_turn_crosses_the_socket_with_the_safe_flags_and_the_system_boundary(self):
        system = self.root / 'system-prompt.txt'
        system.write_text('Eres el director.')
        result = self.client('--reasoning-effort', 'high', '--system-prompt-file', str(system))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.records(result)[-1], {'type': 'result', 'result': 'Hola desde Muse',
                                                    'item': {'type': 'assistant_message', 'text': 'Hola desde Muse'}})
        self.assertTrue(all(record['type'] in {'progress', 'result'} for record in self.records(result)))
        argv = json.loads((self.root / 'argv.json').read_text())
        self.assertEqual(argv, ['exec', '--json', '--provider', 'meta', '--disable-web-tools', '--disable-reminders',
            '--no-foreign-personal-context', '--disable-write', '--disable-shell', '--no-session-log', '--max-model-steps', '1',
            '--workspace', self.bridge.workspace, '--model', 'muse-spark-1.3', '--reasoning-effort', 'high'])
        self.assertEqual((self.root / 'cwd').read_text(), self.bridge.workspace)
        self.assertEqual(os.stat(self.bridge.workspace).st_mode & 0o777, 0o700)
        prompt = (self.root / 'prompt.txt').read_text()
        self.assertIn('OPENCLAW SYSTEM INSTRUCTIONS', prompt)
        self.assertIn('Eres el director.', prompt)
        self.assertNotIn('META_SECRET_FOR_TEST', json.loads((self.root / 'env.json').read_text()))

    def test_any_tool_activity_fails_the_turn_and_nothing_it_read_is_forwarded(self):
        for mode in ('tool', 'output'):
            with self.subTest(mode=mode):
                (self.root / 'mode').write_text(mode)
                result = self.client()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.records(result)[-1], bridge.error_record('MUSE_TOOL_REFUSED'))
                self.assertNotIn(CANARY, result.stdout.decode())
                self.assertNotIn('Hola desde Muse', result.stdout.decode())

    def test_there_is_no_session_to_resume(self):
        refused = self.client('--session-id', SESSION)
        self.assertEqual(self.records(refused), [bridge.error_record('MUSE_ARGUMENTS_INVALID')])
        self.assertEqual(self.raw(b'{"v":1,"prompt_bytes":4,"session_id":"%s"}\nhola' % SESSION.encode())[-1]['type'], 'result')
        self.assertNotIn('--session-id', json.loads((self.root / 'argv.json').read_text()))

    def test_the_server_accepts_only_its_fixed_request_and_survives_hostile_ones(self):
        result = self.client('--reasoning-effort', 'turbo')
        self.assertEqual(self.records(result)[-1]['code'], 'MUSE_INPUT_INVALID')
        self.assertFalse((self.root / 'argv.json').exists())
        request = b'{"v":1,"prompt_bytes":4,"argv":["--yolo"],"command":"/bin/sh","model":"other","workspace":"/"}\nhola'
        self.assertEqual(self.raw(request)[-1]['type'], 'result')
        argv = json.loads((self.root / 'argv.json').read_text())
        self.assertNotIn('--yolo', argv)
        self.assertEqual((argv[argv.index('--model') + 1], argv[argv.index('--workspace') + 1]), ('muse-spark-1.3', self.bridge.workspace))
        for request in (b'not json\n', b'{"v":2,"prompt_bytes":4}\nhola', b'{"v":1,"prompt_bytes":0}\n', b'[' * 200_000 + b'\n',
                        b'{"v":1,"prompt_bytes":%d}\n' % (bridge.MAX_PROMPT_BYTES + 1), b'{"v":1,"prompt_bytes":2}\n\xff\xfe'):
            self.assertEqual(self.raw(request), [bridge.error_record('MUSE_INPUT_INVALID')], request[:40])
        self.assertEqual(self.client().returncode, 0)

    def test_the_client_never_follows_a_planted_link_and_reads_only_a_bounded_system_prompt_file(self):
        link = self.root / 'run' / 'planted.sock'
        link.symlink_to(self.socket)
        self.assertEqual(self.records(self.client(socket_path=str(link))), [bridge.error_record('MUSE_BRIDGE_UNAVAILABLE')])
        large = self.root / 'large.txt'
        large.write_bytes(b'x' * (bridge.MAX_SYSTEM_PROMPT_BYTES + 1))
        for path in (str(large), str(self.root / 'missing.txt'), str(self.root)):
            self.assertEqual(self.records(self.client('--system-prompt-file', path)), [bridge.error_record('MUSE_INPUT_INVALID')])

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
