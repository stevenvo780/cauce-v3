from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shlex
import stat
import subprocess
import sys
import time

from fleet_executor_native_manager import systemctl
from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, open_absolute_directory
from fleet_executor_terminal import properties


def approved_release(policy: dict, agent: dict) -> tuple[pathlib.Path, str, bytes]:
    release = pathlib.Path(__file__).resolve().parents[2]
    bundle = pathlib.Path(policy['bundles'][agent['harness_id']]['directory'])
    if not bundle.is_relative_to(release) or re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', release.name) is None:
        raise SafeFailure('terminal runtime is outside the approved adapter release')
    root = release / 'ops'
    for directory in (release, root, root / 'pty-agent'):
        descriptor = open_absolute_directory(directory)
        try:
            info = os.fstat(descriptor)
            if info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022:
                raise SafeFailure('terminal release directory is unsafe')
        finally:
            os.close(descriptor)
    pins = {}
    for directory, names, files in os.walk(root / 'pty-agent', followlinks=False):
        for name in [*names, *files]:
            filename = pathlib.Path(directory) / name
            info = filename.lstat()
            if info.st_uid not in {0, os.geteuid()} or info.st_mode & 0o022 or stat.S_ISREG(info.st_mode) and info.st_nlink != 1 \
                    or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise SafeFailure('terminal release ownership or mode is unsafe')
            if stat.S_ISREG(info.st_mode):
                pins[str(filename.relative_to(root))] = hashlib.sha256(filename.read_bytes()).hexdigest()
    for name in ('pty-agent/cauce-pty-launcher.sh', 'pty-agent/cauce_pty_agent/__main__.py',
                 'pty-agent/systemd/cauce-v3-pty@.service', 'pty-agent/reap_orphan_agent.py'):
        if name not in pins:
            raise SafeFailure('terminal approved release is incomplete')
    version = hashlib.sha256(json.dumps(pins, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return root, version, (root / 'pty-agent/systemd/cauce-v3-pty@.service').read_bytes()


def selector(ops: pathlib.Path, version: str, state: str, generation: str, key: str, identity: str, host: str,
             *, shared_tui: bool = False) -> bytes:
    if type(shared_tui) is not bool:
        raise SafeFailure('terminal shared TUI approval is invalid')
    values = {'CAUCE_PTY_OPS_ROOT': str(ops), 'CAUCE_PTY_AGENT_VERSION': version,
              'CAUCE_PTY_FLEET_STATE': state, 'CAUCE_PTY_FLEET_GENERATION': generation,
              'CAUCE_PTY_FLEET_RUNTIME_KEY': key, 'CAUCE_PTY_FLEET_IDENTITY': identity, 'CAUCE_PTY_FLEET_HOST': host,
              'CAUCE_PTY_FLEET_SHARED_TUI': str(int(shared_tui))}
    if any('\n' in value or '\r' in value or '\0' in value for value in values.values()):
        raise SafeFailure('terminal unit environment contains an invalid value')
    return ('[Service]\n' + ''.join('Environment="' + name + '=' + value.replace('\\', '\\\\').replace('"', '\\"') + '"\n'
                                   for name, value in values.items())).encode()


def unit_state(unit: str, root: pathlib.Path) -> dict:
    row = properties(unit, root)
    return {'active': row.get('ActiveState') == 'active', 'enabled': row.get('UnitFileState', '').startswith('enabled')}


def legacy_selector(filename: pathlib.Path, values: dict, commands: list[str], unit: str, root: pathlib.Path,
                    agent: dict) -> tuple[pathlib.Path, bytes]:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'pty-agent'))
    try:
        from rollout_pty_lib import ManagerWorker, RolloutError
        try:
            published, fleet = ManagerWorker('server').validate_release(values.get('CAUCE_PTY_AGENT_VERSION', ''))
        except RolloutError:
            raise SafeFailure('terminal legacy immutable release is unverified') from None
        if set(values) != {'CAUCE_PTY_OPS_ROOT', 'CAUCE_PTY_AGENT_VERSION'} \
                or pathlib.Path(values['CAUCE_PTY_OPS_ROOT']) != published or filename.name >= 'zz-fleet-terminal.conf':
            raise SafeFailure('terminal legacy selector is outside its immutable published release')
        if commands and (filename != root / (unit + '.d') / '20-cauce-release.conf'
                         or len(commands) != 2 or commands[0] != ''
                         or shlex.split(commands[1]) != [str(published / 'pty-agent/cauce-pty-launcher.sh'), '%i']):
            raise SafeFailure('terminal legacy execution differs from its immutable published launcher')
        selected = fleet.aliases.get(unit.split('@', 1)[1][:-len('.service')])
        if selected is None or selected['tenant'] != agent['tenant_id'] \
                or selected.get('alias', agent['alias']) != agent['alias'] or selected['container'] != agent['container_name']:
            raise SafeFailure('terminal legacy unit belongs to another physical or wire identity')
        return published, checked_file(published / 'pty-agent/systemd/cauce-v3-pty@.service')
    finally:
        del sys.path[0]


def pin_unit(unit: str, root: pathlib.Path, body: bytes, expected_selector: bytes | None = None, *, agent: dict) -> dict:
    row = properties(unit, root)
    if row.get('LoadState') == 'not-found':
        return row
    fragment = pathlib.Path(row['FragmentPath'])
    fragment_body = checked_file(fragment)
    legacy_templates, legacy_dropins = [], []
    for name in row.get('DropInPaths', '').split():
        filename = pathlib.Path(name)
        raw = checked_file(filename)
        managed = filename.name == 'zz-fleet-terminal.conf'
        if any(line and not line.startswith((b'#', b';', b'Environment=', b'ExecStart=')) and line != b'[Service]'
               for line in raw.splitlines()):
            raise SafeFailure('terminal unit drop-in changes more than its approved environment')
        values, commands = {}, []
        for line in raw.decode().splitlines():
            if line.startswith('ExecStart='):
                commands.append(line[len('ExecStart='):])
            if line.startswith('Environment='):
                for assignment in shlex.split(line[len('Environment='):]):
                    key, separator, value = assignment.partition('=')
                    allowed = {'CAUCE_PTY_OPS_ROOT', 'CAUCE_PTY_AGENT_VERSION'}
                    if managed:
                        allowed |= {'CAUCE_PTY_FLEET_STATE', 'CAUCE_PTY_FLEET_GENERATION', 'CAUCE_PTY_FLEET_RUNTIME_KEY',
                                    'CAUCE_PTY_FLEET_IDENTITY', 'CAUCE_PTY_FLEET_HOST', 'CAUCE_PTY_FLEET_SHARED_TUI'}
                    if not separator or key in values or key not in allowed:
                        raise SafeFailure('terminal legacy selector has unapproved environment fields')
                    values[key] = value
        if commands and (managed or not values):
            raise SafeFailure('terminal unit drop-in changes more than its approved environment')
        if managed and (set(values) - {'CAUCE_PTY_FLEET_SHARED_TUI'} != {'CAUCE_PTY_OPS_ROOT', 'CAUCE_PTY_AGENT_VERSION', 'CAUCE_PTY_FLEET_STATE',
                                      'CAUCE_PTY_FLEET_GENERATION', 'CAUCE_PTY_FLEET_RUNTIME_KEY',
                                      'CAUCE_PTY_FLEET_IDENTITY', 'CAUCE_PTY_FLEET_HOST'}
                        or values.get('CAUCE_PTY_FLEET_SHARED_TUI', '0') not in {'0', '1'}):
            raise SafeFailure('terminal managed selector is incomplete')
        if values:
            ops = pathlib.Path(values.get('CAUCE_PTY_OPS_ROOT', ''))
            if managed:
                from fleet_executor_rebind import installed_release
                from fleet_executor_terminal_inventory import launcher_row
                current = pathlib.Path(__file__).resolve().parents[2]
                if ops.name != 'ops' or ops.parent.parent != current.parent:
                    raise SafeFailure('terminal selector is outside its approved release family')
                installed_release(ops.parent)
                if values.get('CAUCE_PTY_FLEET_RUNTIME_KEY') != agent['runtime_key']:
                    raise SafeFailure('terminal selector belongs to another physical identity')
                selected = launcher_row(pathlib.Path(values['CAUCE_PTY_FLEET_STATE']), values['CAUCE_PTY_FLEET_GENERATION'],
                    agent['runtime_key'], values['CAUCE_PTY_FLEET_IDENTITY'])
                if selected['tenant'] != agent['tenant_id'] or selected.get('alias', agent['runtime_key']) != agent['alias']:
                    raise SafeFailure('terminal selector belongs to another wire identity')
                if expected_selector is not None and raw != expected_selector:
                    raise SafeFailure('terminal unit selector differs from its approved placement')
                continue
            _, legacy_body = legacy_selector(filename, values, commands, unit, root, agent)
            legacy_templates.append(legacy_body)
            if filename.parent == root / (unit + '.d'):
                legacy_dropins.append({'path': str(filename), 'sha256': hashlib.sha256(raw).hexdigest(),
                                       'mode': stat.S_IMODE(filename.stat(follow_symlinks=False).st_mode)})
    template = root / (unit.split('@', 1)[0] + '@.service')
    if fragment_body != body and (expected_selector is not None or fragment != template or fragment_body not in legacy_templates):
        raise SafeFailure('terminal existing unit is not the canonical template')
    if legacy_dropins:
        row = {**row, 'legacy_dropins': legacy_dropins}
    return row


def process_identity(pid: str, version: str, invocation: str) -> int:
    process = pathlib.Path('/proc') / pid
    try:
        starttime = (process / 'stat').read_text(encoding='ascii').rsplit(') ', 1)[1].split()[19]
        expected = {b'CAUCE_PTY_AGENT_VERSION': version.encode(), b'INVOCATION_ID': invocation.encode()}
        selected = {}
        for entry in (process / 'environ').read_bytes().split(b'\0'):
            name, separator, value = entry.partition(b'=')
            if name in expected:
                if not separator or name in selected:
                    raise SafeFailure('terminal unit process has ambiguous release or invocation identity')
                selected[name] = value
        if process.stat().st_uid != os.geteuid() or selected != expected \
                or re.fullmatch(r'[0-9]+', starttime) is None or int(starttime) <= 0:
            raise SafeFailure('terminal unit process is outside its approved release or invocation')
        return int(starttime)
    except (OSError, ValueError, IndexError, UnicodeError):
        raise SafeFailure('terminal unit process identity is unavailable') from None


def presence(unit: str, wire: str, version: str, *, attempts: int = 20) -> dict:
    runtime = pathlib.Path('/run/user') / str(os.geteuid())
    try:
        boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip().replace('-', '')
    except (OSError, UnicodeError):
        raise SafeFailure('terminal current boot identity is unavailable') from None
    if re.fullmatch(r'[a-f0-9]{32}', boot) is None:
        raise SafeFailure('terminal current boot identity is invalid')
    for attempt in range(attempts):
        if attempt:
            time.sleep(0.5)
        details = dict(line.split('=', 1) for line in systemctl('show', unit,
            '--property=ActiveState,MainPID,InvocationID,ExecMainStartTimestampMonotonic').splitlines())
        pid = details.get('MainPID', '')
        invocation = details.get('InvocationID', '')
        started = details.get('ExecMainStartTimestampMonotonic', '')
        if details.get('ActiveState') == 'active' and re.fullmatch(r'[0-9]+', pid) and int(pid) > 1 \
                and re.fullmatch(r'[0-9]+', started) and int(started) > 0 \
                and re.fullmatch(r'[a-f0-9]{32}', invocation or ''):
            try:
                pinned_starttime = process_identity(pid, version, invocation)
            except SafeFailure:
                continue
            journal_fields = {'_SYSTEMD_USER_UNIT': unit, '_UID': str(os.geteuid()), '_PID': pid, '_BOOT_ID': boot}
            result = subprocess.run(['/usr/bin/journalctl', '--user', '--user-unit=' + unit,
                *(name + '=' + value for name, value in journal_fields.items()),
                '--no-pager', '-o', 'json', '-n', '100'], capture_output=True, timeout=10, check=False,
                env={'PATH': '/usr/bin:/bin', 'XDG_RUNTIME_DIR': str(runtime),
                     'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + str(runtime / 'bus')})
            if result.returncode == 0 and len(result.stdout) <= 1024 * 1024:
                records = [json.loads(line) for line in result.stdout.splitlines() if line]
                messages = []
                for row in records:
                    if not isinstance(row, dict) or any(row.get(name) != value for name, value in journal_fields.items()):
                        continue
                    timestamp = row.get('__MONOTONIC_TIMESTAMP')
                    if isinstance(timestamp, str) and re.fullmatch(r'[0-9]+', timestamp) and int(timestamp) >= int(started) \
                            and isinstance(row.get('MESSAGE'), str):
                        messages.append(row['MESSAGE'])
                start = any(re.search(r'\bstarting alias=' + re.escape(wire) + r' .*\bversion=' + version + r'(?:\s|$)', row)
                            for row in messages)
                accepted = []
                for index, row in enumerate(messages):
                    acknowledgement = re.search(r'\brelay accepted alias=' + re.escape(wire) + r' modes=([a-z_,]+)(?:\s|$)', row)
                    if acknowledgement is not None:
                        modes = acknowledgement[1].split(',')
                        if 'shell' in modes and len(modes) == len(set(modes)):
                            accepted.append(index)
                disconnected = any('relay connect failed:' in row or 'relay session ended:' in row
                                   for row in messages[accepted[-1] + 1:]) if accepted else True
                if start and accepted and not disconnected:
                    after = systemctl('show', unit, '--property=MainPID,InvocationID')
                    if dict(line.split('=', 1) for line in after.splitlines()) == {'MainPID': pid, 'InvocationID': invocation}:
                        try:
                            if process_identity(pid, version, invocation) == pinned_starttime:
                                return {'main_pid': int(pid), 'invocation_id': invocation, 'relay_acknowledged': True}
                        except SafeFailure:
                            continue
    raise SafeFailure('terminal relay acknowledgement was not observed for the current unit invocation')
