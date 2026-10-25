from __future__ import annotations

import argparse
import base64
import errno
import json
import os
import pathlib
import pwd
import re
import resource
import signal
import stat
import subprocess
import sys
import time
import uuid
import zipfile

import space_archive
from space_backup_validate import (
    CHUNK_BYTES,
    MAX_BYTES,
    REQUEST_BYTES,
    BackupStreamChild,
    PinnedBackupReader,
    acknowledged,
    bounded_process_exit,
    read_frame,
    relay_stream,
    verified_archive,
    write_frame,
)


def failure_record(cause_type: str, message: str, stage: str) -> dict:
    if stage not in {'runtime', 'local'}:
        raise ValueError('invalid backup failure stage')
    for pattern, replacement in (
        (r'-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)', '[redacted]'),
        (r'\bbearer\s+[^\s"\']+', 'Bearer [redacted]'),
        (r'\b((?:pass(?:word|wd)?|secret|token|api[_-]?key)["\']?\s*[=:]\s*)(?:"[^"]*"|\'[^\']*\'|[^\s"\',;]+)', r'\1[redacted]'),
        (r'\b[a-z][a-z0-9+.-]*://[^\s<>"\']+', '[url]'),
        (r'[A-Z]:[\\/][^\s<>"\']*', '[path]'),
        (r'\\\\[^\s<>"\']+', '[path]'),
        (r'/[^\s<>"\']*', '[path]'),
        (r'[A-Z0-9._%+-]+@[A-Z0-9.-]+', '[email]'),
        (r'[A-Za-z0-9+_=-]{33,}', '[redacted]'),
    ):
        message = re.sub(pattern, replacement, message, flags=re.IGNORECASE)
    message = re.sub(r'[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]', ' ', message)
    message = re.sub(r'\s+', ' ', message).strip().encode('ascii', 'backslashreplace').decode()[:384]
    return {'event': 'space_backup_failure', 'stage': stage,
            'cause_type': cause_type if re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,63}', cause_type) else 'Error',
            'cause_message': message or 'backup effect could not be verified'}


def exception_record(error: BaseException, stage: str) -> dict:
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        message = 'space backup command exceeded its deadline'
    elif isinstance(error, subprocess.CalledProcessError):
        message = f'space backup command exited with status {error.returncode}'
    elif isinstance(error, OSError):
        message = error.strerror or 'space backup filesystem operation failed'
    else:
        message = str(error)
    return failure_record(type(error).__name__, message, stage)


def archive_path(request: dict) -> pathlib.Path:
    fields = {'action', 'id', 'claim_epoch', 'state_directory', 'identity'}
    if not isinstance(request, dict) or set(request) != fields | ({'offset'} if request.get('action') == 'read' else set()) \
            or request['action'] not in {'export', 'read', 'remove'} \
            or str(uuid.UUID(request['id'])) != request['id'] \
            or type(request['claim_epoch']) is not int or not 1 <= request['claim_epoch'] <= 2147483647:
        raise ValueError('invalid local backup request')
    space_archive.identity(request['identity'])
    root = request['state_directory']
    descriptor = space_archive.open_directory(root)
    os.close(descriptor)
    return pathlib.Path(root) / f"space-backup-{request['id']}-{request['claim_epoch']}.zip"


def remove_copy(parent: int, name: str) -> None:
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        raise ValueError('backup cache has an unsafe copy')
    os.unlink(name, dir_fd=parent)


def execute(request: dict) -> dict:
    archive = archive_path(request)
    parent = space_archive.open_directory(str(archive.parent))
    try:
        if request['action'] == 'remove':
            remove_copy(parent, archive.name)
            return {'removed': True}
        if request['action'] == 'export':
            for name in os.listdir(parent):
                parts = name.removeprefix('space-backup-').removesuffix('.zip').rsplit('-', 1)
                if not name.startswith('space-backup-') or not name.endswith('.zip') or len(parts) != 2:
                    continue
                try:
                    if str(uuid.UUID(parts[0])) != parts[0] or not parts[1].isdigit():
                        continue
                except ValueError:
                    continue
                if os.stat(name, dir_fd=parent, follow_symlinks=False).st_mtime < time.time() - 86400:
                    remove_copy(parent, name)
            try:
                os.stat(archive.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
                resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
                space_archive.backup_space(str(archive.parent / 'space'), str(archive), request['identity'])
            receipt = verified_archive(str(archive), request['identity'])
            receipt['metrics'] = {'peak_rss_kib': int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                                                    + resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)}
            return receipt
        offset = request['offset']
        if type(offset) is not int or not 0 <= offset < MAX_BYTES:
            raise ValueError('invalid backup read offset')
        descriptor = os.open(archive.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 \
                    or info.st_mode & 0o077 or not 0 < info.st_size <= MAX_BYTES or offset >= info.st_size:
                raise ValueError('backup cache is not a private bounded copy')
            chunk = os.pread(descriptor, CHUNK_BYTES, offset)
            if not chunk or space_archive.fingerprint(info) != space_archive.fingerprint(os.fstat(descriptor)):
                raise ValueError('backup chunk changed during read')
            return {'offset': offset, 'data': base64.b64encode(chunk).decode('ascii')}
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def stream_local(request: dict, source, destination) -> None:
    if not isinstance(request, dict) or request.get('action') != 'read':
        raise ValueError('backup streaming only accepts reads')
    reader = PinnedBackupReader(archive_path(request), request['offset'])
    try:
        while frame := reader.read():
            write_frame(destination, frame)
            if not acknowledged(source, reader.advance(frame)):
                return
        reader.unchanged()
        write_frame(destination, {'done': True, 'offset': reader.offset})
    finally:
        reader.close()


def stream_command(runtime, policy: dict, snapshot: dict) -> tuple[list, dict, dict | None]:
    if snapshot.get('runtime_mode') == 'legacy-container':
        approve = getattr(runtime, 'approve_legacy_container', None)
        if not callable(approve):
            raise ValueError('canonical legacy backup approval is unavailable')
        agent, binding = approve(policy, snapshot)
    else:
        agent = runtime.approve_agent(policy, snapshot)
        binding = None
        if agent['runtime_mode'] == 'container':
            agent, binding = runtime.read_container_binding(policy, agent)
    if binding is not None:
        from fleet_executor_container import isolated_python
        command = ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', agent['runtime_user'], binding['container_id'],
                   *isolated_python(str(runtime.path(agent['_placement']['python'])),
                                    '/cauce/executor/space_backup_local.py', '--stream-local')]
    else:
        user = pwd.getpwnam(agent['runtime_user'])
        if user.pw_dir != agent['home_directory']:
            raise ValueError('space backup runtime home differs')
        command = [str(pathlib.Path(sys.executable).resolve()), str(pathlib.Path(__file__).resolve()), '--stream-local']
        if user.pw_uid != os.geteuid():
            if os.geteuid() != 0:
                raise ValueError('space backup executor is not the exact runtime owner')
            command = ['/usr/sbin/runuser', '-u', agent['runtime_user'], '--', *command]
    return command, agent, binding


def host_stream(policy_file: pathlib.Path, source, destination) -> None:
    import space_backup_runtime as runtime
    request = read_frame(source, REQUEST_BYTES)
    claim = runtime.validate_request(request)
    if request['action'] != 'read' or type(request['offset']) is not int or not 0 <= request['offset'] <= MAX_BYTES:
        raise ValueError('invalid backup stream request or offset')
    if runtime.digest(policy_file) != claim['policy_sha256']:
        raise ValueError('space backup policy changed')
    policy = runtime.load_policy(policy_file)
    if runtime.digest(policy_file) != claim['policy_sha256']:
        raise ValueError('space backup policy changed during read')
    command, agent, binding = stream_command(runtime, policy, claim['agent_snapshot'])
    local = {'action': 'read', 'id': claim['id'], 'claim_epoch': claim['claim_epoch'], 'offset': request['offset'],
             'state_directory': agent['state_directory'],
             'identity': {field: agent[field] for field in ('company_id', 'tenant_id', 'alias', 'runtime_key')}}
    environment = {'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'PYTHONDONTWRITEBYTECODE': '1',
                   **{key: os.environ[key] for key in ('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_CONFIG') if key in os.environ}}
    child = None
    process = None
    pending = set()
    previous = {}

    def deferred(signum, _frame):
        pending.add(signum)

    try:
        try:
            for signum in (signal.SIGTERM, signal.SIGALRM):
                previous[signum] = signal.signal(signum, deferred)
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, env=environment, start_new_session=True)
            child = BackupStreamChild(process, remote=binding is not None)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
        if pending:
            if signal.SIGALRM in pending:
                raise TimeoutError('space backup stream exceeded its deadline during spawn')
            raise InterruptedError('space backup stream was cancelled during spawn')
        write_frame(child.process.stdin, local)
        done = relay_stream(child, source, destination, request['offset'])
        if done is None:
            return
        if binding is not None:
            _, after = runtime.read_container_binding(policy, agent)
            if after['container_id'] != binding['container_id'] or after['generation'] != binding['generation']:
                raise ValueError('space backup container was replaced')
        if runtime.digest(policy_file) != claim['policy_sha256']:
            raise ValueError('space backup policy changed before the receipt')
        write_frame(destination, done)
    finally:
        if child is not None:
            child.close()
        elif process is not None:
            process.stdin.close()
            try:
                _, forced = bounded_process_exit(process, remote=binding is not None)
                if forced and binding is not None:
                    raise RuntimeError('backup stream remote exit is unconfirmed after forced termination of the local transport')
            finally:
                for stream in (process.stdout, process.stderr):
                    stream.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--host-stream', action='store_true')
    modes.add_argument('--stream-local', action='store_true')
    parser.add_argument('--policy')
    args = parser.parse_args()
    if bool(args.policy) != args.host_stream:
        parser.error('a policy is required exclusively for host streaming')

    def expired(_signal, _frame):
        raise TimeoutError('space export deadline elapsed')

    def terminated(_signal, _frame):
        raise InterruptedError('space backup stream was cancelled')

    signal.signal(signal.SIGALRM, expired)
    if args.host_stream or args.stream_local:
        signal.signal(signal.SIGTERM, terminated)
    signal.alarm(1750 if args.host_stream else 1700)
    try:
        if args.host_stream:
            host_stream(pathlib.Path(args.policy), sys.stdin.buffer, sys.stdout.buffer)
            return 0
        if args.stream_local:
            stream_local(read_frame(sys.stdin.buffer, REQUEST_BYTES), sys.stdin.buffer, sys.stdout.buffer)
            return 0
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('backup request exceeds its limit')
        print(json.dumps(execute(json.loads(raw)), separators=(',', ':')))
        return 0
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, RuntimeError, subprocess.SubprocessError) as error:
        if not (args.host_stream or args.stream_local) and (isinstance(error, OSError) and error.errno == errno.EFBIG
                or isinstance(error, space_archive.SpaceArchiveFailure) \
                and str(error) in {'space archive exceeds its total byte limit', 'space contains too many archive entries',
                                   'space manifest exceeds its limit', 'space file exceeds its size limit',
                                   'space archive exceeds its archive byte limit'}):
            print(json.dumps({'error': 'LIMIT_EXCEEDED'}))
            return 0
        print(json.dumps(exception_record(error, 'runtime' if args.host_stream else 'local'), separators=(',', ':')), file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())
