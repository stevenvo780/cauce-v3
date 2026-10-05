from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path


def _persistent_mount(path: str, mounts: object) -> None:
    if not isinstance(mounts, list):
        raise ValueError('journal mounts are invalid')
    matches = []
    for mount in mounts:
        if not isinstance(mount, dict):
            raise ValueError('journal mount is invalid')
        destination = mount.get('Destination')
        if not isinstance(destination, str) or not destination.startswith('/'):
            raise ValueError('journal mount destination is invalid')
        if path == destination or path.startswith(destination.rstrip('/') + '/'):
            matches.append(mount)
    if not matches:
        raise ValueError('journal requires an existing persistent state mount')
    longest = max(len(item['Destination']) for item in matches)
    chosen = [item for item in matches if len(item['Destination']) == longest]
    if len(chosen) != 1 or chosen[0].get('Type') not in {'bind', 'volume'} or chosen[0].get('RW') is not True:
        raise ValueError('journal state mount must be persistent and writable')


def _directory(fd: int, uid: int, private: bool = False) -> os.stat_result:
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022
            or (private and stat.S_IMODE(info.st_mode) != 0o700)):
        raise ValueError('journal directory ownership or permissions are invalid')
    return info


def provision_journal(root: str, components: list[str], mounts: object | None = None) -> str:
    uid = os.geteuid()
    if (uid == 0 or not os.path.isabs(root) or os.path.normpath(root) != root
            or os.path.realpath(root) != root or root == '/' or not components
            or any(not re.fullmatch(r'[A-Za-z0-9._-]+', item) or item in {'.', '..'} for item in components)):
        raise ValueError('journal path or runtime identity is invalid')
    target = str(Path(root).joinpath(*components))
    if mounts is not None:
        _persistent_mount(target, mounts)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open(root, flags)
    created: list[tuple[int, str, int, int]] = []
    try:
        _directory(current, uid)
        for index, component in enumerate(components):
            try:
                following = os.open(component, flags, dir_fd=current)
            except FileNotFoundError:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current)
                except FileExistsError:
                    following = os.open(component, flags, dir_fd=current)
                else:
                    following = os.open(component, flags, dir_fd=current)
                    info = os.fstat(following)
                    created.append((os.dup(current), component, info.st_dev, info.st_ino))
            try:
                os.fsync(current)
                _directory(following, uid, private=index == len(components) - 1)
                os.fsync(following)
            except BaseException:
                os.close(following)
                raise
            os.close(current)
            current = following
        pinned = _directory(current, uid, private=True)
        named = os.stat(target, follow_symlinks=False)
        if os.path.realpath(target) != target or (named.st_dev, named.st_ino) != (pinned.st_dev, pinned.st_ino):
            raise ValueError('journal directory identity changed')
        return target
    except BaseException:
        for parent, name, device, inode in reversed(created):
            try:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == (device, inode):
                    os.rmdir(name, dir_fd=parent)
                    os.fsync(parent)
            except OSError:
                pass
        raise
    finally:
        os.close(current)
        for parent, _, _, _ in created:
            os.close(parent)


def provision_host_journal(home: str, alias: str, container_id: str) -> str:
    if not re.fullmatch(r'[a-z][a-z0-9.-]*', alias) or not container_id.startswith('host:'):
        raise ValueError('journal host scope is invalid')
    scope = 'host-' + hashlib.sha256(container_id.encode('utf-8')).hexdigest()
    return provision_journal(home, ['.local', 'state', 'cauce-v3', 'pty-governance-journal', alias, scope])


def main(arguments: list[str]) -> int:
    if len(arguments) != 3 or not re.fullmatch(r'[a-f0-9]{64}', arguments[1]):
        raise ValueError('journal container arguments are invalid')
    print(provision_journal(arguments[0], ['pty-governance-journal', arguments[1]], json.loads(arguments[2])))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError):
        print('PTY write journal provisioning failed', file=sys.stderr)
        raise SystemExit(78) from None
