from __future__ import annotations

import json
import pathlib
import selectors
import subprocess

from fleet_adoption_probe_policy import ProbeFailure


def source() -> str:
    parent = pathlib.Path(__file__).parent
    policy = (parent / 'fleet_adoption_probe_policy.py').read_text()
    measure = (parent / 'fleet_adoption_probe_measure.py').read_text()
    measure = measure.replace('from __future__ import annotations', '')
    measure = measure.replace('from fleet_adoption_probe_policy import ProbeFailure, digest_file, open_directory', '')
    lifecycle = (parent / 'fleet_adoption_probe_lifecycle.py').read_text().replace('from __future__ import annotations', '')
    driver = '''
def emit(value):
    print(json.dumps(value,separators=(',',':')),flush=True)
request=json.loads(sys.stdin.readline(1048577))
row=request['row']
if request.get('action') == 'recover':
    recover_custody(row,request['session_nonce'],request.get('identity'))
    emit({'ok':True})
    sys.exit(0)
context=request['container']
retainer=LifecycleRetainer(row,request['identity'],request['session_nonce'])
try:
    retainer.acquire()
    emit({'ok':True})
    for line in sys.stdin:
        request=json.loads(line)
        if request == {'action':'assert'}:
            try:
                retainer.assert_held()
                measured=observe_local(row,context)
                emit({'ok':True,'identity':measured['physical_identity_sha256']})
            except (OSError,ValueError,RuntimeError,KeyError):
                emit({'ok':False})
        elif request == {'action':'release'}:
            retainer.close()
            emit({'ok':True})
            break
        else:
            raise ValueError('invalid_retainer_request')
finally:
    retainer.abandon()
'''
    return policy + '\n' + measure + '\n' + lifecycle + '\n' + driver


def recover_docker(row: dict, session_nonce: str, identity: dict) -> None:
    result = subprocess.run(['docker', 'exec', '-i', '--user', '0', row['observation']['container_id'],
        '/usr/bin/python3', '-B', '-c', source()], input=json.dumps({'action': 'recover', 'row': row, 'session_nonce': session_nonce, 'identity': identity}) + '\n',
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=45)
    if result.returncode != 0 or json.loads(result.stdout).get('ok') is not True:
        raise ProbeFailure('container_lifecycle_recovery_unavailable')


class DockerLifecycleRetainer:
    def __init__(self, row: dict, measured: dict, session_nonce: str):
        self.row, self.measured = row, measured
        self.session_nonce = session_nonce
        self.child = None
        self.selector = selectors.DefaultSelector()

    def receive(self) -> dict:
        if self.child is None or not self.selector.select(40):
            raise ProbeFailure('container_lifecycle_retainer_unavailable')
        line = self.child.stdout.readline(8193)
        if len(line) > 8192 or not line.endswith('\n'):
            raise ProbeFailure('container_lifecycle_retainer_unavailable')
        reply = json.loads(line)
        if not isinstance(reply, dict) or reply.get('ok') is not True:
            raise ProbeFailure('container_lifecycle_fence_lost')
        return reply

    def send(self, request: dict) -> None:
        if self.child is None or self.child.poll() is not None:
            raise ProbeFailure('container_lifecycle_fence_lost')
        self.child.stdin.write(json.dumps(request, separators=(',', ':')) + '\n')
        self.child.stdin.flush()

    def acquire(self) -> None:
        container_id = self.row['observation']['container_id']
        self.child = subprocess.Popen(['docker', 'exec', '-i', '--user', '0', container_id, '/usr/bin/python3', '-B', '-c', source()],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.selector.register(self.child.stdout, selectors.EVENT_READ)
        self.send({'row': self.row, 'container': self.measured['container'], 'identity': self.measured['lifecycle_identity'], 'session_nonce': self.session_nonce})
        self.receive()
        self.assert_held()

    def assert_held(self) -> None:
        self.send({'action': 'assert'})
        reply = self.receive()
        if reply.get('identity') != self.measured['physical_identity_sha256']:
            raise ProbeFailure('container_physical_identity_changed')

    def close(self) -> None:
        if self.child is None:
            self.selector.close()
            return
        try:
            if self.child.poll() is None:
                try:
                    self.send({'action': 'release'})
                    self.receive()
                except (OSError, ValueError):
                    pass
        finally:
            self.abandon()

    def abandon(self) -> None:
        if self.child is not None:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)
            self.child.stdout.close()
            self.selector.close()
            self.child = None
