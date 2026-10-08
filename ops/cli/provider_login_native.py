from __future__ import annotations

import base64
import errno
import fcntl
import json
import os
import pathlib
import pwd
import resource
import selectors
import signal
import struct
import sys
import termios
import time

from fleet_executor_view import open_directory
from provider_login_state import (
    LoginFailure,
    acquire,
    canonical_path,
    pinned_digest,
    private_state,
    read_metadata,
    remove_metadata,
    write_metadata,
)

LIFECYCLE = pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'
sys.path.insert(0, str(LIFECYCLE if LIFECYCLE.is_dir() else pathlib.Path('/cauce/lifecycle')))
from cauce_container_proc import (  # noqa: E402
    descendants,
    open_pidfd,
    pidfd_matches_starttime,
    pidfd_running,
    proc_stat,
    process_credentials,
    set_subreaper,
    signal_pidfd,
)
from cauce_container_tree import PinnedLeaderTree  # noqa: E402


def process_identity(pid: int) -> dict:
    return {'pid': pid, 'start_ticks': proc_stat(pid)['starttime']}


def boot_identity() -> str:
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def refresh_owned_children(tree: PinnedLeaderTree):
    tree.refresh()
    owned = set(descendants(os.getpid()))
    for pid in owned - set(tree.pinned):
        descriptor = None
        try:
            descriptor = open_pidfd(pid)
            ticks = proc_stat(pid)['starttime']
            if pid in descendants(os.getpid()) and pidfd_matches_starttime(pid, descriptor, ticks):
                tree.pinned[pid] = (descriptor, ticks)
                descriptor = None
        except ProcessLookupError:
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)


def stop_owned_children(tree: PinnedLeaderTree):
    for termination, seconds in ((signal.SIGTERM, 0.8), (signal.SIGKILL, 3)):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            refresh_owned_children(tree)
            if not tree.pinned:
                return
            for _pid, (descriptor, _ticks) in list(tree.pinned.items()):
                if pidfd_running(descriptor):
                    signal_pidfd(descriptor, termination)
            time.sleep(0.05)
    refresh_owned_children(tree)
    if tree.pinned:
        raise LoginFailure('owned login descendants were not observed stopped')


def pin_identity(identity: dict) -> int | None:
    if not isinstance(identity, dict) or set(identity) != {'pid', 'start_ticks'} \
            or type(identity['pid']) is not int or identity['pid'] <= 1 or type(identity['start_ticks']) is not int \
            or identity['start_ticks'] <= 0:
        raise LoginFailure('invalid saved process identity')
    try:
        descriptor = open_pidfd(identity['pid'])
    except ProcessLookupError:
        return None
    if not pidfd_running(descriptor):
        os.close(descriptor)
        return None
    if not pidfd_matches_starttime(identity['pid'], descriptor, identity['start_ticks']):
        os.close(descriptor)
        raise LoginFailure('saved process identity changed')
    return descriptor


class Frames:
    def __init__(self):
        self.output = bytearray()
        self.controls = bytearray()
        self.input = bytearray()
        os.set_blocking(1, False)

    def emit(self, item: dict):
        self.output.extend(json.dumps(item, separators=(',', ':')).encode() + b'\n')
        if len(self.output) > 262144:
            raise LoginFailure('terminal output consumer is unavailable')
        self.flush()

    def flush(self):
        try:
            if self.output:
                del self.output[:os.write(1, self.output)]
        except BlockingIOError:
            pass

    def drain(self):
        deadline = time.monotonic() + 2
        while self.output and time.monotonic() < deadline:
            try:
                self.flush()
            except BrokenPipeError:
                return
            time.sleep(0.01)

    def drain_pty(self, master: int):
        remaining = 65536
        while remaining:
            try:
                data = os.read(master, min(16384, remaining))
            except BlockingIOError:
                return
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            remaining -= len(data)
            self.emit({'type': 'output', 'data': base64.b64encode(data).decode()})
        raise LoginFailure('terminal close output exceeds its limit')

    def read(self, master: int) -> bool:
        data = os.read(0, 8192)
        if not data:
            return False
        self.controls.extend(data)
        if len(self.controls) > 65536:
            raise LoginFailure('terminal control exceeds its limit')
        while b'\n' in self.controls:
            line, _, remaining = self.controls.partition(b'\n')
            self.controls = bytearray(remaining)
            frame = json.loads(line)
            if not isinstance(frame, dict):
                raise LoginFailure('invalid terminal control')
            if frame.get('type') == 'close' and set(frame) == {'type'}:
                return False
            if frame.get('type') == 'input' and set(frame) == {'type', 'data'} and isinstance(frame['data'], str):
                decoded = base64.b64decode(frame['data'], validate=True)
                if len(decoded) > 8192 or len(self.input) + len(decoded) > 65536:
                    raise LoginFailure('terminal input exceeds its limit')
                self.input.extend(decoded)
            elif frame.get('type') == 'resize' and set(frame) == {'type', 'rows', 'cols'} and all(
                    type(frame[key]) is int and 1 <= frame[key] <= 500 for key in ('rows', 'cols')):
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', frame['rows'], frame['cols'], 0, 0))
            else:
                raise LoginFailure('invalid terminal control')
        return True


def validate_native_home(plan: dict, user):
    passwd_home = pathlib.Path(canonical_path(user.pw_dir))
    home = pathlib.Path(canonical_path(plan['home']))
    cwd = pathlib.Path(canonical_path(plan['cwd']))
    if not home.is_relative_to(passwd_home) or not cwd.is_relative_to(home):
        raise LoginFailure('native login home or cwd escapes its owner boundary')
    directory = open_directory(passwd_home)
    try:
        for component in (None, *cwd.relative_to(passwd_home).parts):
            if component is not None:
                following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=directory)
                os.close(directory)
                directory = following
            details = os.fstat(directory)
            if details.st_uid != user.pw_uid or details.st_mode & 0o022:
                raise LoginFailure('native login directory has an unsafe owner or mode')
    finally:
        os.close(directory)


def native_user(plan: dict, *, child: bool = False):
    user = pwd.getpwnam(plan['runtime_user'])
    if os.geteuid() not in {0, user.pw_uid}:
        raise LoginFailure('exact login user differs')
    if child:
        if user.pw_dir != plan['home']:
            raise LoginFailure('exact container login home differs')
        directory = open_directory(pathlib.Path(plan['cwd']))
        os.close(directory)
    else:
        validate_native_home(plan, user)
    if plan.get('command_sha256') is not None and pinned_digest(plan['command'][0]) != plan['command_sha256']:
        raise LoginFailure('pinned login executable changed')
    for filename, fingerprint in plan.get('command_files', {}).items():
        if pinned_digest(filename) != fingerprint:
            raise LoginFailure('pinned login argument file changed')
    return user


def run_guardian(plan: dict, user, root: int, lock: int, controller: dict) -> int:
    set_subreaper()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    parent_fd = pin_identity(controller)
    if parent_fd is None:
        raise LoginFailure('login controller identity is unavailable')
    closing = False
    def close_signal(_signal, _frame):
        nonlocal closing
        closing = True
    for termination in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(termination, close_signal)
    ready_read, ready_write = os.pipe2(os.O_CLOEXEC)
    pid, master = os.forkpty()
    if pid == 0:
        try:
            os.close(ready_write)
            os.close(root)
            os.close(lock)
            os.close(parent_fd)
            if os.read(ready_read, 1) != b'1':
                os._exit(125)
            os.close(ready_read)
            for termination in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(termination, signal.SIG_DFL)
            if os.geteuid() == 0:
                os.initgroups(user.pw_name, user.pw_gid)
                os.setgid(user.pw_gid)
                os.setuid(user.pw_uid)
            if os.getuid() != user.pw_uid or os.getgid() != user.pw_gid:
                os._exit(125)
            os.chdir(plan['cwd'])
            os.execve(plan['command'][0], plan['command'], {**plan['env'], 'HOME': plan['home'],
                'USER': user.pw_name, 'LOGNAME': user.pw_name, 'TERM': 'xterm-256color'})
        except BaseException:
            os._exit(125)
    os.close(ready_read)
    tree = PinnedLeaderTree(pid)
    metadata = {'schemaVersion': 1, 'operation_id': plan['operation_id'], 'account_scope': plan['account_scope'],
        'backend': 'native', 'runtime_uid': user.pw_uid, 'controller': controller, 'guardian': process_identity(os.getpid()),
        'expires_at': int(time.time()) + plan['ttl_seconds'], 'boot_id': boot_identity(), 'processes': []}
    frames = Frames()
    deadline = time.monotonic() + plan['ttl_seconds']
    status = None
    protocol_failed = False
    previous_processes = None
    poller = selectors.DefaultSelector()
    poller.register(0, selectors.EVENT_READ, 'control')
    poller.register(master, selectors.EVENT_READ, 'pty')
    poller.register(parent_fd, selectors.EVENT_READ, 'parent')
    os.set_blocking(master, False)
    try:
        metadata['processes'] = [process_identity(pid)]
        write_metadata(root, plan['operation_id'], metadata)
        os.write(ready_write, b'1')
        os.close(ready_write)
        ready_write = None
        exec_deadline = time.monotonic() + 3
        while time.monotonic() < exec_deadline:
            try:
                with open(f'/proc/{pid}/cmdline', 'rb') as stream:
                    observed_command = stream.read(131073).rstrip(b'\0').split(b'\0')
                if process_credentials(pid) == (user.pw_uid, user.pw_gid) and observed_command == [
                        value.encode() for value in plan['command']]:
                    break
            except ProcessLookupError:
                pass
            if not tree.leader_is_live() or not pidfd_running(parent_fd):
                raise LoginFailure('login command exited before exact execution identity')
            time.sleep(0.01)
        else:
            raise LoginFailure('login command execution identity was not observed')
        frames.emit({'type': 'started', 'operation_id': plan['operation_id'], 'pid': pid,
            'start_ticks': tree.leader_starttime, 'runtime_uid': user.pw_uid, 'backend': 'native'})
        while not closing and time.monotonic() < deadline:
            refresh_owned_children(tree)
            processes = [{'pid': value, 'start_ticks': details[1]} for value, details in tree.pinned.items()]
            if processes != previous_processes:
                metadata['processes'] = processes
                write_metadata(root, plan['operation_id'], metadata)
                previous_processes = processes
            observed, wait_status = os.waitpid(pid, os.WNOHANG)
            if observed:
                status = os.waitstatus_to_exitcode(wait_status)
                break
            frames.flush()
            if frames.input:
                try:
                    del frames.input[:os.write(master, frames.input)]
                except BlockingIOError:
                    pass
            for key, _events in poller.select(0.05):
                if key.data == 'parent':
                    closing = True
                elif key.data == 'control':
                    closing = not frames.read(master)
                elif key.data == 'pty':
                    try:
                        data = os.read(master, 16384)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b''
                    if data:
                        frames.emit({'type': 'output', 'data': base64.b64encode(data).decode()})
                    else:
                        closing = True
    except Exception:
        protocol_failed = True
    finally:
        if ready_write is not None:
            os.close(ready_write)
        poller.close()
        try:
            refresh_owned_children(tree)
            metadata['processes'] = [{'pid': value, 'start_ticks': details[1]} for value, details in tree.pinned.items()]
            try:
                write_metadata(root, plan['operation_id'], metadata)
            except Exception:
                protocol_failed = True
            stop_owned_children(tree)
            if status is None:
                try:
                    _observed, wait_status = os.waitpid(pid, 0)
                    status = os.waitstatus_to_exitcode(wait_status)
                except ChildProcessError:
                    status = -signal.SIGTERM
            from cauce_container_proc import reap_children
            reap_children()
            remove_metadata(root, plan['operation_id'])
            try:
                frames.drain_pty(master)
                frames.emit({'type': 'exited', 'operation_id': plan['operation_id'], 'exit_code': status,
                    'stopped_verified': True})
                frames.drain()
            except BrokenPipeError:
                pass
            except LoginFailure:
                protocol_failed = True
        finally:
            tree.close()
            os.close(master)
            os.close(parent_fd)
            os.close(lock)
            os.close(root)
    return 2 if protocol_failed else 0


def run_native(plan: dict, *, child: bool = False) -> int:
    user = native_user(plan, child=child)
    root = private_state(plan['state_root'], create=child)
    lock = acquire(root, plan['operation_id'])
    if read_metadata(root, plan['operation_id']) is not None:
        os.close(lock)
        os.close(root)
        raise LoginFailure('login operation requires cleanup before reuse')
    controller = process_identity(os.getpid())
    guardian = os.fork()
    if guardian == 0:
        try:
            os._exit(run_guardian(plan, user, root, lock, controller))
        except BaseException:
            os._exit(2)
    os.close(lock)
    os.close(root)
    descriptor = open_pidfd(guardian)
    def forward(termination, _frame):
        signal_pidfd(descriptor, termination)
    for termination in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(termination, forward)
    try:
        _observed, status = os.waitpid(guardian, 0)
        return os.waitstatus_to_exitcode(status)
    finally:
        os.close(descriptor)


def cleanup_native(identity: str, state_root: str) -> dict:
    root = private_state(state_root)
    descriptors = []
    lock = None
    try:
        saved = read_metadata(root, identity)
        if saved is None:
            lock = acquire(root, identity, wait=5)
            if read_metadata(root, identity) is not None:
                raise LoginFailure('login identity appeared during cleanup')
            return {'stopped_verified': True}
        expected = {'schemaVersion', 'operation_id', 'account_scope', 'backend', 'runtime_uid',
                    'controller', 'guardian', 'expires_at', 'boot_id', 'processes'}
        if set(saved) != expected or saved['backend'] != 'native' or type(saved['runtime_uid']) is not int \
                or not isinstance(saved['processes'], list) or len(saved['processes']) > 128 or saved['boot_id'] != boot_identity():
            raise LoginFailure('invalid saved login lifecycle identity')
        guardian = pin_identity(saved['guardian'])
        if guardian is not None:
            descriptors.append(guardian)
            if process_credentials(saved['guardian']['pid'])[0] != os.geteuid():
                raise LoginFailure('saved login guardian owner differs')
        pinned = []
        for process in saved['processes']:
            descriptor = pin_identity(process)
            if descriptor is not None:
                if process_credentials(process['pid'])[0] != saved['runtime_uid']:
                    os.close(descriptor)
                    raise LoginFailure('saved login process owner differs')
                descriptors.append(descriptor)
                pinned.append(descriptor)
        if guardian is not None:
            signal_pidfd(guardian, signal.SIGTERM)
            lock = acquire(root, identity, wait=6)
            if read_metadata(root, identity) is None and all(not pidfd_running(value) for value in pinned):
                return {'stopped_verified': True}
        else:
            lock = acquire(root, identity, wait=1)
        for termination, seconds in ((signal.SIGTERM, 0.8), (signal.SIGKILL, 3)):
            for descriptor in pinned:
                if pidfd_running(descriptor):
                    signal_pidfd(descriptor, termination)
            deadline = time.monotonic() + seconds
            while any(pidfd_running(value) for value in pinned) and time.monotonic() < deadline:
                time.sleep(0.05)
        if any(pidfd_running(value) for value in pinned):
            raise LoginFailure('login processes were not observed stopped')
        remove_metadata(root, identity)
        return {'stopped_verified': True}
    finally:
        for descriptor in descriptors:
            os.close(descriptor)
        if lock is not None:
            os.close(lock)
        os.close(root)
