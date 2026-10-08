from __future__ import annotations

import array
import json
import os
import pathlib
import secrets
import socket
import stat
import struct


def recover_custody(row: dict, session_nonce: str, identity: dict | None = None) -> None:
    path = row['observation']['control_directory'] + '/cauce-v3-adoption-custody.sock'
    stale_identity = None
    try:
        details = os.stat(path, follow_symlinks=False)
        return release_custody(path, details, session_nonce)
    except ConnectionRefusedError:
        stale_identity = (details.st_dev, details.st_ino)
        if identity is None:
            raise
    except FileNotFoundError:
        if identity is None:
            raise
    path = row['observation']['control_directory'] + '/cauce-v3-adoption.sock'
    details = os.stat(path, follow_symlinks=False)
    if not stat.S_ISSOCK(details.st_mode) or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600:
        raise ValueError('lifecycle_socket_unsafe')
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
        connection.settimeout(40)
        connection.connect(path)
        pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.geteuid() or pid != identity['controllerPid']:
            raise ValueError('lifecycle_controller_changed')
        connection.send(json.dumps({'action': 'recover', 'session_nonce': session_nonce, 'identity': identity}).encode())
        if json.loads(connection.recv(8192)).get('ok') is not True:
            raise ValueError('lifecycle_custody_release_failed')
    if stale_identity is not None:
        path = row['observation']['control_directory'] + '/cauce-v3-adoption-custody.sock'
        named = os.stat(path, follow_symlinks=False)
        if (named.st_dev, named.st_ino) == stale_identity:
            os.unlink(path)


def release_custody(path: str, details: os.stat_result, session_nonce: str) -> None:
    if not stat.S_ISSOCK(details.st_mode) or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600:
        raise ValueError('lifecycle_custody_socket_unsafe')
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
        connection.settimeout(40)
        connection.connect(path)
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.geteuid():
            raise ValueError('lifecycle_custody_owner_changed')
        connection.send(json.dumps({'action': 'release', 'session_nonce': session_nonce}).encode())
        if json.loads(connection.recv(8192)).get('ok') is not True:
            raise ValueError('lifecycle_custody_release_failed')


class LifecycleRetainer:
    def __init__(self, row: dict, identity: dict, session_nonce: str):
        self.row, self.identity = row, identity
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.connection.settimeout(40)
        self.descriptors: list[int] = []
        self.directory = row['observation']['control_directory']
        self.path = self.directory + '/cauce-v3-adoption.sock'
        self.session_nonce = session_nonce
        self.custody = False

    def send(self, action: str) -> None:
        self.connection.send(json.dumps({'action': action, 'identity': self.identity, 'session_nonce': self.session_nonce}).encode())

    def acquire(self) -> None:
        details = os.stat(self.path, follow_symlinks=False)
        if not stat.S_ISSOCK(details.st_mode) or details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o600:
            raise ValueError('lifecycle_socket_unsafe')
        self.socket_identity = (details.st_dev, details.st_ino)
        self.connection.connect(self.path)
        pid, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if pid != self.identity['controllerPid'] or uid != os.geteuid():
            raise ValueError('lifecycle_controller_changed')
        self.send('acquire')
        payload, ancillary, flags, _ = self.connection.recvmsg(8192, socket.CMSG_SPACE(2 * array.array('i').itemsize))
        for level, kind, encoded in ancillary:
            if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                received = array.array('i')
                received.frombytes(encoded[:len(encoded) - len(encoded) % received.itemsize])
                for fd in received:
                    os.set_inheritable(fd, False)
                self.descriptors.extend(received)
        reply = json.loads(payload)
        if flags or reply.get('ok') is not True or reply.get('identity') != self.identity or len(self.descriptors) != 2:
            raise ValueError('lifecycle_descriptors_unavailable')
        self.start_custody()
        self.assert_held()

    def start_custody(self) -> None:
        path = self.directory + '/cauce-v3-adoption-custody.sock'
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        listener.bind(path)
        os.chmod(path, 0o600)
        identity = os.stat(path, follow_symlinks=False)
        listener.listen(4)
        readiness, ready = socket.socketpair()
        pid = os.fork()
        if pid == 0:
            keep = {listener.fileno(), ready.fileno(), self.connection.fileno(), *self.descriptors}
            for name in os.listdir('/proc/self/fd'):
                if int(name) not in keep:
                    try:
                        os.close(int(name))
                    except OSError:
                        pass
            ready.send(b'1')
            ready.close()
            self.serve_custody(listener, path, (identity.st_dev, identity.st_ino))
            os._exit(0)
        ready.close()
        listener.close()
        if readiness.recv(1) != b'1':
            raise ValueError('lifecycle_custody_unavailable')
        readiness.close()
        self.custody = True
        self.custody_pid = pid

    def serve_custody(self, listener: socket.socket, path: str, identity: tuple[int, int]) -> None:
        while True:
            client, _ = listener.accept()
            with client:
                try:
                    client.settimeout(5)
                    _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    request = json.loads(client.recv(8193))
                    nonce = request.get('session_nonce') if isinstance(request, dict) else None
                    if uid != os.geteuid() or not isinstance(nonce, str) or not secrets.compare_digest(nonce, self.session_nonce) \
                            or set(request) != {'action', 'session_nonce'} or request['action'] != 'release':
                        client.send(b'{"ok":false}')
                        continue
                    try:
                        self.send('release')
                        self.connection.recv(8192)
                    except (OSError, ValueError):
                        pass
                    self.abandon()
                    try:
                        named = os.stat(path, follow_symlinks=False)
                        if (named.st_dev, named.st_ino) == identity:
                            os.unlink(path)
                    except FileNotFoundError:
                        pass
                    client.send(b'{"ok":true}')
                    return
                except (OSError, ValueError):
                    continue

    def assert_held(self) -> None:
        if len(self.descriptors) != 2:
            raise ValueError('lifecycle_fence_lost')
        for fd, name in zip(self.descriptors, ('cauce-v3-adapter.lock', 'cauce-v3-adoption.guard'), strict=True):
            details = os.fstat(fd)
            named = os.stat(self.directory + '/' + name, follow_symlinks=False)
            locks = pathlib.Path(f'/proc/self/fdinfo/{fd}').read_text()
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 \
                    or stat.S_IMODE(details.st_mode) != 0o600 or (details.st_dev, details.st_ino) != (named.st_dev, named.st_ino) \
                    or 'FLOCK' not in locks or 'WRITE' not in locks:
                raise ValueError('lifecycle_lock_changed')
        details = os.stat(self.path, follow_symlinks=False)
        if (details.st_dev, details.st_ino) != self.socket_identity:
            raise ValueError('lifecycle_socket_changed')
        raw = pathlib.Path(f"/proc/{self.identity['controllerPid']}/stat").read_text()
        if int(raw[raw.rfind(')') + 2:].split()[19]) != self.identity['controllerStarttime']:
            raise ValueError('lifecycle_controller_lost')
        self.send('assert')
        reply = json.loads(self.connection.recv(8192))
        if reply.get('ok') is not True or reply.get('identity') != self.identity:
            raise ValueError('lifecycle_fence_lost')

    def close(self) -> None:
        try:
            if self.custody:
                recover_custody(self.row, self.session_nonce, self.identity)
                os.waitpid(self.custody_pid, 0)
            elif self.descriptors:
                try:
                    self.send('release')
                    self.connection.recv(8192)
                except (OSError, ValueError):
                    pass
        finally:
            self.abandon()

    def abandon(self) -> None:
        self.connection.close()
        for fd in self.descriptors:
            os.close(fd)
        self.descriptors.clear()
