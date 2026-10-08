from __future__ import annotations

import array
import json
import os
import pwd
import secrets
import selectors
import signal
import socket
import stat
import struct
import subprocess

from fleet_adoption_probe_measure import observe, public_facts
from fleet_adoption_probe_policy import ProbeFailure, digest_file, load_policy, private_parent


def packet(connection: socket.socket, value: dict, descriptors=()) -> None:
    payload = json.dumps(value, separators=(',', ':')).encode()
    ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', descriptors))] if descriptors else []
    connection.sendmsg([payload], ancillary)


def receive(connection: socket.socket) -> dict | None:
    payload = connection.recv(8193)
    if not payload:
        return None
    if len(payload) > 8192:
        raise ProbeFailure('packet_exceeds_limit')
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ProbeFailure('invalid_packet')
    return value


def peer(connection: socket.socket) -> tuple[int, int, int]:
    return struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))


def run_supervised(descriptors: tuple[int, int], command: list[str], environment: dict, policy_file: str, alias: str) -> int:
    policy = load_policy(policy_file)
    rows = [row for row in policy['targets'] if row['runtime_key'] == alias]
    if len(rows) != 1:
        raise ProbeFailure('supervisor_target_ambiguous')
    row = rows[0]
    systemd_user = row['placement'].get('systemd_user', 'stev')
    if pwd.getpwnam(systemd_user).pw_uid != os.geteuid():
        raise ProbeFailure('supervisor_execution_user_changed')
    if command != [row['supervisor']['command'], 'start', alias] \
            or digest_file(command[0]) != row['supervisor']['command_sha256']:
        raise ProbeFailure('supervisor_command_changed')
    filename = row['supervisor']['socket']
    parent = private_parent(filename)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    selector = selectors.DefaultSelector()
    clients: dict[socket.socket, dict] = {}
    adoptions: dict[str, dict] = {}
    recovered: dict[str, None] = {}
    child = None
    stop_requested = False
    socket_identity = None
    previous_handlers = {}

    def request_stop(_signum, _frame):
        nonlocal stop_requested
        stop_requested = True

    def close_client(connection):
        clients.pop(connection, None)
        selector.unregister(connection)
        connection.close()

    def adoption_active() -> bool:
        return bool(adoptions)

    try:
        listener.bind(filename)
        os.chmod(filename, 0o600)
        socket_identity = os.stat(filename, follow_symlinks=False)
        listener.listen(16)
        selector.register(listener, selectors.EVENT_READ)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous_handlers[signum] = signal.signal(signum, request_stop)
        child = subprocess.Popen(command, env=environment, pass_fds=descriptors)
        while child.poll() is None or any(value.get('role') for value in clients.values()) or adoption_active():
            if stop_requested and not any(value.get('role') for value in clients.values()) and not adoption_active() and child.poll() is None:
                child.terminate()
                stop_requested = False
            for pending, lease in list(clients.items()):
                if lease.get('role') == 'pending-control' and not adoption_active() and not any(value.get('role') == 'control' for value in clients.values()):
                    lease['role'] = 'control'
                    try:
                        packet(pending, {'ok': True})
                    except OSError:
                        close_client(pending)
            for key, _ in selector.select(0.1):
                connection = key.fileobj
                if connection is listener:
                    connected, _ = listener.accept()
                    if peer(connected)[1] != os.geteuid():
                        connected.close()
                        continue
                    clients[connected] = {}
                    selector.register(connected, selectors.EVENT_READ)
                    continue
                try:
                    message = receive(connection)
                    if message is None:
                        close_client(connection)
                        continue
                    action = message.get('action')
                    adoption_request = action in {'acquire', 'recover', 'assert', 'measure', 'release'}
                    fields = {'action', 'target', 'session_nonce'} if adoption_request else {'action', 'target'}
                    nonce = message.get('session_nonce')
                    if set(message) != fields or message['target'] != row['target'] or (adoption_request and
                            (not isinstance(nonce, str) or len(nonce) != 64 or any(char not in '0123456789abcdef' for char in nonce))):
                        raise ProbeFailure('socket_scope_changed')
                    lease = clients[connection]
                    if action == 'acquire':
                        if lease or adoption_active() or any(item.get('role') for item in clients.values()) or stop_requested or child.poll() is not None:
                            raise ProbeFailure('supervisor_busy')
                        measured = observe(row)
                        lease.update(role='adoption', identity=measured['physical_identity_sha256'], nonce=nonce,
                                     lifecycle={key: measured[key] for key in ('lifecycle_identity', 'container', 'physical_identity_sha256') if key in measured})
                        adoptions[nonce] = lease
                        packet(connection, {'ok': True, 'runtime_key': alias, 'command_sha256': row['supervisor']['command_sha256'],
                                            'identity': lease['identity'], 'lifecycle': lease['lifecycle']}, descriptors)
                    elif action == 'recover':
                        if nonce in recovered:
                            packet(connection, {'ok': True, 'released': True})
                            continue
                        original = adoptions.get(nonce)
                        if lease or original is None or any(value is original for value in clients.values()):
                            raise ProbeFailure('supervisor_recovery_unavailable')
                        clients[connection] = original
                        packet(connection, {'ok': True, 'lifecycle': original['lifecycle']})
                    elif action == 'control':
                        if lease or any(value.get('role') in {'control', 'pending-control'} for value in clients.values()):
                            raise ProbeFailure('supervisor_fenced')
                        if adoption_active():
                            lease['role'] = 'pending-control'
                        else:
                            lease['role'] = 'control'
                            packet(connection, {'ok': True})
                    elif action == 'control-assert':
                        if lease.get('role') != 'control' or adoption_active():
                            raise ProbeFailure('control_lease_lost')
                        packet(connection, {'ok': True})
                    elif action in {'assert', 'measure'}:
                        if lease.get('role') != 'adoption' or not secrets.compare_digest(lease.get('nonce', ''), nonce) or child.poll() is not None:
                            raise ProbeFailure('supervisor_fence_lost')
                        measured = observe(row)
                        if measured['physical_identity_sha256'] != lease['identity']:
                            raise ProbeFailure('physical_identity_changed')
                        packet(connection, {'ok': True, **({'facts': public_facts(row, measured)} if action == 'measure' else {})})
                    elif action == 'release':
                        if lease.get('role') != 'adoption' or not secrets.compare_digest(lease.get('nonce', ''), nonce):
                            raise ProbeFailure('supervisor_recovery_unavailable')
                        adoptions.pop(nonce)
                        recovered[nonce] = None
                        if len(recovered) > 256:
                            recovered.pop(next(iter(recovered)))
                        packet(connection, {'ok': True})
                        close_client(connection)
                    else:
                        raise ProbeFailure('unsupported_socket_action')
                except (ProbeFailure, OSError, ValueError) as error:
                    try:
                        packet(connection, {'ok': False, 'code': str(error) if isinstance(error, ProbeFailure) else 'socket_unavailable'})
                    except OSError:
                        close_client(connection)
        return child.wait()
    finally:
        for connection in list(clients):
            close_client(connection)
        selector.close()
        listener.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        if socket_identity is not None:
            try:
                named = os.stat(os.path.basename(filename), dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                named = None
            if named is not None and stat.S_ISSOCK(named.st_mode) and (named.st_dev, named.st_ino) == (socket_identity.st_dev, socket_identity.st_ino):
                os.unlink(os.path.basename(filename), dir_fd=parent)
        os.close(parent)


def controlled(socket_path: str, target: dict, command: list[str]) -> int:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    connection.connect(socket_path)
    try:
        if peer(connection)[1] != os.geteuid():
            raise ProbeFailure('supervisor_owner_changed')
        packet(connection, {'action': 'control', 'target': target})
        reply = receive(connection)
        if not reply or reply.get('ok') is not True:
            raise ProbeFailure('supervisor_fenced')
        environment = dict(os.environ, CAUCE_ADOPTION_CONTROL_FD=str(connection.fileno()))
        child = subprocess.Popen(command, env=environment, pass_fds=(connection.fileno(),))
        return child.wait()
    finally:
        connection.close()


def verify_control(fd: int, socket_path: str, target: dict) -> None:
    connection = socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        if connection.getpeername() != socket_path or peer(connection)[1] != os.geteuid():
            raise ProbeFailure('control_scope_changed')
        packet(connection, {'action': 'control-assert', 'target': target})
        reply = receive(connection)
        if not reply or reply.get('ok') is not True:
            raise ProbeFailure('control_lease_lost')
    finally:
        connection.close()
