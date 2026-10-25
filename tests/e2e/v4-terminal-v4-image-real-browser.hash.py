from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import time

PYTHON_HASH = '''import hashlib,json,os,sys,time
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 hint_started=time.monotonic()
 if sys.argv[3]=='1':os.posix_fadvise(fd,0,0,os.POSIX_FADV_SEQUENTIAL)
 hint_wall_ms=(time.monotonic()-hint_started)*1000
 h=hashlib.sha256();total=0;calls=0;size=int(sys.argv[2])
 while True:
  chunk=os.read(fd,size);calls+=1
  if not chunk:break
  total+=len(chunk);h.update(chunk)
 print(json.dumps({'digest':h.hexdigest(),'bytes_read':total,'file_read_calls_including_eof':calls,'buffer_bytes':size,'sequential_advice':sys.argv[3]=='1','hint_wall_ms':hint_wall_ms}))
finally:os.close(fd)
'''


def metadata(path: str) -> dict:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        value = os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > 1024**3:
            raise ValueError('target must be a single-link regular file of at most 1 GiB')
        if value.st_uid not in {0, os.geteuid()} or value.st_mode & 0o022:
            raise ValueError('target ownership or write permissions are unsafe')
        return {key: getattr(value, 'st_' + key) for key in
                ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtime_ns', 'ctime_ns', 'blocks']}
    finally:
        os.close(fd)


def cgroup() -> dict:
    result = {}
    for name in ['cpu.stat', 'cpu.max', 'io.stat', 'memory.current', 'memory.events']:
        try:
            with pathlib.Path('/sys/fs/cgroup', name).open() as source:
                raw = source.read(4097)
            result[name] = raw[:4096]
            if len(raw) > 4096:
                result[name + '_truncated'] = True
        except OSError as error:
            result[name] = {'error_type': type(error).__name__}
    return result


def process_metrics(pid: int, expected: str, *, descriptors: bool = False) -> dict:
    root = pathlib.Path('/proc') / str(pid)
    result = {}
    for name in ['io', 'stat', 'wchan', 'syscall']:
        try:
            raw = (root / name).read_text()
            if name == 'io':
                result[name] = {key: int(value) for key, value in (line.split(':', 1) for line in raw.splitlines())}
            elif name == 'stat':
                values = raw.rsplit(') ', 1)[1].split()
                result[name] = {'state': values[0], 'user_ticks': int(values[11]),
                                'system_ticks': int(values[12]), 'starttime': values[19]}
            elif name == 'syscall':
                result[name] = raw.split()[0]
            else:
                result[name] = raw.strip()
        except OSError as error:
            result[name] = {'error_type': type(error).__name__}
    if descriptors:
        result['descriptor_classes'] = {}
        try:
            for index, fd in enumerate((root / 'fd').iterdir()):
                if index == 64:
                    result['descriptors_truncated'] = True
                    break
                target = os.readlink(fd)
                kind = 'target' if target == expected else next(
                    (prefix for prefix in ['socket:', 'pipe:', 'anon_inode:'] if target.startswith(prefix)), 'other')
                result['descriptor_classes'][fd.name] = kind
        except OSError as error:
            result['descriptor_error'] = type(error).__name__
    return result


def usage_delta(before, after) -> dict:
    keys = ['ru_utime', 'ru_stime', 'ru_minflt', 'ru_majflt', 'ru_inblock', 'ru_oublock', 'ru_nvcsw', 'ru_nivcsw']
    return {key.removeprefix('ru_'): getattr(after, key) - getattr(before, key) for key in keys}


parser = argparse.ArgumentParser()
parser.add_argument('--path', required=True)
parser.add_argument('--mode', choices=['gnu', 'python-32768', 'python-65536', 'python-1048576',
                                    'python-32768-sequential'], required=True)
parser.add_argument('--timeout', type=float, default=40)
parser.add_argument('--expected-sha256', required=True)
parser.add_argument('--output-json')
args = parser.parse_args()
if args.path not in {'/usr/local/bin/muse', '/usr/local/bin/node',
                     '/usr/local/lib/node_modules/@xai-official/grok/bin/grok-native'}:
    parser.error('target must be an approved public native binary')
if not 0 < args.timeout <= 40:
    parser.error('the child deadline must be positive and may not exceed 40 seconds')
if len(args.expected_sha256) != 64 or (
        any(character not in '0123456789abcdef' for character in args.expected_sha256)):
    parser.error('expected SHA256 must contain 64 lowercase hexadecimal characters')
if args.output_json and not re.fullmatch(
        r'/home/node/\.cauce/h8f-(?:muse|grok|openclaw)-[0-9a-f]{10}/cauce-h8f-hash-[0-9a-f]{32}\.json', args.output_json):
    parser.error('checkpoint must use the owned canary state directory and a unique hexadecimal filename')
if os.path.realpath(args.path) != args.path:
    parser.error('target must be canonical')
before = metadata(args.path)
command = ['/usr/bin/sha256sum', args.path] if args.mode == 'gnu' else [
    sys.executable, '-I', '-B', '-c', PYTHON_HASH, args.path, args.mode.split('-')[1],
    '1' if args.mode == 'python-32768-sequential' else '0']
report = {'mode': args.mode, 'target': args.path, 'file_before': before, 'timeout_seconds': args.timeout,
          'cache_control': 'none', 'clock_ticks': os.sysconf('SC_CLK_TCK'), 'process_samples': []}
probe_wall_ms = 0.0
checkpoint_wall_ms = 0.0
checkpoint_identity = None
if args.output_json:
    checkpoint_fd = os.open(args.output_json, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    checkpoint_stat = os.fstat(checkpoint_fd)
    checkpoint_identity = (checkpoint_stat.st_dev, checkpoint_stat.st_ino)
    os.close(checkpoint_fd)


def observe(callback, *values, **keywords):
    global probe_wall_ms
    probe_started = time.monotonic()
    try:
        return callback(*values, **keywords)
    finally:
        probe_wall_ms += (time.monotonic() - probe_started) * 1000


def publish() -> str:
    global checkpoint_identity, checkpoint_wall_ms
    report['observer'] = {'probe_wall_ms': probe_wall_ms,
                          'checkpoint_wall_ms_before_current_write': checkpoint_wall_ms,
                          'sample_count': len(report['process_samples']),
                          'scope': 'wrapper wall and cgroup include observer; child rusage excludes observer'}
    encoded = json.dumps(report, sort_keys=True)
    if len(encoded.encode()) > 128 * 1024:
        raise ValueError('checkpoint exceeds 128 KiB')
    if args.output_json:
        checkpoint_started = time.monotonic()
        current = os.lstat(args.output_json)
        if (current.st_dev, current.st_ino) != checkpoint_identity or (
                not stat.S_ISREG(current.st_mode) or current.st_uid != os.geteuid()
                or current.st_nlink != 1 or stat.S_IMODE(current.st_mode) != 0o600):
            raise ValueError('checkpoint identity changed')
        fd, temporary = tempfile.mkstemp(prefix='.cauce-h8f-hash-', suffix='.tmp', dir=pathlib.Path(args.output_json).parent)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(encoded)
                output.flush()
            os.replace(temporary, args.output_json)
            current = os.lstat(args.output_json)
            checkpoint_identity = (current.st_dev, current.st_ino)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        checkpoint_wall_ms += (time.monotonic() - checkpoint_started) * 1000
    return encoded


report['cgroup_before'] = observe(cgroup)
usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
self_usage_before = resource.getrusage(resource.RUSAGE_SELF)
started = time.monotonic()
child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         start_new_session=True)
report['pid'] = child.pid
report['process_before'] = observe(process_metrics, child.pid, args.path)
next_sample = 3.0
timed_out = False
stdout = stderr = b''
try:
    report['state'] = 'running'
    publish()
    while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
        elapsed = time.monotonic() - started
        if elapsed >= args.timeout:
            timed_out = True
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break
        if elapsed >= next_sample and len(report['process_samples']) < 13:
            report['process_samples'].append({'elapsed_ms': elapsed * 1000,
                                             **observe(process_metrics, child.pid, args.path, descriptors=True)})
            next_sample = (int(elapsed / 3) + 1) * 3
            publish()
        time.sleep(0.02)
    report['completion_observed_ms'] = (time.monotonic() - started) * 1000
    report['completion_observed_late'] = not timed_out and (
        report['completion_observed_ms'] >= args.timeout * 1000)
    if timed_out:
        collection_deadline = time.monotonic() + 1
        while os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            if time.monotonic() >= collection_deadline:
                report['final_process_io_unconfirmed'] = True
                break
            time.sleep(0.01)
    report['process_before_reap'] = observe(process_metrics, child.pid, args.path)
    stdout, stderr = child.communicate(timeout=1)
except subprocess.TimeoutExpired:
    report['collection_timeout'] = True
finally:
    if child.returncode is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = child.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            report['child_reap_unconfirmed'] = True
report['wall_ms'] = (time.monotonic() - started) * 1000
report['child_rusage_delta'] = usage_delta(usage_before, resource.getrusage(resource.RUSAGE_CHILDREN))
report.update(exit_code=child.returncode, timed_out=timed_out,
              cgroup_after=observe(cgroup), file_after=observe(metadata, args.path))
report['observer_rusage_delta_before_final_write'] = usage_delta(
    self_usage_before, resource.getrusage(resource.RUSAGE_SELF))
report['state'] = 'finished' if child.returncode is not None else 'child_reap_unconfirmed'
report['file_unchanged'] = before == report['file_after']
report['stderr_bytes'] = len(stderr)
if child.returncode == 0:
    value = stdout.decode().split()[0] if args.mode == 'gnu' else json.loads(stdout)
    report['result'] = {'digest': value} if isinstance(value, str) else value
    report['matches_expected'] = report['result']['digest'] == args.expected_sha256
report['benchmark_accepted'] = bool(
    child.returncode == 0 and report.get('matches_expected') and report['file_unchanged']
    and not timed_out and not report.get('completion_observed_late', True))
print(publish())
sys.exit(0 if report['benchmark_accepted'] else 1)
