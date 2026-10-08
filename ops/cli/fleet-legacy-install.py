#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import pwd
import sys

from fleet_adoption_probe_policy import ProbeFailure, absolute, digest_file, load_policy, open_directory


def argument(value: str) -> str:
    if any(ord(character) < 32 for character in value):
        raise ProbeFailure('invalid_unit_argument')
    return '"' + value.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"') + '"'


def render(row: dict, policy: str, python: str, lock_helper: str, probe: str, lock_root: str) -> tuple[str, str]:
    command = row['supervisor']['command']
    if digest_file(command) != row['supervisor']['command_sha256']:
        raise ProbeFailure('supervisor_command_changed')
    alias = row['runtime_key']
    mode = row['placement']['mode']
    start = [python, lock_helper, 'run', '--lock-root', lock_root, '--alias', alias, '--', command, 'start', alias]
    stop = [python, probe, 'control', '--policy', policy, '--runtime-key', alias, '--', command, 'stop', alias]
    lines = ['[Service]', 'UMask=0077', 'KillMode=process', 'TimeoutStopSec=infinity', 'SendSIGKILL=no',
        'Environment=' + argument('CAUCE_ADOPTION_PROBE_POLICY_FILE=' + policy),
        'Environment=CAUCE_ADOPTION_LIFECYCLE_FENCE=1']
    if mode == 'native':
        placement = row['placement']
        user = pwd.getpwnam(placement['runtime_user'])
        if user.pw_uid == 0 or placement.get('systemd_user') != user.pw_name:
            raise ProbeFailure('native_systemd_user_unapproved')
        lines.extend(['Environment=' + argument('HOME=' + placement['home_directory']),
            'Environment=' + argument('USER=' + user.pw_name),
            'Environment=' + argument('LOGNAME=' + user.pw_name)])
    lines.extend(['ExecStart=', 'ExecStart=' + ' '.join(argument(value) for value in start),
        'ExecStop=', 'ExecStop=' + ' '.join(argument(value) for value in stop), ''])
    unit = f'cauce-v3-{"alias" if mode == "native" else "container"}-{alias}.service'
    return unit, '\n'.join(lines)


def write_dropin(root: int, unit: str, body: str) -> None:
    name = unit + '.d'
    try:
        os.mkdir(name, 0o700, dir_fd=root)
    except FileExistsError:
        pass
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root)
    try:
        details = os.fstat(directory)
        if details.st_uid != os.geteuid() or details.st_mode & 0o077:
            raise ProbeFailure('dropin_directory_unsafe')
        fd = os.open('35-legacy-adoption.conf', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(body)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.fsync(directory)
    finally:
        os.close(directory)


def main() -> int:
    parser = argparse.ArgumentParser(description='Render reviewed opt-in supervisor drop-ins; installation and restart are explicit operator actions')
    parser.add_argument('--policy', required=True)
    parser.add_argument('--python', default='/usr/bin/python3')
    parser.add_argument('--lock-helper', required=True)
    parser.add_argument('--probe', required=True)
    parser.add_argument('--lock-root', required=True)
    parser.add_argument('--output-directory', required=True)
    arguments = parser.parse_args()
    try:
        policy = load_policy(arguments.policy)
        for name in ('python', 'lock_helper', 'probe', 'lock_root', 'output_directory'):
            absolute(getattr(arguments, name))
        root = open_directory(arguments.output_directory)
        try:
            details = os.fstat(root)
            if details.st_uid != os.geteuid() or details.st_mode & 0o077:
                raise ProbeFailure('output_directory_unsafe')
            documents = [render(row, arguments.policy, arguments.python, arguments.lock_helper, arguments.probe,
                                arguments.lock_root) for row in policy['targets']]
            for unit, body in documents:
                write_dropin(root, unit, body)
                print(json.dumps({'unit': unit, 'dropin_sha256': hashlib.sha256(body.encode()).hexdigest(),
                    'path': str(pathlib.Path(arguments.output_directory) / (unit + '.d') / '35-legacy-adoption.conf'),
                    'requires': ['install_reviewed_dropin', 'systemd_daemon_reload', 'restart_existing_runtime', 'live_measured_adoption_preview']}, separators=(',', ':')))
        finally:
            os.close(root)
        return 0
    except (ProbeFailure, OSError, ValueError, KeyError):
        print('legacy supervisor opt-in preparation failed', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
