from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import time
import uuid

from cauce_container_proc import open_pidfd, pidfd_running, signal_pidfd
from provider_login_native import Frames, boot_identity, pin_identity, process_identity
from provider_login_state import (
    LoginFailure,
    acquire,
    canonical_path,
    private_state,
    read_metadata,
    release,
    remove_metadata,
    write_metadata,
)

DOCKER = '/usr/bin/docker'
REMOTE_STATE = '/run/cauce-provider-login'


@contextlib.contextmanager
def runtime_guard(container_id: str):
    if not isinstance(container_id, str) or re.fullmatch(r'[0-9a-f]{64}', container_id) is None:
        raise LoginFailure('invalid guarded container identity')
    root = private_state('/tmp/cauce-provider-runtime-' + str(os.geteuid()), create=True)
    identity = str(uuid.uuid5(uuid.NAMESPACE_OID, container_id))
    try:
        lock = acquire(root, identity)
        try:
            yield
        finally:
            release(root, identity, lock)
    finally:
        os.close(root)


def reservation_root() -> int:
    return private_state('/tmp/cauce-provider-runtime-' + str(os.geteuid()), create=True)


def reserve_runtime(binding: dict, operation_id: str) -> None:
    with runtime_guard(binding['container_id']):
        observe(binding)
        root = reservation_root()
        try:
            saved = read_metadata(root, operation_id)
            if saved is not None and saved.get('container_id') != binding['container_id']:
                raise LoginFailure('login reservation belongs to another container')
            write_metadata(root, operation_id, {'schemaVersion': 1, 'operation_id': operation_id,
                                               'container_id': binding['container_id']})
        finally:
            os.close(root)


def assert_unreserved(container_id: str) -> None:
    root = reservation_root()
    try:
        for name in os.listdir(root):
            if name.endswith('.json'):
                saved = read_metadata(root, name[:-5])
                if saved is not None and saved.get('container_id') == container_id:
                    raise LoginFailure('provider login session is open; image refresh refused')
    finally:
        os.close(root)


def release_reservation(operation_id: str) -> None:
    try:
        root = private_state('/tmp/cauce-provider-runtime-' + str(os.geteuid()))
    except FileNotFoundError:
        return
    try:
        remove_metadata(root, operation_id)
    finally:
        os.close(root)


def validate_binding(binding) -> dict:
    fields = {'container_id', 'generation', 'image_digest', 'python', 'helper'}
    if not isinstance(binding, dict) or set(binding) != fields or not all(
            isinstance(binding[key], str) and re.fullmatch(r'[0-9a-f]{64}', binding[key])
            for key in ('container_id', 'generation')) or not isinstance(binding['image_digest'], str) \
            or re.fullmatch(r'sha256:[0-9a-f]{64}', binding['image_digest']) is None \
            or binding['helper'] != '/cauce/executor/provider-login.py':
        raise LoginFailure('invalid exact container login binding')
    canonical_path(binding['python'])
    return binding


def observe(binding: dict, *, absent: bool = False) -> bool:
    binding = validate_binding(binding)
    result = subprocess.run([DOCKER, 'inspect', binding['container_id']], capture_output=True, timeout=8,
        env={'PATH': '/usr/bin:/bin'})
    if result.returncode:
        listed = subprocess.run([DOCKER, 'ps', '-a', '--no-trunc', '--format', '{{.ID}}'],
            capture_output=True, timeout=8, env={'PATH': '/usr/bin:/bin'})
        if absent and listed.returncode == 0 and binding['container_id'] not in listed.stdout.decode().splitlines():
            return False
        raise LoginFailure('exact login container is unavailable')
    if len(result.stdout) > 65536:
        raise LoginFailure('container observation exceeds its limit')
    rows = json.loads(result.stdout)
    if not isinstance(rows, list) or len(rows) != 1:
        raise LoginFailure('container observation is ambiguous')
    observed = rows[0]
    generation = hashlib.sha256((observed['Id'] + '\0' + observed['State']['StartedAt']).encode()).hexdigest()
    if observed['Id'] != binding['container_id'] or observed['Image'] != binding['image_digest'] or generation != binding['generation']:
        raise LoginFailure('container login generation changed')
    if observed['State']['Running'] is not True:
        if absent and observed['State']['Pid'] == 0:
            return False
        raise LoginFailure('exact login container is not running')
    mounts = observed.get('Mounts', [])
    if not any(row.get('Destination') == '/cauce/executor' and row.get('Source') == str(pathlib.Path(__file__).resolve().parent)
               and row.get('RW') is False for row in mounts):
        raise LoginFailure('container login helper mount differs')
    return True


def command(binding: dict, *arguments: str) -> list[str]:
    return [DOCKER, 'exec', '-i', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1',
            binding['container_id'], binding['python'], binding['helper'], *arguments]


def remote_cleanup(binding: dict, identity: str) -> dict:
    if not observe(binding, absent=True):
        return {'stopped_verified': True}
    result = subprocess.run(command(binding, '--cleanup', identity, REMOTE_STATE),
        capture_output=True, timeout=12, env={'PATH': '/usr/bin:/bin'})
    if result.returncode or len(result.stdout) > 1024:
        raise LoginFailure('remote login stop was not observed')
    receipt = json.loads(result.stdout)
    if receipt != {'stopped_verified': True}:
        raise LoginFailure('remote login stop proof differs')
    return receipt


def cleanup_container(identity: str, state_root: str) -> dict:
    root = private_state(state_root)
    lock = None
    try:
        saved = read_metadata(root, identity)
        if saved is None:
            lock = acquire(root, identity, wait=6)
            release_reservation(identity)
            return {'stopped_verified': True}
        fields = {'schemaVersion', 'operation_id', 'account_scope', 'backend', 'expires_at',
                  'boot_id', 'controller', 'bridge', 'container_binding'}
        if set(saved) != fields or saved['backend'] != 'container' or saved['boot_id'] != boot_identity():
            raise LoginFailure('invalid saved container login identity')
        remote_cleanup(saved['container_binding'], identity)
        descriptor = pin_identity(saved['bridge'])
        if descriptor is not None:
            try:
                signal_pidfd(descriptor, signal.SIGTERM)
                deadline = time.monotonic() + 3
                while pidfd_running(descriptor) and time.monotonic() < deadline:
                    time.sleep(0.05)
                if pidfd_running(descriptor):
                    signal_pidfd(descriptor, signal.SIGKILL)
            finally:
                os.close(descriptor)
        lock = acquire(root, identity, wait=6)
        remove_metadata(root, identity)
        release_reservation(identity)
        return {'stopped_verified': True}
    finally:
        try:
            if lock is not None:
                release(root, identity, lock)
        finally:
            os.close(root)


def run_container(plan: dict) -> int:
    binding = validate_binding(plan.get('container_binding'))
    with runtime_guard(binding['container_id']):
        return run_guarded_container(plan, binding)


def run_guarded_container(plan: dict, binding: dict) -> int:
    observe(binding)
    root = private_state(plan['state_root'])
    try:
        lock = acquire(root, plan['operation_id'])
        try:
            return run_locked_container(plan, binding, root)
        finally:
            release(root, plan['operation_id'], lock)
    finally:
        os.close(root)


def run_locked_container(plan: dict, binding: dict, root: int) -> int:
    if read_metadata(root, plan['operation_id']) is not None:
        raise LoginFailure('container login operation requires cleanup before reuse')
    frames = Frames()
    child = subprocess.Popen(command(binding, '--container-child'), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'})
    descriptor = open_pidfd(child.pid)
    closing = False
    def close_signal(_signal, _frame):
        nonlocal closing
        closing = True
    for termination in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(termination, close_signal)
    saved = {'schemaVersion': 1, 'operation_id': plan['operation_id'], 'account_scope': plan['account_scope'],
        'backend': 'container', 'expires_at': int(time.time()) + plan['ttl_seconds'],
        'boot_id': boot_identity(),
        'controller': process_identity(os.getpid()), 'bridge': process_identity(child.pid), 'container_binding': binding}
    child_plan = {key: value for key, value in plan.items() if key != 'container_binding'}
    child_plan.update(backend='native', state_root=REMOTE_STATE)
    pending = bytearray(json.dumps(child_plan, separators=(',', ':')).encode() + b'\n')
    received = bytearray()
    proof = None
    failed = False
    deadline = time.monotonic() + plan['ttl_seconds'] + 5
    poller = selectors.DefaultSelector()
    os.set_blocking(child.stdout.fileno(), False)
    os.set_blocking(child.stdin.fileno(), False)
    poller.register(0, selectors.EVENT_READ, 'control')
    poller.register(child.stdout, selectors.EVENT_READ, 'remote')
    try:
        write_metadata(root, plan['operation_id'], saved)
        while proof is None and time.monotonic() < deadline:
            if closing:
                pending.extend(b'{"type":"close"}\n')
                closing = False
                deadline = min(deadline, time.monotonic() + 4)
            if pending:
                try:
                    del pending[:os.write(child.stdin.fileno(), pending)]
                except BlockingIOError:
                    pass
            frames.flush()
            for key, _events in poller.select(0.05):
                if key.data == 'control':
                    control = os.read(0, 8192)
                    if not control:
                        poller.unregister(0)
                        pending.extend(b'{"type":"close"}\n')
                        deadline = min(deadline, time.monotonic() + 4)
                    else:
                        pending.extend(control)
                        if len(pending) > 65536:
                            raise LoginFailure('container terminal controls exceed their limit')
                else:
                    output = os.read(child.stdout.fileno(), 65536)
                    if not output:
                        raise LoginFailure('container terminal ended without stop proof')
                    received.extend(output)
                    if len(received) > 131072:
                        raise LoginFailure('container terminal frame exceeds its limit')
                    while b'\n' in received:
                        line, _, remaining = received.partition(b'\n')
                        received = bytearray(remaining)
                        event = json.loads(line)
                        if not isinstance(event, dict) or event.get('type') not in {'started', 'output', 'exited'}:
                            raise LoginFailure('container terminal event differs')
                        if event['type'] == 'started':
                            if event.get('operation_id') != plan['operation_id']:
                                raise LoginFailure('container terminal operation differs')
                            event['backend'] = 'container'
                            event['container_id'] = binding['container_id']
                        if event['type'] == 'exited':
                            if event.get('operation_id') != plan['operation_id'] or event.get('stopped_verified') is not True:
                                raise LoginFailure('container terminal has no stop proof')
                            proof = event
                        else:
                            frames.emit(event)
    except Exception:
        failed = True
    finally:
        poller.close()
        child.stdin.close()
        try:
            remote_cleanup(binding, plan['operation_id'])
            if child.poll() is None:
                signal_pidfd(descriptor, signal.SIGTERM)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                signal_pidfd(descriptor, signal.SIGKILL)
                child.wait(timeout=3)
            remove_metadata(root, plan['operation_id'])
            if proof is None:
                proof = {'type': 'exited', 'operation_id': plan['operation_id'], 'exit_code': 2, 'stopped_verified': True}
            frames.emit(proof)
            frames.drain()
        finally:
            child.stdout.close()
            os.close(descriptor)
    return 2 if failed else 0
