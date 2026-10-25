from __future__ import annotations

import hashlib
import json
import os
import pathlib
import posixpath
import pwd
import re
import stat
import sys
from contextlib import ExitStack

from fleet_executor_native_manager import manager_definition, manager_for, systemctl
from fleet_executor_policy import SafeFailure, open_absolute_directory, open_regular_at, path
from fleet_executor_runtime import HELPER, checked_command, lifecycle_arguments, native_identity, stop


def removal_files(manager: dict) -> dict[pathlib.Path, str]:
    root = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir) / '.config/systemd/user'
    unit = root / manager['unit']
    files = manager['files']
    if not isinstance(files, dict) or str(unit) not in files or len(files) > 100:
        raise SafeFailure('native unit removal requires its approved user unit file')
    approved = {}
    for filename, pin in files.items():
        candidate = path(filename)
        if candidate != unit and (candidate.parent != root / (manager['unit'] + '.d')
                or not candidate.name.endswith('.conf')) or not isinstance(pin, str) \
                or re.fullmatch(r'[a-f0-9]{64}', pin) is None:
            raise SafeFailure('native unit removal is outside its approved configuration')
        approved[candidate] = pin
    return approved


def pinned_file(filename: pathlib.Path, expected: str, *, remove: bool = False) -> bool:
    try:
        parent = open_absolute_directory(filename.parent)
    except FileNotFoundError:
        return False
    try:
        try:
            descriptor = open_regular_at(parent, filename.name, os.O_RDONLY)
        except FileNotFoundError:
            return False
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() \
                    or details.st_nlink != 1 or details.st_mode & 0o022 or details.st_size > 1024 * 1024:
                raise SafeFailure('native unit file ownership, mode or links changed')
            content = b''
            while chunk := os.read(descriptor, 65536):
                content += chunk
                if len(content) > 1024 * 1024:
                    raise SafeFailure('native unit file exceeds its approved size')
            significant = b'\n'.join(line for line in content.splitlines()
                                     if not line.lstrip().startswith((b'#', b';')))
            logical = re.sub(rb'\\\n', b' ', significant)
            if re.search(rb'(?m)^\s*(?:(?:Also|Alias)\s*=|\.include\b)', logical):
                raise SafeFailure('native unit removal cannot disable additional unit names')
            actual = os.stat(filename.name, dir_fd=parent, follow_symlinks=False)
            if hashlib.sha256(content).hexdigest() != expected \
                    or (details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns, details.st_ctime_ns) \
                    != (actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns, actual.st_ctime_ns):
                raise SafeFailure('native unit file changed before removal')
            if remove:
                os.unlink(filename.name, dir_fd=parent)
                os.fsync(parent)
            return True
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def manager_properties(manager: dict, files: dict) -> dict:
    properties = dict(line.split('=', 1) for line in systemctl('show', manager['unit'],
        '--property=LoadState,FragmentPath,DropInPaths,ActiveState,UnitFileState', allow_absent=True).splitlines())
    actual = {properties.get('FragmentPath', ''), *properties.get('DropInPaths', '').split()} - {''}
    if not {'LoadState', 'FragmentPath', 'DropInPaths', 'ActiveState', 'UnitFileState'} <= set(properties) \
            or properties.get('LoadState') not in {'loaded', 'not-found'} \
            or not actual <= {str(filename) for filename in files}:
        raise SafeFailure('native systemd manager changed during decommission')
    return properties


def verify_dropins(manager: dict, files: dict) -> pathlib.Path | None:
    unit = next(filename for filename in files if filename.name == manager['unit'])
    directory = unit.parent / (manager['unit'] + '.d')
    expected = {filename.name for filename in files if filename.parent == directory}
    try:
        descriptor = open_absolute_directory(directory)
    except FileNotFoundError:
        return directory if expected else None
    try:
        details = os.fstat(descriptor)
        if details.st_uid != os.geteuid() or details.st_mode & 0o022:
            raise SafeFailure('native unit drop-in directory ownership or mode changed')
        if set(os.listdir(descriptor)) - expected:
            raise SafeFailure('native unit drop-in directory contains unapproved files')
    finally:
        os.close(descriptor)
    return directory


def disable_native(manager: dict, files: dict, entry: dict, save) -> None:
    fragment = next(filename for filename in files if filename.name == manager['unit'])
    runtime = pathlib.Path('/run/user') / str(os.geteuid()) / 'systemd/user'
    roots = [(fragment.parent, True), (runtime, True), *((pathlib.Path(directory), False) for directory in
        ('/etc/systemd/user', '/run/systemd/user', '/usr/local/lib/systemd/user', '/usr/lib/systemd/user',
         '/etc/xdg/systemd/user', '/usr/local/share/systemd/user', '/usr/share/systemd/user'))]
    global_roots = {root for root, writable in roots if not writable}
    pending = []
    with ExitStack() as opened:
        for root, writable in roots:
            try:
                descriptor = open_absolute_directory(root)
            except FileNotFoundError:
                continue
            except NotADirectoryError:
                if not writable and root.is_symlink() and root.resolve() in global_roots:
                    continue
                raise
            opened.callback(os.close, descriptor)
            details = os.fstat(descriptor)
            if details.st_uid != (os.geteuid() if writable else 0) or details.st_mode & 0o022:
                raise SafeFailure('native enable-link directory ownership or mode changed')
            directories = [(descriptor, root)]
            for name in os.listdir(descriptor):
                if not name.endswith(('.wants', '.requires', '.upholds')):
                    continue
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=descriptor)
                opened.callback(os.close, child)
                details = os.fstat(child)
                if details.st_uid != (os.geteuid() if writable else 0) or details.st_mode & 0o022:
                    raise SafeFailure('native enable-link directory ownership or mode changed')
                directories.append((child, root / name))
            for parent, directory in directories:
                for name in os.listdir(parent):
                    details = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISLNK(details.st_mode):
                        if name == manager['unit'] and directory / name != fragment:
                            raise SafeFailure('native unit has an additional unmanaged unit file')
                        continue
                    target = os.readlink(name, dir_fd=parent)
                    destination = posixpath.normpath(str(directory / target))
                    if name != manager['unit'] and destination != str(fragment):
                        continue
                    if not writable or name != manager['unit'] or destination != str(fragment) \
                            or details.st_uid != os.geteuid():
                        raise SafeFailure('native unit has an unmanaged enable link or alias')
                    pending.append((parent, directory / name, target, details))
        entry['disabled_links'] = list(dict.fromkeys([*entry.get('disabled_links', []),
                                                     *(str(filename) for _, filename, _, _ in pending)]))
        save()
        for parent, filename, target, expected in pending:
            name = filename.name
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (actual.st_dev, actual.st_ino, actual.st_mtime_ns, actual.st_ctime_ns) \
                    != (expected.st_dev, expected.st_ino, expected.st_mtime_ns, expected.st_ctime_ns) \
                    or os.readlink(name, dir_fd=parent) != target:
                raise SafeFailure('native enable link changed before removal')
            os.unlink(name, dir_fd=parent)
            os.fsync(parent)
    systemctl('daemon-reload')
    properties = manager_properties(manager, files)
    if properties.get('ActiveState') != 'inactive' \
            or properties.get('UnitFileState') not in {'disabled', 'static', '', 'not-found'}:
        raise SafeFailure('native systemd unit is still enabled')


def approved_decommission(policy: dict, agent: dict, entry: dict) -> tuple[dict, dict]:
    manager = manager_definition(policy, agent, native_identity(policy, agent))
    if manager is None:
        raise SafeFailure('native decommission requires an approved Cauce systemd manager')
    files = removal_files(manager)
    pin = hashlib.sha256(json.dumps(manager, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if not isinstance(entry, dict) or entry.get('manager_sha256') != pin:
        raise SafeFailure('native decommission replay changed its approved manager')
    return manager, files


def verify_native_stopped(policy: dict, agent: dict, entry: dict, *, absent: bool = False) -> None:
    manager, files = approved_decommission(policy, agent, entry)
    properties = manager_properties(manager, files)
    if properties.get('ActiveState') != 'inactive':
        raise SafeFailure('decommissioned native unit is not stopped')
    for filename, pin in files.items():
        exists = pinned_file(filename, pin)
        if absent and exists:
            raise SafeFailure('decommissioned native unit file reappeared')
    dropin = verify_dropins(manager, files)
    if absent and dropin is not None and os.path.lexists(dropin):
        raise SafeFailure('decommissioned native drop-in directory reappeared')
    if absent and (entry.get('complete') is not True or properties.get('LoadState') != 'not-found'
            or properties.get('FragmentPath') or properties.get('DropInPaths')
            or properties.get('UnitFileState', '') not in {'', 'not-found'}):
        raise SafeFailure('native unit absence is not observed')
    if absent and any(os.path.lexists(filename) for filename in entry.get('disabled_links', [])):
        raise SafeFailure('decommissioned native enable link reappeared')
    identity = native_identity(policy, agent)
    checked_command([str(pathlib.Path(sys.executable).resolve()), '-B', str(HELPER), 'stopped',
                     *lifecycle_arguments(agent, identity)])


def decommission_native(policy: dict, agent: dict, journal: dict, save) -> dict | None:
    if agent.get('runtime_mode') != 'native' or agent['_placement'].get('manager') is None:
        return None
    identity = native_identity(policy, agent)
    entries = journal.setdefault('native_decommission', {})
    entry = entries.get(agent['runtime_key'])
    if entry is None:
        manager = manager_for(policy, agent, identity)
        files = removal_files(manager)
        for filename, pin in files.items():
            if not pinned_file(filename, pin):
                raise SafeFailure('native unit file disappeared before decommission')
        stop(policy, agent)
        entry = {'manager_sha256': hashlib.sha256(json.dumps(manager, sort_keys=True,
                 separators=(',', ':')).encode()).hexdigest()}
        entries[agent['runtime_key']] = entry
        save()
    manager, files = approved_decommission(policy, agent, entry)
    if entry.get('complete') is True:
        verify_native_stopped(policy, agent, entry, absent=True)
        return entry
    verify_native_stopped(policy, agent, entry)
    if any(pinned_file(filename, pin) for filename, pin in files.items()) or entry.get('disabled') is not True:
        disable_native(manager, files, entry, save)
        entry['disabled'] = True
        save()
    for filename, pin in files.items():
        pinned_file(filename, pin, remove=True)
    dropin = verify_dropins(manager, files)
    if dropin is not None:
        parent = open_absolute_directory(dropin.parent)
        try:
            try:
                os.rmdir(dropin.name, dir_fd=parent)
                os.fsync(parent)
            except FileNotFoundError:
                pass
            except OSError as error:
                raise SafeFailure('native unit drop-in directory contains unapproved files') from error
        finally:
            os.close(parent)
    systemctl('daemon-reload')
    entry['complete'] = True
    verify_native_stopped(policy, agent, entry, absent=True)
    entry['removed'] = [{'type': 'unit', 'name': manager['unit']},
                        *({'type': 'file', 'name': str(filename)} for filename in files),
                        *({'type': 'file', 'name': filename} for filename in entry.get('disabled_links', []))]
    if dropin is not None:
        entry['removed'].append({'type': 'directory', 'name': str(dropin)})
    save()
    return entry
