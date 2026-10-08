from __future__ import annotations

import array
import json
import os
import pathlib
import secrets
import socket
import stat

from fleet_adoption_probe_docker import DockerLifecycleRetainer, recover_docker
from fleet_adoption_probe_lifecycle import LifecycleRetainer, recover_custody
from fleet_adoption_probe_policy import ProbeFailure, digest_file, private_parent
from fleet_adoption_probe_supervisor import packet, peer, receive


def process_starttime(pid: int) -> int:
    raw = pathlib.Path(f'/proc/{pid}/stat').read_text()
    return int(raw[raw.rfind(')') + 2:].split()[19])


class SupervisorFence:
    def __init__(self, row: dict, session_nonce: str | None = None):
        self.row = row
        self.session_nonce = session_nonce or secrets.token_hex(32)
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.connection.settimeout(40)
        self.descriptors: list[int] = []
        self.pidfd = None
        self.pid = None
        self.starttime = None
        self.socket_identity = None
        self.acquired = False
        self.native_retainer = None
        self.docker_retainer = None

    def acquire(self) -> None:
        filename = self.row['supervisor']['socket']
        parent = private_parent(filename)
        try:
            details = os.stat(os.path.basename(filename), dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISSOCK(details.st_mode) or details.st_uid != os.geteuid() or details.st_mode & 0o077:
                raise ProbeFailure('cooperative_supervisor_unavailable')
            self.socket_identity = (details.st_dev, details.st_ino)
        finally:
            os.close(parent)
        if digest_file(self.row['supervisor']['command']) != self.row['supervisor']['command_sha256']:
            raise ProbeFailure('supervisor_command_changed')
        self.connection.connect(filename)
        self.pid, uid, _ = peer(self.connection)
        if uid != os.geteuid():
            raise ProbeFailure('supervisor_owner_changed')
        self.starttime = process_starttime(self.pid)
        self.pidfd = os.pidfd_open(self.pid)
        packet(self.connection, {'action': 'acquire', 'target': self.row['target'], 'session_nonce': self.session_nonce})
        payload, ancillary, flags, _ = self.connection.recvmsg(8192, socket.CMSG_SPACE(2 * array.array('i').itemsize))
        for level, kind, encoded in ancillary:
            if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                received = array.array('i')
                received.frombytes(encoded[:len(encoded) - len(encoded) % received.itemsize])
                for fd in received:
                    os.set_inheritable(fd, False)
                self.descriptors.extend(received)
        reply = json.loads(payload)
        if flags or reply.get('ok') is not True or len(self.descriptors) != 2 \
                or reply.get('runtime_key') != self.row['runtime_key'] \
                or reply.get('command_sha256') != self.row['supervisor']['command_sha256']:
            raise ProbeFailure('cooperative_fence_unavailable')
        self.acquired = True
        self.validate_descriptors()
        if self.row['observation']['transport'] == 'docker':
            self.docker_retainer = DockerLifecycleRetainer(self.row, reply.get('lifecycle'), self.session_nonce)
            self.docker_retainer.acquire()
        else:
            lifecycle = reply.get('lifecycle')
            if not isinstance(lifecycle, dict) or not isinstance(lifecycle.get('lifecycle_identity'), dict):
                raise ProbeFailure('lifecycle_fence_unavailable')
            self.native_retainer = LifecycleRetainer(self.row, lifecycle['lifecycle_identity'], self.session_nonce)
            self.native_retainer.acquire()
        self.assert_held()

    @property
    def lifecycle_descriptors(self) -> list[int]:
        return [] if self.native_retainer is None else self.native_retainer.descriptors

    def validate_descriptors(self) -> None:
        expected = {f"{self.row['runtime_key']}.lock", f"cauce-v3-container-{self.row['runtime_key']}.lock"}
        actual = set()
        for fd in self.descriptors:
            filename = os.readlink(f'/proc/self/fd/{fd}')
            details, named = os.fstat(fd), os.stat(filename, follow_symlinks=False)
            fdinfo = pathlib.Path(f'/proc/self/fdinfo/{fd}').read_text()
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 \
                    or stat.S_IMODE(details.st_mode) != 0o600 or (details.st_dev, details.st_ino) != (named.st_dev, named.st_ino) \
                    or 'FLOCK' not in fdinfo or 'WRITE' not in fdinfo:
                raise ProbeFailure('supervisor_lock_changed')
            actual.add(os.path.basename(filename))
        if actual != expected:
            raise ProbeFailure('supervisor_lock_scope_changed')

    def invoke(self, action: str) -> dict:
        packet(self.connection, {'action': action, 'target': self.row['target'], 'session_nonce': self.session_nonce})
        reply = receive(self.connection)
        if not reply or reply.get('ok') is not True:
            raise ProbeFailure('supervisor_fence_lost')
        return reply

    def assert_held(self) -> None:
        if digest_file(self.row['supervisor']['command']) != self.row['supervisor']['command_sha256']:
            raise ProbeFailure('supervisor_command_changed')
        if not self.acquired or self.pid is None or process_starttime(self.pid) != self.starttime:
            raise ProbeFailure('supervisor_fence_lost')
        details = os.stat(self.row['supervisor']['socket'], follow_symlinks=False)
        if (details.st_dev, details.st_ino) != self.socket_identity:
            raise ProbeFailure('supervisor_socket_changed')
        self.validate_descriptors()
        if self.docker_retainer is not None:
            self.docker_retainer.assert_held()
        elif self.native_retainer is not None:
            self.native_retainer.assert_held()
        else:
            raise ProbeFailure('lifecycle_fence_lost')
        self.invoke('assert')

    def measure(self) -> dict:
        self.assert_held()
        return self.invoke('measure')['facts']

    def close(self) -> None:
        try:
            for retainer in (self.native_retainer, self.docker_retainer):
                if retainer is not None:
                    retainer.close()
            self.native_retainer = None
            self.docker_retainer = None
            if self.acquired:
                try:
                    self.invoke('release')
                except (ProbeFailure, OSError, ValueError):
                    pass
        finally:
            self.abandon()

    def abandon(self) -> None:
        for retainer in (self.native_retainer, self.docker_retainer):
            if retainer is not None:
                retainer.abandon()
        self.native_retainer = None
        self.docker_retainer = None
        if self.connection.fileno() >= 0:
            self.connection.close()
        for fd in self.descriptors:
            os.close(fd)
        self.descriptors.clear()
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None
        self.acquired = False


def recover_fence(row: dict, session_nonce: str) -> None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
        connection.settimeout(40)
        connection.connect(row['supervisor']['socket'])
        if peer(connection)[1] != os.geteuid():
            raise ProbeFailure('supervisor_owner_changed')
        packet(connection, {'action': 'recover', 'target': row['target'], 'session_nonce': session_nonce})
        reply = receive(connection)
        if not reply or reply.get('ok') is not True:
            raise ProbeFailure('supervisor_recovery_unavailable')
        if reply.get('released') is True:
            return
        if row['observation']['transport'] == 'docker':
            recover_docker(row, session_nonce, reply['lifecycle']['lifecycle_identity'])
        else:
            recover_custody(row, session_nonce, reply['lifecycle']['lifecycle_identity'])
        packet(connection, {'action': 'release', 'target': row['target'], 'session_nonce': session_nonce})
        reply = receive(connection)
        if not reply or reply.get('ok') is not True:
            raise ProbeFailure('supervisor_recovery_unavailable')
