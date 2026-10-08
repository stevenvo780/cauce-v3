from __future__ import annotations

import argparse
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys

from fleet_executor_view import open_directory


def ensure_private(parent: int, name: str, uid: int, gid: int, *, initialize_empty: bool = False) -> int:
    created = False
    try:
        os.mkdir(name, mode=0o700, dir_fd=parent)
        created = True
    except FileExistsError:
        pass
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        details = os.fstat(directory)
        if created or initialize_empty and details.st_uid == 0 and not os.listdir(directory):
            if (uid, gid) != (os.geteuid(), os.getegid()):
                if os.geteuid() != 0:
                    raise ValueError('profile executor cannot use the exact runtime owner')
                os.fchown(directory, uid, gid)
            os.fchmod(directory, 0o700)
            details = os.fstat(directory)
        if details.st_uid != uid or details.st_gid != gid or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError('provider profile directory owner or privacy differs')
        return directory
    except BaseException:
        os.close(directory)
        raise


def prepare_empty_profile(root: str, profile: str, uid: int, gid: int, *, initialize_empty: bool = False):
    root_path, destination = pathlib.Path(root), pathlib.Path(profile)
    if any(not value.startswith('/') or str(pathlib.PurePosixPath(value)) != value or '..' in pathlib.PurePosixPath(value).parts
            or any(ord(char) < 32 for char in value) for value in (root, profile)) or uid <= 0 or gid <= 0 \
            or not destination.is_relative_to(root_path) or len(destination.relative_to(root_path).parts) != 2:
        raise ValueError('invalid separate provider profile destination')
    runtime, account = destination.relative_to(root_path).parts
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', runtime) is None or re.fullmatch(r'[0-9a-f]{64}', account) is None:
        raise ValueError('provider profile destination identity is not canonical')
    parent = open_directory(root_path.parent)
    try:
        current = ensure_private(parent, root_path.name, uid, gid, initialize_empty=initialize_empty)
    finally:
        os.close(parent)
    try:
        for component in destination.relative_to(root_path).parts:
            following = ensure_private(current, component, uid, gid)
            os.close(current)
            current = following
        os.fsync(current)
    finally:
        os.close(current)


def prepare_profile(policy: dict, raw_agent: dict):
    from fleet_executor_policy import approve_agent
    from fleet_executor_templates import resolve_profile
    agent = approve_agent(policy, raw_agent)
    account = agent.get('primary_account_id')
    if account is None:
        return
    binding = resolve_profile(policy, agent)
    dynamic = account not in policy['profiles']
    if not dynamic and 'openclaw' not in binding:
        return
    template = next((row for row in policy.get('profile_templates', []) if row['provider'] == binding['provider']
                    and row['runtime_user'] == agent['runtime_user'] and ('openclaw' in row) == ('openclaw' in binding)), None)
    if dynamic and template is None:
        raise ValueError('provider profile template is unavailable')
    if agent['runtime_mode'] == 'native':
        from fleet_runtime_materialization import external_directory
        if dynamic:
            external_directory(pathlib.Path(template['path_root']))
            user = pwd.getpwnam(agent['runtime_user'])
            prepare_empty_profile(template['path_root'], binding['path'], user.pw_uid, user.pw_gid)
        prepare_openclaw(binding, agent)
        return
    from fleet_executor_container import (
        DOCKER,
        EXECUTOR_DESTINATION,
        checked_command,
        docker,
        identity_for,
        inspect_container,
        user_identity,
        validate_container,
    )
    observed = inspect_container(agent['container_name'])
    validate_container(policy, agent, observed)
    identity = identity_for(agent, observed)
    uid, gid = user_identity(agent, identity)
    if dynamic:
        docker('exec', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'], agent['_placement']['python'],
            f'{EXECUTOR_DESTINATION}/fleet_executor_profiles.py', '--root', template['path_root'], '--profile', binding['path'],
            '--uid', uid, '--gid', gid, '--initialize-empty')
    if 'openclaw' in binding:
        checked_command([DOCKER, 'exec', '-i', '--user', agent['runtime_user'], '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'],
            agent['_placement']['python'], f'{EXECUTOR_DESTINATION}/fleet_provider_openclaw.py', '--prepare'],
            input_data=json.dumps({'profile_binding': binding, 'agent': {key: value for key, value in agent.items() if not key.startswith('_')}}).encode())


def prepare_openclaw(binding: dict, agent: dict):
    if 'openclaw' not in binding:
        return
    user = pwd.getpwnam(agent['runtime_user'])
    command = [str(pathlib.Path(sys.executable).resolve()), str(pathlib.Path(__file__).with_name('fleet_provider_openclaw.py')), '--prepare']
    if user.pw_uid != os.geteuid():
        if os.geteuid() != 0:
            raise ValueError('OpenClaw profile executor differs from the exact runtime owner')
        command = ['/usr/sbin/runuser', '-u', agent['runtime_user'], '--', *command]
    packet = {'profile_binding': binding, 'agent': {key: value for key, value in agent.items() if not key.startswith('_')}}
    result = subprocess.run(command, input=json.dumps(packet).encode(), capture_output=True, timeout=10,
                            env={'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'PYTHONDONTWRITEBYTECODE': '1'}, check=False)
    if result.returncode:
        raise ValueError('OpenClaw exact private configuration preparation failed')


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--root', required=True)
        parser.add_argument('--profile', required=True)
        parser.add_argument('--uid', type=int, required=True)
        parser.add_argument('--gid', type=int, required=True)
        parser.add_argument('--initialize-empty', action='store_true')
        args = parser.parse_args()
        prepare_empty_profile(args.root, args.profile, args.uid, args.gid, initialize_empty=args.initialize_empty)
    except Exception:
        raise SystemExit('provider profile preparation was not verified') from None
