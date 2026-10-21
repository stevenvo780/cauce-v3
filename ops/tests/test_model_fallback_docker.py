from __future__ import annotations

# cauce:requiere docker
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
import fleet_executor_container as container  # noqa: E402

IMAGE = 'python:3.12-slim'
SESSION = '0b5b1c3e-8d0e-4a57-9b1e-6c2f1d9a7e01'
TURN = '9d3c2b1a-0f4e-4d5c-8b7a-1e2f3a4b5c6d'
FAKE_MUSE_CAUCE = '''#!/usr/local/bin/python3
import json, sys
args = sys.argv[1:]
prompt = sys.stdin.read()
session = args[args.index('--session-id') + 1] if '--session-id' in args else 'SESSION'
def out(payload):
    print(json.dumps({'schema_version': 1, 'stream': {'kind': 'session', 'id': session}, 'payload': payload}), flush=True)
run = {'command_id': 'TURN', 'run_stream': {'kind': 'run', 'id': 'TURN'}}
out({'kind': 'command_accepted', 'command_kind': 'turn.submit', 'command_id': 'TURN'})
out({'kind': 'run_terminal', 'terminal': 'completed', 'text': 'Muse: ' + prompt[-4:] + ' ' + ' '.join(args), **run})
'''


def docker(*arguments: str, check: bool = True, timeout: float = 60, input_data: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(['docker', *arguments], capture_output=True, timeout=timeout, check=check, input=input_data)


class ModelFallbackDockerTest(unittest.TestCase):
    """The approved shape on a real daemon: rw socket volume for Muse, read-only for OpenClaw, same runtime uid."""

    @classmethod
    def setUpClass(cls):
        if docker('image', 'inspect', IMAGE, check=False).returncode:
            raise unittest.SkipTest('disposable local Python image is unavailable')

    def setUp(self):
        suffix = uuid.uuid4().hex[:10]
        self.server, self.client = f'zz-canary-model-fallback-server-{suffix}', f'zz-canary-model-fallback-client-{suffix}'
        self.volume = f'zz-canary-model-fallback-{suffix}'
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-model-fallback-docker-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        fake = pathlib.Path(self.temporary.name) / 'muse-cauce'
        fake.write_text(FAKE_MUSE_CAUCE.replace('SESSION', SESSION).replace('TURN', TURN))
        fake.chmod(0o755)
        self.addCleanup(docker, 'volume', 'rm', '-f', self.volume, check=False)
        self.addCleanup(docker, 'rm', '-f', self.server, self.client, check=False)
        docker('volume', 'create', '--label', 'cauce.fleet.volume=model-fallback', self.volume)
        isolation = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', 'none',
                     '--volume', f'{OPS / "cli"}:/cauce/executor:ro,z', '--volume', f'{OPS / "container-runtime"}:/cauce/lifecycle:ro,z']
        for name, socket_mount in ((self.server, f'type=volume,source={self.volume},destination=/cauce/model-fallback'),
                                   (self.client, f'type=volume,source={self.volume},destination=/cauce/model-fallback,readonly')):
            extra = ['--volume', f'{fake}:/usr/local/bin/muse-cauce:ro,z', '--tmpfs', '/profile:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700',
                     '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE'] if name == self.server else []
            docker('run', '-d', '--name', name, *isolation, *extra, '--mount', socket_mount, '--entrypoint', '/bin/sleep', IMAGE, 'infinity')
        docker('exec', '-u', '0', self.server, *container.isolated_python('python3', '/cauce/lifecycle/cauce-container-runtime.py', 'prepare-state',
               '--mount', '/cauce/model-fallback', '--state', '/cauce/model-fallback', '--uid', '1000', '--gid', '1000'))
        docker('exec', '-d', '-u', '1000:1000', '-e', 'XDG_DATA_HOME=/profile/data', '-e', 'XDG_CONFIG_HOME=/profile/config',
               '-e', 'TMPDIR=/profile', '-e', 'HOME=/profile', self.server, 'python3', '-I', '-B', '/cauce/executor/model_fallback.py',
               'serve', '--socket', '/cauce/model-fallback/muse.sock', '--model', 'muse-spark-1.3')
        deadline = time.monotonic() + 20
        while docker('exec', self.server, 'test', '-S', '/cauce/model-fallback/muse.sock', check=False).returncode:
            self.assertLess(time.monotonic(), deadline, 'the bridge server did not bind its socket')
            time.sleep(0.2)

    def ask(self, user: str, *arguments: str) -> tuple[int, list[dict]]:
        result = docker('exec', '-i', '-u', user, self.client, 'python3', '-I', '-B', '/cauce/executor/model_fallback.py', 'client',
                        '--socket', '/cauce/model-fallback/muse.sock', *arguments, check=False, input_data=b'hola')
        return result.returncode, [json.loads(line) for line in result.stdout.decode().splitlines()]

    def test_the_read_only_client_reaches_the_server_and_nothing_else_can(self):
        mounts = {row['Destination']: row for row in json.loads(docker('inspect', self.client).stdout)[0]['Mounts']}
        self.assertEqual({key: mounts['/cauce/model-fallback'][key] for key in ('Type', 'Name', 'RW')},
                         {'Type': 'volume', 'Name': self.volume, 'RW': False})
        code, records = self.ask('1000:1000', '--reasoning-effort', 'high')
        self.assertEqual(code, 0, records)
        self.assertEqual(records[0], {'type': 'system', 'session_id': SESSION})
        self.assertTrue(records[-1]['result'].startswith('Muse: hola exec --json --provider meta'))
        self.assertIn('--max-model-steps 1', records[-1]['result'])
        code, records = self.ask('1000:1000', '--session-id', SESSION)
        self.assertEqual((code, records[-1]['type']), (0, 'result'))
        self.assertEqual(self.ask('1001:1001'), (1, [{'type': 'error', 'code': 'MUSE_BRIDGE_UNAVAILABLE',
                                                       'error': 'Muse fallback bridge is unavailable'}]))
        self.assertNotEqual(docker('exec', '-u', '1000:1000', self.client, 'touch', '/cauce/model-fallback/planted', check=False).returncode, 0)
        listing = docker('exec', '-u', '0', self.server, 'stat', '-c', '%a %u %n', '/cauce/model-fallback', '/cauce/model-fallback/muse.sock')
        self.assertEqual(listing.stdout.decode().split('\n')[:2], ['700 1000 /cauce/model-fallback', '600 1000 /cauce/model-fallback/muse.sock'])


if __name__ == '__main__':
    unittest.main()
