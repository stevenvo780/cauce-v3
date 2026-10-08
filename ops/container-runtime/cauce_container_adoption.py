from __future__ import annotations

import array
import fcntl
import json
import os
import selectors
import socket
import stat
import struct

from cauce_container_base import PermanentError

GUARD = 'cauce-v3-adoption.guard'
SOCKET = 'cauce-v3-adoption.sock'


def open_guard(control: int) -> int:
    fd = os.open(GUARD, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=control)
    details = os.fstat(fd)
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() \
            or stat.S_IMODE(details.st_mode) != 0o600 or details.st_nlink != 1:
        os.close(fd)
        raise PermanentError('adoption guard is unsafe')
    return fd


def mutation_guard(control: int) -> int:
    fd = open_guard(control)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        return fd
    except BlockingIOError as error:
        os.close(fd)
        raise PermanentError('adoption holds the lifecycle fence; no mutation was made') from error


class LifecycleAdoptionServer:
    def __init__(self, control: int, directory: str, lifecycle: int, identity: dict):
        self.control, self.lifecycle, self.identity = control, lifecycle, identity
        self.path = directory + '/' + SOCKET
        self.clients: dict[socket.socket, int | None] = {}
        self.orphans: dict[str, int] = {}
        self.nonces: dict[socket.socket, str] = {}
        self.released: dict[str, None] = {}
        self.selector = selectors.DefaultSelector()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        try:
            stale = os.stat(SOCKET, dir_fd=control, follow_symlinks=False)
        except FileNotFoundError:
            stale = None
        if stale is not None:
            if not stat.S_ISSOCK(stale.st_mode) or stale.st_uid != os.geteuid() or stat.S_IMODE(stale.st_mode) != 0o600:
                raise PermanentError('stale adoption socket is unsafe')
            os.unlink(SOCKET, dir_fd=control)
        self.listener.bind(self.path)
        os.chmod(self.path, 0o600)
        self.socket_identity = os.stat(SOCKET, dir_fd=control, follow_symlinks=False)
        self.listener.listen(4)
        self.selector.register(self.listener, selectors.EVENT_READ)

    @property
    def fenced(self) -> bool:
        return bool(self.orphans) or any(fd is not None for fd in self.clients.values())

    def close_client(self, client: socket.socket, released: bool = False) -> None:
        guard = self.clients.pop(client)
        nonce = self.nonces.pop(client, None)
        self.selector.unregister(client)
        client.close()
        if guard is not None:
            if released:
                os.close(guard)
                self.record_release(nonce)
            elif nonce is not None:
                self.orphans[nonce] = guard

    def record_release(self, nonce: str) -> None:
        self.released[nonce] = None
        if len(self.released) > 256:
            self.released.pop(next(iter(self.released)))

    def poll(self, timeout: float = 0) -> None:
        for key, _ in self.selector.select(timeout):
            client = key.fileobj
            if client is self.listener:
                client, _ = self.listener.accept()
                _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != os.geteuid():
                    client.close()
                    continue
                self.clients[client] = None
                self.selector.register(client, selectors.EVENT_READ)
                continue
            try:
                raw = client.recv(8193)
                if not raw:
                    self.close_client(client)
                    continue
                request = json.loads(raw)
                if len(raw) > 8192 or not isinstance(request, dict) or set(request) != {'action', 'identity', 'session_nonce'} \
                        or request['identity'] != self.identity or not isinstance(request['session_nonce'], str) \
                        or len(request['session_nonce']) != 64 or any(char not in '0123456789abcdef' for char in request['session_nonce']):
                    raise PermanentError('lifecycle adoption scope changed')
                descriptors = ()
                if request['action'] == 'acquire':
                    if self.clients[client] is not None or self.fenced:
                        raise PermanentError('lifecycle is already fenced')
                    guard = open_guard(self.control)
                    try:
                        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BaseException:
                        os.close(guard)
                        raise
                    self.clients[client] = guard
                    self.nonces[client] = request['session_nonce']
                    descriptors = (self.lifecycle, guard)
                elif request['action'] in {'assert', 'release'}:
                    if self.clients[client] is None or self.nonces.get(client) != request['session_nonce']:
                        raise PermanentError('lifecycle adoption lease is absent')
                elif request['action'] == 'recover':
                    guard = self.orphans.pop(request['session_nonce'], None)
                    if guard is None and request['session_nonce'] not in self.released:
                        raise PermanentError('lifecycle adoption lease is absent')
                    if guard is not None:
                        os.close(guard)
                        self.record_release(request['session_nonce'])
                else:
                    raise PermanentError('invalid lifecycle adoption action')
                payload = json.dumps({'ok': True, 'identity': self.identity}).encode()
                ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', descriptors))] if descriptors else []
                client.sendmsg([payload], ancillary)
                if request['action'] == 'release':
                    self.close_client(client, released=True)
            except (OSError, ValueError, PermanentError):
                try:
                    client.send(json.dumps({'ok': False}).encode())
                except OSError:
                    self.close_client(client)

    def close(self) -> None:
        while self.fenced:
            self.poll(0.1)
        for client in list(self.clients):
            self.close_client(client)
        self.selector.close()
        self.listener.close()
        try:
            named = os.stat(SOCKET, dir_fd=self.control, follow_symlinks=False)
            if (named.st_dev, named.st_ino) == (self.socket_identity.st_dev, self.socket_identity.st_ino):
                os.unlink(SOCKET, dir_fd=self.control)
        except FileNotFoundError:
            pass
